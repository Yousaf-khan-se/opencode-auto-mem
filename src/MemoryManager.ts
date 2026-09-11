import * as fs from "node:fs";
import * as path from "node:path";

import { atomicWrite } from "./atomicWrite.js";
import { chunkMarkdown } from "./chunker.js";
import { ensureDir, getMemoryDir } from "./config.js";
import {
  buildHeadingIndex,
  extractSection,
  findDeepest,
  findSection,
  insertUnderHeading,
  parseTitleOrdinal,
  renderIndexText,
} from "./headings.js";
import { getCachedIndex } from "./indexCache.js";
import { gitCommit } from "./git.js";
import {
  extractTimestamps,
  findFirstTimestamp,
  parseContentByTimestamp,
  stripOrphanTimestamps,
} from "./timestampParser.js";
import type {
  ContextFile,
  FileEntry,
  GroupedFiles,
  HeadingNode,
  MemoryConfig,
  MonthGroup,
  SemanticSearchResult,
} from "./types.js";
import { checkLineLimit } from "./validation.js";
import { plog } from "./logger.js";
import { getProjectNameForFile, upsertFile } from "./vector-store.js";
import type { EmbeddingDtype, IndexingConfig } from "./keeperConfig.js";
import { setActiveDtype } from "./embeddingConfig.js";

interface FileList {
  root: string[];
  project: string[];
}

// Queue for serializing embedding operations to avoid Bun NAPI concurrency issues
class EmbeddingQueue {
  private queue: Array<{
    filePath: string;
    content: string;
  }> = [];
  private isProcessing = false;
  private isExiting = false;

  constructor() {
    // Clear queue on process exit to avoid NAPI cleanup crashes
    process.once("beforeExit", () => {
      this.isExiting = true;
      this.queue.length = 0; // Clear pending jobs
      plog("info", "[embedding] Process exiting, cleared embedding queue");
    });
  }

  // Fire-and-forget: add to queue without blocking caller
  add(filePath: string, content: string): void {
    if (this.isExiting) {
      plog("info", `[embedding] Skipping ${filePath}: process is exiting`);
      return;
    }

    this.queue.push({ filePath, content });
    // Fire-and-forget: don't await, just trigger processing
    this.processNext().catch((err) => {
      plog("error", `[embedding] Queue processing error: ${err}`);
    });
  }

  /**
   * Resolves once the queue is fully drained (all pending items processed).
   * Used by MemoryManager.ensureIndexed() so a search only runs AFTER the
   * index refresh has finished embedding changed chunks — otherwise the first
   * search on a fresh index would query an empty index and return nothing.
   */
  drain(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.queue.length === 0 && !this.isProcessing) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0 || this.isExiting) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();

    if (item) {
      try {
        const chunks = chunkMarkdown(item.content, item.filePath);
        await upsertFile(item.filePath, chunks);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_err) {
        // Gracefully catch errors - don't let them propagate and crash
        const errMsg = (_err as Error).message || String(_err);
        if (errMsg.includes("not initialized")) {
          // Vector store not initialized, silently ignore
        } else {
          plog("error",
            `[embedding] Failed to embed ${item.filePath}: ${errMsg}`
          );
        }
      }
    }

    this.isProcessing = false;

    // Continue processing remaining items
    if (this.queue.length > 0 && !this.isExiting) {
      // Use setImmediate to allow event loop to process other events
      setImmediate(() => {
        this.processNext().catch((err) => {
          plog("error", `[embedding] Queue processing error: ${err}`);
        });
      });
    }
  }
}

export class MemoryManager {
  private config: MemoryConfig;
  private projectDir: string;
  private embeddingQueue: EmbeddingQueue;
  /** Guards ensureIndexed() so the (expensive) queueing runs at most once. */
  private indexingStarted = false;
  /** Resolves once the first ensureIndexed() queueing pass has been kicked off. */
  private indexingPromise: Promise<void> | null = null;
  /** Phase 5: indexing-mode config (trigger, debounce, keyword fallback, topK). */
  private indexing: IndexingConfig;
  /** Phase 5: coalescing timer for debouncedWrite mode (single, reset per write). */
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Phase 5: external refresh callbacks (test hooks / future status surface). */
  private refreshListeners: Array<() => void> = [];

