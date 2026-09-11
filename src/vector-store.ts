import path from "path";
import * as fs from "node:fs";
import { LocalIndex } from "vectra";

import { getMemoryDir } from "./config.js";
import { plog } from "./logger.js";

/**
 * Per-scope vector indexes (project-scoped indexing & search, 2.4.0):
 * - root:    <memoryDir>/indexes/root/            — global memory files
 * - project: <memoryDir>/indexes/projects/<name>/ — ONE index per project
 *
 * A project's index is only opened/queried/refreshed when that project is
 * actually being worked in (or explicitly searched) — other projects are
 * never touched. Legacy pre-2.4 layout (<memoryDir>/root.index,
 * <memoryDir>/project.index) is ignored; removeLegacyIndexes() deletes it
 * on explicit reindex.
 */

interface IndexConfig {
  name: string;
  path: string;
  instance: LocalIndex | null;
}

/** In-memory instances + init promises, keyed by INDEX PATH (not name — a
 * project could legally be named "root"; paths cannot collide). */
const instances = new Map<string, IndexConfig>();
const initPromises = new Map<string, Promise<LocalIndex>>();

export function rootIndexPath(): string {
  return path.join(getMemoryDir(), "indexes", "root");
}

export function projectIndexPath(projectName: string): string {
  return path.join(getMemoryDir(), "indexes", "projects", projectName);
}

function listProjectIndexDirs(): string[] {
  const projectsDir = path.join(getMemoryDir(), "indexes", "projects");
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name));
  } catch {
    return [];
  }
}

async function getIndex(name: string, indexPath: string): Promise<LocalIndex> {
  // Return existing instance
  const cached = instances.get(indexPath);
  if (cached?.instance) {
    return cached.instance;
  }

  // Check if initialization is already in progress
  const pending = initPromises.get(indexPath);
  if (pending) {
    return pending;
  }

  // Create new initialization promise (serial per index — Bun NAPI safety)
  const initPromise = (async () => {
    try {
      const instance = new LocalIndex(indexPath);
      if (!(await instance.isIndexCreated())) {
        await instance.createIndex();
      }
      instances.set(indexPath, { name, path: indexPath, instance });
      return instance;
    } catch (error) {
      // Clear on error so next call can retry
      initPromises.delete(indexPath);
      throw error;
    }
  })();

  initPromises.set(indexPath, initPromise);
  return initPromise;
}

/**
 * Whether a file path belongs to the project memory tree. Segment-relative to
 * the memory dir (NOT a "/project/" substring probe, which missed every
 * Windows backslash path and false-positived on project-named ancestors).
 */
export function isProjectFilePath(filePath: string): boolean {
  return path.relative(getMemoryDir(), filePath).split(path.sep)[0] === "project";
}

/**
 * The project a memory file belongs to (its folder under project/), or null
 * for root/global files. Deterministic — a file's index follows from its
 * path, so cross-PROJECT mis-filing cannot occur by construction.
 */
export function getProjectNameForFile(filePath: string): string | null {
  if (!isProjectFilePath(filePath)) return null;
  const segments = path.relative(getMemoryDir(), filePath).split(path.sep);
  return segments[1] || null;
}

/**
 * Delete every item of the index at the given path whose metadata.filePath
 * matches — used to self-heal chunks mis-filed by older routing bugs.
 */
export async function purgeFileFromIndex(
  indexPath: string,
  filePath: string
): Promise<void> {
  const index = await getIndex(path.basename(indexPath), indexPath);
  const items = await index.listItems();
  for (const item of items) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      await index.deleteItem(String(item.id));
    }
  }
}

export interface EmbeddedChunk {
  text: string;
  heading: string;
  hash: string;
}