  constructor(config: MemoryConfig, indexing?: IndexingConfig) {
    this.config = config;
    this.projectDir =
      config.projectDir || path.join(config.memoryDir, "project");
    this.embeddingQueue = new EmbeddingQueue();
    this.indexing = indexing ?? {
      enabled: true,
      trigger: "search",
      writeDebounceMs: 300_000,
      dtype: "int8",
      topK: 20,
      keywordFallback: true,
      scope: "project",
    };
  }

  // ------------------------------------------------ Phase 5: indexing modes

  /** Hot-swappable indexing config (hot reload + tests). */
  configureIndexing(indexing: IndexingConfig): void {
    this.indexing = indexing;
    // Trigger-mode change invalidates any armed write timer.
    if (indexing.trigger !== "debouncedWrite" && this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  getIndexingConfig(): IndexingConfig {
    return this.indexing;
  }

  /**
   * Phase 5: route the embedding dtype from config to the pure embedding
   * state (embeddingConfig.js — NO transformers import). Validates strictly:
   * an invalid dtype is a programming/config error at the caller.
   */
  configureEmbedding(dtype: EmbeddingDtype): void {
    if (dtype !== "int8" && dtype !== "fp32") {
      throw new Error(`Invalid embedding dtype: ${JSON.stringify(dtype)}. Must be "int8" or "fp32".`);
    }
    setActiveDtype(dtype);
  }

  /** Register a callback fired after each debouncedWrite refresh (tests). */
  onIndexRefresh(cb: () => void): void {
    this.refreshListeners.push(cb);
  }

  /** Dirty scopes accumulated during a debouncedWrite window (project-scoped). */
  private dirtyRoot = false;
  private dirtyProjects = new Set<string>();

  /**
   * Write-path hook: in debouncedWrite mode, records WHICH scope got dirty
   * (root vs a specific project) and arms/resets the single coalescing timer.
   * NEVER arms at construction/boot — only actual writes reach here.
   * search/manual modes and indexing-disabled never arm. On fire, ONLY the
   * dirty scopes refresh — an unrelated project's index is never touched.
   */
  private scheduleIndexRefresh(filePath: string): void {
    if (!this.indexing.enabled || this.indexing.trigger !== "debouncedWrite") {
      return;
    }
    const project = getProjectNameForFile(filePath);
    if (project) {
      this.dirtyProjects.add(project);
    } else {
      this.dirtyRoot = true;
    }
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      // Consume the dirty set BEFORE embedding so writes landing during the
      // refresh mark fresh dirtiness for the next window.
      const projects = [...this.dirtyProjects];
      const includeRoot = this.dirtyRoot;
      this.dirtyProjects.clear();
      this.dirtyRoot = false;
      plog("info",
        `[embedding] debouncedWrite window elapsed — scoped refresh (root=${includeRoot}, projects=${projects.join(", ") || "none"})`
      );
      this.refreshScope(includeRoot, projects);
      for (const cb of this.refreshListeners) {
        try {
          cb();
        } catch {
          // listener errors must never break the refresh chain
        }
      }
    }, this.indexing.writeDebounceMs);
  }

  /** Queue root (optional) + the given projects' files for incremental upsert. */
  private refreshScope(includeRoot: boolean, projects: string[]): void {
    if (includeRoot) {
      const { root } = this.listFiles();
      this.collectAndQueue(root, this.config.memoryDir);
    }
    for (const folder of projects) {
      const folderPath = path.join(this.projectDir, folder);
      this.collectAndQueue(this.readDirFiles(folderPath), folderPath);
    }
  }

  /**
   * Offline keyword search: case-insensitive term-overlap scoring over all
   * memory files (no ONNX, no vector index). Used when indexing is disabled
   * (keywordFallback) — weaker than semantic search but zero model cost.
   */
  async keywordSearch(
    query: string,
    maxResults: number,
    projectName?: string | null
  ): Promise<SemanticSearchResult[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    const { root, project: projectFolders } = this.listFiles();
    const files: Array<{ filePath: string; content: string }> = [];
    for (const file of root) {
      const p = path.join(this.config.memoryDir, file);
      const content = this.readFile(p);
      if (content) files.push({ filePath: p, content });
    }
    // Scope: "all" = every project (legacy), a name = that project only,
    // null/undefined = global root files only. Mirrors vector-store routing.
    const folders =
      projectName === "all"
        ? projectFolders
        : projectName
          ? projectFolders.filter((f) => f === projectName)
          : [];
    for (const folder of folders) {
      const folderPath = path.join(this.projectDir, folder);
      for (const file of this.readDirFiles(folderPath)) {
        const p = path.join(folderPath, file);
        const content = this.readFile(p);
        if (content) files.push({ filePath: p, content });
      }
    }

    const results: SemanticSearchResult[] = [];
    for (const { filePath, content } of files) {
      const chunks = chunkMarkdown(content, filePath);
      for (const chunk of chunks) {
        const textLower = chunk.text.toLowerCase();
        let score = 0;
        for (const term of terms) {
          const occurrences = textLower.split(term).length - 1;
          if (occurrences > 0) score += 1 + Math.min(occurrences - 1, 4) * 0.1;
        }
        if (score > 0) {
          results.push({
            score,
            filePath,
            heading: chunk.heading,
            text: chunk.text,
            timestamp: this.timestampForChunk(chunk.text),
          });
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  ensureDirectories(): void {
    ensureDir(this.config.memoryDir);
    ensureDir(this.projectDir);
  }

  ensureProjectFolder(projectName: string): void {
    const folder = this.getProjectFolder(projectName);
    ensureDir(folder);
  }

  getCurrentProjectName(): string | null {
    return this.config.currentProjectName || null;
  }

  getProjectFolder(projectName: string): string {
    return path.join(this.projectDir, projectName);
  }

  getProjectPath(projectName: string): string {
    return path.join(this.getProjectFolder(projectName), "project.md");
  }

  getCorrectionsPath(projectName: string): string {
    return path.join(this.getProjectFolder(projectName), "corrections.md");
  }

  getEnvironmentPath(projectName: string): string {
    return path.join(this.getProjectFolder(projectName), "environment.md");
  }

  getMemoryPath(): string {
    return path.join(this.config.memoryDir, "MEMORY.md");
  }

  getIdentityPath(): string {
    return path.join(this.config.memoryDir, "IDENTITY.md");
  }

  getUserPath(): string {
    return path.join(this.config.memoryDir, "USER.md");
  }

  getBootstrapPath(): string {
    return path.join(this.config.memoryDir, "BOOTSTRAP.md");
  }

  getPathForTarget(
    target: string,
    projectName?: string
  ): { filePath: string; displayName: string } {
    switch (target) {
      case "memory":
        return { filePath: this.getMemoryPath(), displayName: "MEMORY.md" };
      case "identity":
        return { filePath: this.getIdentityPath(), displayName: "IDENTITY.md" };
      case "user":
        return { filePath: this.getUserPath(), displayName: "USER.md" };
      case "project":
      case "corrections":
      case "environment": {
        const targetProject = projectName ?? this.getCurrentProjectName();
        if (!targetProject) {
          throw new Error(
            "Project name not available. Set current working directory or provide project name."
          );
        }
        switch (target) {
          case "corrections":
            return {
              filePath: this.getCorrectionsPath(targetProject),
              displayName: `project/${targetProject}/corrections.md`,
            };
          case "environment":
            return {
              filePath: this.getEnvironmentPath(targetProject),
              displayName: `project/${targetProject}/environment.md`,
            };
          default:
            return {
              filePath: this.getProjectPath(targetProject),
              displayName: `project/${targetProject}/project.md`,
            };
        }
      }
      default:
        throw new Error(`Unknown target: ${target}`);
    }
  }

  getCachePathForTarget(target: string, projectName?: string): string {
    if (["project", "corrections", "environment"].includes(target)) {
      const p = projectName ?? this.getCurrentProjectName();
      if (!p) {
        throw new Error(
          "Project name not available. Set current working directory or provide project name."
        );
      }
      return path.join(this.getProjectFolder(p), "index-cache.json");
    }
    return path.join(this.config.memoryDir, "index-cache.json");
  }

  hasProjectFolder(projectName: string): boolean {
    return fs.existsSync(this.getProjectFolder(projectName));
  }

  getIndexForTarget(target: string, projectName?: string): HeadingNode[] {
    const { filePath } = this.getPathForTarget(target, projectName);
    const cachePath = this.getCachePathForTarget(target, projectName);
    return getCachedIndex(filePath, cachePath, () =>
      buildHeadingIndex(this.readFile(filePath) ?? "")
    );
  }

  renderTargetIndex(target: string, projectName?: string): string {
    const { filePath, displayName } = this.getPathForTarget(target, projectName);
    if (this.readFile(filePath) === null) {
      return `${displayName} not found.`;
    }
    return renderIndexText(displayName, this.getIndexForTarget(target, projectName));
  }

  /** Rendered heading indexes for the three project files, or null if the project folder doesn't exist yet. */
  renderProjectIndexSection(projectName: string): string | null {
    if (!this.hasProjectFolder(projectName)) return null;
    const parts: string[] = [];
    for (const target of ["project", "corrections", "environment"]) {
      const { filePath, displayName } = this.getPathForTarget(target, projectName);
      if (this.readFile(filePath) === null) continue;
      parts.push(
        renderIndexText(displayName, this.getIndexForTarget(target, projectName))
      );
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  readSection(
    target: string,
    headingPath: string[],
    projectName?: string
  ): { displayName: string; sectionTitle: string; section: string } {
    const { filePath, displayName } = this.getPathForTarget(target, projectName);
    const content = this.readFile(filePath);
    if (content === null) throw new Error(`${displayName} not found or empty`);
    const lookup = findSection(
      this.getIndexForTarget(target, projectName),
      headingPath
    );
    if ("error" in lookup) throw new Error(lookup.error);
    return {
      displayName,
      sectionTitle: lookup.node.title,
      section: extractSection(lookup.node, content),
    };
  }

  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  writeFile(filePath: string, content: string): void {
    checkLineLimit(filePath, content);
    atomicWrite(filePath, content);
    // NOTE: no embedding here — the index refreshes lazily at search time
    // (ensureIndexed). Continuous write-embedding caused runaway memory.
    gitCommit(`Update ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);
  }

  editFile(filePath: string, oldString: string, newString: string): void {
    const content = this.readFile(filePath);
    if (!content) {
      throw new Error("File not found or empty");
    }

    if (!content.includes(oldString)) {
      throw new Error("oldString not found in file");
    }

    const matches = content.split(oldString).length - 1;
    if (matches > 1) {
      throw new Error(
        `Found ${matches} occurrences of oldString, expected exactly 1`
      );
    }

    const updatedContent = content.replace(oldString, newString);
    atomicWrite(filePath, updatedContent);
    // Index refreshes lazily at search time (see writeFile note).
    gitCommit(`Edit ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);
  }

  private replaceInSection(
    node: HeadingNode,
    content: string,
    oldString: string,
    newString: string
  ): string {
    const lines = content.split("\n");
    const sectionText = lines
      .slice(node.startLine - 1, node.endLine)
      .join("\n");
    const occurrences = sectionText.split(oldString).length - 1;
    if (occurrences === 0) {
      throw new Error(
        `oldString not found within section "${node.title}" (including subsections). Read the section first to get the exact text.`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of oldString within section "${node.title}", expected exactly 1. Include more surrounding text to make it unique.`
      );
    }
    const newSectionText = newString
      ? sectionText.replace(oldString, newString)
      : stripOrphanTimestamps(
          sectionText.replace(oldString, "").replace(/\n{3,}/g, "\n\n")
        );
    return [
      ...lines.slice(0, node.startLine - 1),
      ...newSectionText.split("\n"),
      ...lines.slice(node.endLine),
    ].join("\n");
  }

  editInSection(
    target: string,
    headingPath: string[],
    oldString: string,
    newString: string,
    projectName?: string
  ): { displayName: string; sectionTitle: string } {
    const { filePath, displayName } = this.getPathForTarget(target, projectName);
    const content = this.readFile(filePath);
    if (content === null) throw new Error(`${displayName} not found or empty`);
    const lookup = findSection(
      this.getIndexForTarget(target, projectName),
      headingPath
    );
    if ("error" in lookup) throw new Error(lookup.error);

    const newContent = this.replaceInSection(
      lookup.node,
      content,
      oldString,
      newString
    );
    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    gitCommit(`Edit ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);
    return { displayName, sectionTitle: lookup.node.title };
  }

  deleteInSection(
    target: string,
    headingPath: string[],
    oldString: string,
    projectName?: string
  ): { displayName: string; sectionTitle: string } {
    const { filePath, displayName } = this.getPathForTarget(target, projectName);
    const content = this.readFile(filePath);
    if (content === null) throw new Error(`${displayName} not found or empty`);
    const lookup = findSection(
      this.getIndexForTarget(target, projectName),
      headingPath
    );
    if ("error" in lookup) throw new Error(lookup.error);

    const newContent = this.replaceInSection(
      lookup.node,
      content,
      oldString,
      ""
    );
    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    gitCommit(`Delete from ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);
    return { displayName, sectionTitle: lookup.node.title };
  }

  async deleteByTimestamp(
    target: string,
    timestamp: string,
    projectName?: string
  ): Promise<string> {
    const { filePath, displayName } = this.getPathForTarget(
      target,
      projectName
    );
    const content = this.readFile(filePath);

    if (!content) {
      throw new Error(`${displayName} not found or empty`);
    }

    const entries = parseContentByTimestamp(content);
    const filteredEntries = entries.filter(
      (entry) => entry.timestamp !== timestamp
    );

    if (filteredEntries.length === entries.length) {
      throw new Error(`No entries found matching timestamp: ${timestamp}`);
    }

    // Everything before the first timestamp (H1, intro, non-timestamped
    // sections) must survive a timestamp delete — rebuild it explicitly.
    const firstTs = findFirstTimestamp(content);
    const preamble = firstTs
      ? content.slice(0, firstTs.index).trimEnd()
      : "";
    const body = filteredEntries
      .map((e) => `<!-- ${e.timestamp} -->\n${e.content}`)
      .join("\n\n");
    const newContent = preamble
      ? (body ? `${preamble}\n\n${body}` : `${preamble}\n`)
      : body;

    atomicWrite(filePath, newContent);
    // Index refreshes lazily at search time (see writeFile note).
    gitCommit(`Delete entries from ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);

    return `Deleted ${entries.length - filteredEntries.length} entries from ${displayName}`;
  }

  writeUnderHeading(
    target: string,
    headingPath: string[],
    content: string,
    createMissing: boolean,
    projectName?: string
  ): { displayName: string; sectionTitle: string; indexText: string } {
    const { filePath, displayName } = this.getPathForTarget(target, projectName);
    const fileContent = this.readFile(filePath) ?? "";
    const roots = buildHeadingIndex(fileContent);
    const lookup = findSection(roots, headingPath);

    let newContent: string;
    let sectionTitle: string;

    if ("node" in lookup) {
      const stamped = `<!-- ${this.getLocalTimestamp()} -->\n${content}`;
      newContent = insertUnderHeading(fileContent, lookup.node, stamped);
      sectionTitle = lookup.node.title;
    } else {
      const deepest = findDeepest(roots, headingPath);
      if (deepest.ambiguous) throw new Error(deepest.ambiguous);
      if (!createMissing) {
        throw new Error(
          `${lookup.error}\nSet createMissing: true to create the missing heading(s).`
        );
      }
      const lines = fileContent.split("\n");
      const missing = headingPath.slice(deepest.consumed);
      let level = deepest.node ? deepest.node.level : 0;
      const block: string[] = [];
      for (const raw of missing) {
        const { title } = parseTitleOrdinal(raw);
        level = Math.min(level + 1, 6);
        block.push("", `${"#".repeat(level)} ${title}`);
      }
      const stamped = `<!-- ${this.getLocalTimestamp()} -->\n${content}`;
      block.push("", ...stamped.split("\n"));
      const insertIdx = deepest.node ? deepest.node.endLine : lines.length;
      lines.splice(insertIdx, 0, ...block);
      newContent = lines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
      sectionTitle =
        missing.length > 0
          ? parseTitleOrdinal(missing[missing.length - 1]).title
          : deepest.node?.title ?? displayName;
    }

    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    this.scheduleIndexRefresh(filePath);
    gitCommit(`Update ${path.basename(filePath)}`);

    const indexText = renderIndexText(
      displayName,
      buildHeadingIndex(newContent)
    );
    return { displayName, sectionTitle, indexText };
  }

  appendFile(filePath: string, content: string): void {
    const existing = this.readFile(filePath);
    const separator = existing?.trim() ? "\n\n" : "";
    const timestamp = this.getLocalTimestamp();
    const stamped = `<!-- ${timestamp} -->\n${content}`;
    const newContent = (existing ?? "") + separator + stamped;

    checkLineLimit(filePath, newContent);
    atomicWrite(filePath, newContent);
    // Index refreshes lazily at search time (see writeFile note).
    gitCommit(`Append to ${path.basename(filePath)}`);
    this.scheduleIndexRefresh(filePath);
  }

  getLocalTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  // Fire-and-forget: add to background embedding queue without blocking
  private embedAndIndex(filePath: string, content: string): void {
    this.embeddingQueue.add(filePath, content);
  }

  fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  isInitialized(): boolean {
    return this.fileExists(this.getMemoryPath());
  }

  needsBootstrap(): boolean {
    return this.fileExists(this.getBootstrapPath());
  }

  getContextFiles(): ContextFile[] {
    const files: ContextFile[] = [];
    const paths = [
      { path: this.getMemoryPath(), name: "MEMORY.md" },
      { path: this.getIdentityPath(), name: "IDENTITY.md" },
      { path: this.getUserPath(), name: "USER.md" },
    ];

    for (const { path: filePath, name } of paths) {
      const content = this.readFile(filePath);
      if (content?.trim()) {
        files.push({ name, content: content.trim() });
      }
    }
    return files;
  }

  /**
   * The chunk's own first timestamp comment — the honest per-result stamp.
   * Reuses findFirstTimestamp rather than re-implementing the regex.
   */
  timestampForChunk(text: string): string | undefined {
    const match = findFirstTimestamp(text);
    return match ? match[1] : undefined;
  }

  async semanticSearch(
    query: string,
    maxResults?: number,
    projectName?: string | null
  ): Promise<SemanticSearchResult[]> {
    // Phase 5: config topK is the default AND the hard cap for result count.
    const effectiveMax = Math.min(
      maxResults ?? this.indexing.topK,
      this.indexing.topK
    );

    // Indexing disabled → keyword fallback (zero model cost) or an explicit
    // disabled notice. The ONNX model is NEVER touched on this path.
    if (!this.indexing.enabled) {
      if (this.indexing.keywordFallback) {
        return this.keywordSearch(
          query,
          effectiveMax,
          this.indexing.scope === "all" ? "all" : (projectName ?? null)
        );
      }
      return [
        {
          score: 0,
          filePath: "",
          heading: "indexing disabled",
          text: "Semantic search is disabled: indexing.enabled=false and indexing.keywordFallback=false in keeper-config.json. While indexing is disabled the embedding model never loads (search AND reindex both skip it). Enable indexing in keeper-config.json, then run reindex — or set indexing.keywordFallback=true to search by keyword.",
          timestamp: undefined,
        },
      ];
    }

    // P1 + project scoping: lazily index ONLY the scope being searched —
    // global root always, plus the target project ("project" scope) or every
    // project ("all" scope). Unrelated projects' indexes are never touched.
    const scopeProject =
      this.indexing.scope === "all" ? "all" : (projectName ?? null);
    await this.ensureIndexed(scopeProject);
    // Dynamic import: embedding.ts pulls @huggingface/transformers (which
    // eagerly requires the native onnxruntime-node lib) into the process.
    // Only import it when a search actually needs to embed — never at boot.
    const { embedText } = await import("./embedding.js");
    const queryVector = await embedText(query);
    const results = await import("./vector-store.js").then((m) =>
      m.semanticSearch(queryVector, effectiveMax, projectName ?? null, this.indexing.scope)
    );

    // Chunk-level timestamps: each result carries its own first ts comment
    // (or undefined — renders as [no timestamp]). The old per-result file
    // re-read stamped every result with the FILE's first ts, which was
    // misleading for all but the file's oldest chunk.
    return results.map((result) => ({
      ...result,
      timestamp: this.timestampForChunk(result.text),
    }));
  }

  private readDirFiles(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
  }

  private readDirFolders(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => {
        const fullPath = path.join(dir, f);
        return fs.statSync(fullPath).isDirectory();
      });
    } catch {
      return [];
    }
  }

  listFiles(): FileList {
    const projectFolders = this.readDirFolders(this.projectDir);
    return {
      root: this.readDirFiles(this.config.memoryDir).filter(
        (f) => f !== "BOOTSTRAP.md"
      ),
      project: projectFolders,
    };
  }

  getProjectFiles(projectName: string): string[] {
    const folder = this.getProjectFolder(projectName);
    return this.readDirFiles(folder);
  }

  /**
   * Ensure the vector indexes reflect the current memory files. Called from
   * semanticSearch() BEFORE querying — this is the ONLY automatic embedding
   * trigger in the plugin (plus the explicit reindex tool).
   *
   * WHY NOT embed on every write (the old behavior): with the memory-keeper
   * enabled, project memory files are written after EVERY conversation turn,
   * which made the ONNX model + ORT native heap churn continuously (memory
   * climbing 1-5GB within minutes under Bun). Writes now only touch .md files;
   * the index catches up HERE, right before a search. embedAllExistingFiles()
   * is incremental: upsertFile dedupes by chunk hash, so unchanged files cost
   * only a re-read + hash, and only new/changed chunks are embedded.
   *
   * This MUST NOT be called at server startup — the embedding step loads the
   * ONNX model + ORT session and runs first-time graph optimization, which
   * blocks the bun event loop and prevents the TUI from loading.
   */
  async ensureIndexed(
    projectName: string | null | "all" = null
  ): Promise<void> {
    // Phase 5 gates: indexing disabled or manual trigger → the search-time
    // refresh never runs. Reindex is ALSO gated (2.4.5): handleReindex
    // early-returns, and embedAllExistingFiles() carries its own enabled
    // guard — the model never loads while indexing is off.
    if (!this.indexing.enabled) return;
    if (this.indexing.trigger === "manual") {
      plog("info",
        "[embedding] indexing.trigger=manual — skipping search-time refresh (use the reindex action)"
      );
      return;
    }
    if (this.indexingPromise) {
      return this.indexingPromise;
    }
    // Capture the scope so the queued pass covers exactly what the caller
    // will search: global root always, plus the project / all projects.
    const scope = projectName;
    // Cache the promise only WHILE the refresh is in flight; .finally clears
    // it so every subsequent search re-scans (catching files written since).
    this.indexingPromise = (async () => {
      this.indexingStarted = true;
      plog("info",
        `[embedding] Search triggered index refresh (scope=${scope ?? "root-only"}, incremental — only changed chunks embed)`
      );
      this.embedAllExistingFiles(scope);
      await this.embeddingQueue.drain();
    })().finally(() => {
      this.indexingPromise = null;
    });
    return this.indexingPromise;
  }

  /**
   * Reset the in-flight indexing guard. Used by the explicit reindex action,
   * which clears the on-disk indexes and re-queues everything itself.
   */
  resetIndexing(): void {
    this.indexingStarted = false;
    this.indexingPromise = null;
  }

  private collectAndQueue(files: string[], dir: string): void {
    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = this.readFile(filePath);
      if (content) {
        this.embedAndIndex(filePath, content);
      }
    }
  }

  /**
   * Queue files for background embedding, SCOPED: root files always; project
   * files only from the given scope ("all" = every project folder, a name =
   * that project only, null = none). Called by ensureIndexed (search-time,
   * matching the search scope) and the reindex action (explicit scope).
   */
  embedAllExistingFiles(projectName: string | null | "all" = null): void {
    // HARD GATE (2.4.5): indexing disabled → the embedding model must NEVER
    // load — not for search, not for an explicit reindex. No queueing, no
    // ONNX, no ORT. Non-destructive: nothing on disk is touched either.
    if (!this.indexing.enabled) {
      plog("info",
        "[embedding] embedAllExistingFiles skipped: indexing.enabled=false — the embedding model never loads while indexing is disabled"
      );
      return;
    }
    // Get all files that exist
    const { root, project: projectFolders } = this.listFiles();

    // Collect root files (always in scope — global memory)
    this.collectAndQueue(root, this.config.memoryDir);

    // Collect project files from the scoped folders only
    const folders =
      projectName === "all"
        ? projectFolders
        : projectName
          ? projectFolders.filter((f) => f === projectName)
          : [];
    for (const folder of folders) {
      const folderPath = path.join(this.projectDir, folder);
      this.collectAndQueue(this.readDirFiles(folderPath), folderPath);
    }

    plog("info",
      `[embedding] Queued files for background indexing (scope=${projectName ?? "root-only"}, projects=${folders.length})`
    );
  }

  private createFileEntry(
    fileName: string,
    filePath: string,
    prefix: string = ""
  ): FileEntry {
    const content = this.readFile(filePath);
    const timestamps = content ? extractTimestamps(content) : [];
    return { name: prefix ? `${prefix}/${fileName}` : fileName, timestamps };
  }

  listFilesGroupedByMonth(): GroupedFiles {
    const { root, project: projectFolders } = this.listFiles();

    // Create root file entries
    const rootFiles = root.map((file) =>
      this.createFileEntry(file, path.join(this.config.memoryDir, file))
    );

    // Create project file entries (one entry per project folder). Timestamps
    // aggregate across ALL .md files in the folder (deduped, descending) —
    // reading only the first file hid every other file's entries.
    const projectFiles = projectFolders.map((folder) => {
      const folderPath = path.join(this.projectDir, folder);
      const allTimestamps = new Set<string>();
      for (const file of this.readDirFiles(folderPath)) {
        const content = this.readFile(path.join(folderPath, file));
        if (content) {
          for (const ts of extractTimestamps(content)) allTimestamps.add(ts);
        }
      }
      return {
        name: `project/${folder}`,
        timestamps: [...allTimestamps].sort().reverse(),
      } satisfies FileEntry;
    });

    return { root: rootFiles, project: projectFiles, monthly: [] };
  }
}