export async function upsertFile(
  filePath: string,
  chunks: EmbeddedChunk[]
): Promise<void> {
  const project = getProjectNameForFile(filePath);
  const indexPath = project ? projectIndexPath(project) : rootIndexPath();

  // Self-heal: a PROJECT file's chunks must never live in the root index
  // (legacy pre-2.4 mis-filing). The existsSync guard keeps us from ever
  // creating the root index just to purge. Cross-PROJECT mis-filing is
  // impossible by construction — a file's index follows from its path.
  if (project && fs.existsSync(rootIndexPath())) {
    await purgeFileFromIndex(rootIndexPath(), filePath);
  }

  const index = await getIndex(project ?? "root", indexPath);

  const existing = await index.listItems();
  const existingByHash = new Map<string, string>();

  for (const item of existing) {
    if (item.metadata && String(item.metadata.filePath) === filePath) {
      existingByHash.set(String(item.metadata.chunkHash), String(item.id));
    }
  }

  const newHashes = new Set(chunks.map((c) => c.hash));

  // Remove outdated chunks
  for (const [hash, id] of existingByHash) {
    if (!newHashes.has(hash)) {
      await index.deleteItem(id);
    }
  }

  // Import embedText here to avoid circular dependency
  const { embedText } = await import("./embedding.js");

  // Insert or update chunks
  for (const chunk of chunks) {
    if (existingByHash.has(chunk.hash)) {
      continue;
    }

    const embedding = await embedText(chunk.text);
    await index.insertItem({
      vector: embedding,
      metadata: {
        filePath,
        heading: chunk.heading,
        text: chunk.text,
        chunkHash: chunk.hash,
      },
    });
  }
}

export interface SearchResult {
  score: number;
  filePath: string;
  heading: string;
  text: string;
}

function mapSearchResult(item: {
  score: number;
  item: { metadata: Record<string, unknown> };
}): SearchResult {
  return {
    score: item.score,
    filePath: String(item.item.metadata.filePath),
    heading: String(item.item.metadata.heading),
    text: String(item.item.metadata.text),
  };
}

/**
 * Scoped vector query: the ROOT index always participates; project indexes
 * participate per `scope`:
 * - "project": only `projectName`'s index (null → root files only).
 * - "all":     every existing project index on disk (legacy behavior).
 * Sequential init + queries — safer for Bun NAPI (preserved invariant).
 */
export async function semanticSearch(
  queryVector: number[],
  topK: number = 20,
  projectName: string | null = null,
  scope: "project" | "all" = "project"
): Promise<SearchResult[]> {
  const rootIdx = await getIndex("root", rootIndexPath());
  const rootResults = await rootIdx.queryItems(queryVector, "", topK);
  const mapped: SearchResult[] = [...rootResults.map(mapSearchResult)];

  if (scope === "all") {
    for (const dir of listProjectIndexDirs()) {
      const idx = await getIndex(path.basename(dir), dir);
      const hits = await idx.queryItems(queryVector, "", topK);
      mapped.push(...hits.map(mapSearchResult));
    }
  } else if (projectName) {
    const idx = await getIndex(projectName, projectIndexPath(projectName));
    const hits = await idx.queryItems(queryVector, "", topK);
    mapped.push(...hits.map(mapSearchResult));
  }

  mapped.sort((a, b) => b.score - a.score);
  return mapped.slice(0, topK);
}

export async function checkIndexExists(indexPath: string): Promise<boolean> {
  const index = await getIndex(path.basename(indexPath), indexPath);
  const items = await index.listItems();
  return items.length > 0;
}

// Cleanup function - called when explicitly needed (e.g., reindex tool, tests)
export async function closeIndexes(): Promise<void> {
  for (const config of instances.values()) {
    config.instance = null;
  }
  instances.clear();
  initPromises.clear();
  // Small delay to let any pending operations complete
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function rmrf(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    plog("error",
      `[embedding] Failed to remove index dir ${dirPath}: ${(err as Error).message}`
    );
  }
}

/** Delete the legacy pre-2.4 index dirs (ignored since the per-project layout). */
export function removeLegacyIndexes(): void {
  rmrf(path.join(getMemoryDir(), "root.index"));
  rmrf(path.join(getMemoryDir(), "project.index"));
}

/**
 * Scoped clear for the reindex action: root + the given project only. Other
 * projects' indexes are untouched — they self-heal lazily on their own next
 * search. Legacy dirs are removed here (one-time migration cleanup).
 */
export async function clearIndexScope(projectName: string | null): Promise<void> {
  await closeIndexes();
  rmrf(rootIndexPath());
  if (projectName) {
    rmrf(projectIndexPath(projectName));
  }
  removeLegacyIndexes();
}

/** Remove index dirs whose project folder no longer exists. Returns count. */
export function gcProjectIndexes(existingProjects: string[]): number {
  const valid = new Set(existingProjects);
  let removed = 0;
  for (const dir of listProjectIndexDirs()) {
    if (!valid.has(path.basename(dir))) {
      rmrf(dir);
      removed++;
    }
  }
  return removed;
}
