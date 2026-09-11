import { tool } from "@opencode-ai/plugin/tool";

import { BootstrapManager } from "./BootstrapManager.js";
import { MemoryManager } from "./MemoryManager.js";
import { isHomeDirectory, getProjectNameFromDirectory, loadConfig } from "./config.js";
import { KeeperManager } from "./keeper.js";
import { loadKeeperConfig, configureEmbedding } from "./keeperConfig.js";
import { initPluginLogger, plog } from "./logger.js";
import {
  BOOTSTRAP_INSTRUCTIONS,
  MEMORY_AWARENESS_INSTRUCTIONS,
  MEMORY_AWARENESS_INSTRUCTIONS_NO_KEEPER,
  buildCompactionContext,
} from "./memoryInstructions.js";
import type { SessionState } from "./types.js";
import {
  validateAction,
  validateContent,
  validateHeadingPath,
  validateTarget,
  validateTimestamp,
} from "./validation.js";

const sessionStates = new Map<string, SessionState>();

const memoryPlugin = async (input: {
  directory: string;
  client?: unknown;
}) => {
  // Arm the dual-sink logger FIRST so every later init log (config load,
  // keeper config, embedding queue) reaches the server log too.
  initPluginLogger(input.client);

  const config = loadConfig();
  const keeperConfig = loadKeeperConfig();
  const memoryManager = new MemoryManager(config, keeperConfig.indexing);
  const bootstrapManager = new BootstrapManager(memoryManager);

  bootstrapManager.initialize();

  memoryManager.ensureDirectories();

  // Memory-keeper: background agent that owns project-memory writes.
  // client is optional-typed here; KeeperManager guards its usage.
  const keeper = new KeeperManager({
      config: keeperConfig,
      client: input.client as never,
      memoryManager,
      indexProvider: (projectName) => {
        try {
          return memoryManager.renderProjectIndexSection(projectName);
        } catch {
          return null;
        }
      },
    });
    plog("info",
      `[memory] Keeper ${keeperConfig.keeper.enabled ? "ENABLED — project-memory writes are keeper-only; use <mem> tags" : "DISABLED — main agent writes project memory"}`
    );

    // Startup sweeper: harvest unharvested tails of past sessions.
    // SDK session methods dereference this._client — call them ON the client
    // object (client.session.list(...)), never as detached functions.
    if (keeperConfig.keeper.enabled) {
      try {
        const client = input.client as
          | {
              session?: {
                list?: (args: { query?: { directory?: string } }) => Promise<{ data?: Array<{ id: string; directory?: string; title?: string }> }>;
              };
            }
          | undefined;
        const sessionApi = client?.session;
        if (sessionApi?.list) {
          keeper
            .sweepUnharvested(async () => {
              const res = await sessionApi.list!({
                query: { directory: input.directory },
              });
              return res?.data ?? [];
            })
            .catch((err) =>
              plog("error", `[memory] Keeper sweeper failed: ${(err as Error).message}`)
            );
        } else {
          plog("info", "[memory] Keeper sweeper unavailable: client.session.list missing — skipping startup sweep");
        }
      } catch (err) {
        plog("error", `[memory] Keeper sweeper setup failed: ${(err as Error).message}`);
      }
    }

    // Route embedding dtype config ONCE at startup — configureEmbedding lives
  // in keeperConfig (pure module) so this import never touches transformers.
  configureEmbedding(keeperConfig.indexing.dtype);

  // NOTE: Deliberately NOT calling embedAllExistingFiles() at boot. That
    // routine queues every memory file for embedding, which forces the ONNX
    // model + ORT arena (~2-4GB for fp32) to load during server startup. In a
    // single-process host (bun) that starves the event loop for minutes and
    // prevents the TUI from loading (black screen). Indexing is instead deferred
    // to the first search/reindex via MemoryManager.ensureIndexed().

    const buildContext = (): string => {
      const sections: string[] = [];
      if (bootstrapManager.isBootstrapNeeded()) {
        const bootstrapContent = memoryManager.readFile(
          memoryManager.getBootstrapPath()
        );
        if (bootstrapContent?.trim()) {
          sections.push(
            `## BOOTSTRAP.md (First Run Setup)\n\n${bootstrapContent.trim()}`
          );
        }
      } else {
        const contextFiles = memoryManager.getContextFiles();
        for (const file of contextFiles) {
          sections.push(`## ${file.name}\n\n${file.content}`);
        }
        // Project memory heading indexes — a cheap table of contents.
        // Auto-create the project folder + template files on first session
        // in any real project directory (never for the home directory).
        const projectName = memoryManager.getCurrentProjectName();
        if (projectName && !isHomeDirectory()) {
          try {
            bootstrapManager.createProjectTemplates(projectName);
            const indexSection =
              memoryManager.renderProjectIndexSection(projectName);
            if (indexSection) {
              sections.push(`## Project Memory Index\n\n${indexSection}`);
            }
          } catch (err) {
            plog("error",
              `[memory] Failed to auto-create project memory: ${(err as Error).message}`
            );
          }
        }
      }
      if (sections.length === 0) return "";
      return `# Memory Context\n\n${sections.join("\n\n---\n\n")}`;
    };

    const getMemoryInstructions = (): string => {
      if (bootstrapManager.isBootstrapNeeded()) {
        return BOOTSTRAP_INSTRUCTIONS;
      }
      return keeper.isEnabled()
        ? MEMORY_AWARENESS_INSTRUCTIONS
        : MEMORY_AWARENESS_INSTRUCTIONS_NO_KEEPER;
    };

    // Fresh heading index of the current project's three memory files,
    // or null when there is nothing to index (bootstrap pending, no project,
    // home directory). Served from the mtime+size cache — cheap.
    const buildProjectIndexForCompaction = (): {
      projectName: string;
      indexSection: string;
    } | null => {
      if (bootstrapManager.isBootstrapNeeded()) return null;
      const projectName = memoryManager.getCurrentProjectName();
      if (!projectName || isHomeDirectory()) return null;
      try {
        const indexSection =
          memoryManager.renderProjectIndexSection(projectName);
        if (!indexSection) return null;
        return { projectName, indexSection };
      } catch (err) {
        plog("error",
          `[memory] Failed to build project index for compaction: ${(err as Error).message}`
        );
        return null;
      }
    };

  return {
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] }
    ) => {
      // Keeper sessions get ONLY their dedicated prompt (passed via the
      // promptAsync `system` param). Injecting the full memory context +
      // main-agent instructions would waste tokens and conflict with it.
      if (_input.sessionID && keeper.isKeeperSessionFast(_input.sessionID)) {
        plog("info", `[memory] system.transform: skipping keeper session ${_input.sessionID}`);
        return;
      }
      const memoryContext = buildContext();
      if (!memoryContext) return;
      const instructions = getMemoryInstructions();
      output.system.push(`${memoryContext}${instructions}`);
    },
    // Compaction protection: give the summarization LLM a snapshot of what is
    // already saved (fresh project index) plus rules to preserve unsaved
    // session knowledge in the summary. Appended to OpenCode's default
    // compaction prompt — never replaces it (output.prompt stays unset).
    "experimental.session.compacting": async (
      _input: { sessionID: string },
      output: { context: string[]; prompt?: string }
    ) => {
      const snapshot = buildProjectIndexForCompaction();
      if (!snapshot) return;
      try {
        output.context.push(
          buildCompactionContext(snapshot.projectName, snapshot.indexSection)
        );
      } catch (err) {
        plog("error",
          `[memory] Failed to inject compaction context: ${(err as Error).message}`
        );
      }
    },
    // Keeper event routing: session.created feeds the sessionID→directory map
    // and keeper detection; session.idle either completes a keeper harvest or
    // schedules one for a main session. Compactions/errors are logged.
    event: async (input: { event: any }) => {
      try {
        const event = input.event;
        const type = event?.type;

        if (type === "session.created" || type === "session.updated") {
          const info = event.properties?.info;
          if (info?.id) keeper.observeSessionCreated(info);
        } else if (type === "session.idle") {
          const sessionID: string | undefined = event.properties?.sessionID;
          if (!sessionID || !keeper.isEnabled()) return;
          if (keeper.isKeeperSessionFast(sessionID)) {
            await keeper.onKeeperIdle(sessionID);
          } else {
            keeper.onMainSessionIdle(sessionID);
          }
        } else if (type === "session.compacted") {
          plog("info", `[memory] session.compacted: ${event.properties?.sessionID ?? "unknown"}`);
          const compactedSessionID: string | undefined = event.properties?.sessionID;
          if (compactedSessionID && keeper.isEnabled()) {
            keeper
              .onSessionCompacted(compactedSessionID)
              .catch((err) =>
                plog("error", `[memory] compaction harvest failed: ${(err as Error).message}`)
              );
          }
        } else if (type === "message.part.updated") {
          if (keeper.isEnabled()) {
            const part = event.properties?.part;
            if (part) keeper.observeAssistantText(part);
          }
        } else if (type === "message.updated") {
          if (keeper.isEnabled()) {
            const info = event.properties?.info;
            if (info) keeper.onAssistantMessageCompleted(info);
          }
        } else if (type === "session.error") {
          plog("error", `[memory] session.error: ${event.properties?.sessionID ?? "unknown"}`);
        }
      } catch {
        // never let event handling break a session
      }
    },
    tool: {
      memory: tool({
        description: [
          "Manage memory files for persistent context across sessions.",
          "",
          "**Actions:**",
          "- `index`: Get the heading index (table of contents with word counts) of a memory file. Works for ALL targets.",
          "- `read`: Read a memory file. With `headingPath`, read only that section (including subsections). Without it, read the whole file.",
          "- `write`: Append to a memory file. With `headingPath`, insert content directly under that heading (before its subsections). Without it, append at end of file.",
          "- `edit`: Replace `oldString` with `newString`. With `headingPath`, the search is scoped to that section (and its subsections).",
          "- `delete`: With `timestamp`, delete a timestamped entry. With `headingPath` + `oldString`, delete that exact text from the section.",
          "- `search`: Semantic search across global memory and the current project's memory (pass projectName to search a specific project instead).",
          "- `list`: List all memory files.",
          "- `reindex`: Rebuild the search index for global memory + the current project (other projects self-heal lazily on their own next search). Use if search results seem outdated or incomplete.",
          "- `harvest`: Manually trigger the memory-keeper to harvest this session's recent messages NOW. Works in every trigger mode; in manual/minimal mode it is the ONLY way memory gets saved.",
          "",
          "**Targets:**",
          "- `memory`: MEMORY.md - Long-term memory (crucial decisions, architecture, patterns)",
          "- `identity`: IDENTITY.md - AI identity (name, persona, behavioral rules)",
          "- `user`: USER.md - User profile (name, preferences, context)",
          "- `project`: project/{name}/project.md - Project knowledge: features, architecture, conventions, decisions, constraints, open questions",
          "- `corrections`: project/{name}/corrections.md - Corrective memory: mistakes, fixes, lessons learned",
          "- `environment`: project/{name}/environment.md - Environment memory: commands, paths, tooling",
          "",
          "**Single-writer mode (when the memory-keeper is enabled):**",
          "- write/edit/delete on project/corrections/environment targets are RESERVED for the memory-keeper background agent — your calls will be rejected.",
          "- To get something remembered: put a concise memory candidate or short explanation inside <mem></mem> tags in your reply. The keeper extracts and persists it under the right heading.",
          "- read/index/search remain fully available to you, and memory/identity/user targets remain directly writable.",
          "",
          "**Section addressing (headingPath):**",
          "- An array of heading titles from the file root, e.g. [\"Environment Memory\", \"Commands\"] addresses `# Environment Memory` > `## Commands`.",
          "- Headings are matched exactly as shown in the index. The indexes of all three project files are injected into your system prompt each session - use them as your map.",
          "- Duplicate legacy headings are disambiguated with an ordinal suffix: [\"Testing#2\"].",
          "- `write` under a missing heading fails with the list of valid siblings; pass `createMissing: true` to create the heading chain.",
        ].join("\n"),
        args: {
          action: tool.schema
            .enum([
              "index",
              "read",
              "write",
              "edit",
              "delete",
              "search",
              "list",
              "reindex",
              "harvest",
            ])
            .describe("Action to perform"),
          target: tool.schema
            .enum(["memory", "identity", "user", "project", "corrections", "environment"])
            .optional()
            .describe("Target memory file"),
          content: tool.schema
            .string()
            .optional()
            .describe("Content to write (for write action)"),
          mode: tool.schema
            .enum(["append", "overwrite"])
            .optional()
            .describe(
              "Write mode: append (default) or overwrite (whole file only - cannot be combined with headingPath)"
            ),
          query: tool.schema
            .string()
            .optional()
            .describe("Search query (for search action)"),
          max_results: tool.schema
            .number()
            .optional()
            .describe("Maximum results to return (for search action)"),
          oldString: tool.schema
            .string()
            .optional()
            .describe("String to replace (for edit action)"),
          newString: tool.schema
            .string()
            .optional()
            .describe("Replacement string (for edit action)"),
          timestamp: tool.schema
            .string()
            .optional()
            .describe(
              "Timestamp in YYYY-MM-DD or YYYY-MM-DD HH:MM:SS format (for delete action)"
            ),
          headingPath: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe(
              "Heading path as an array of titles from the file root, e.g. [\"Environment Memory\", \"Commands\"]. Used by read/write/edit/delete for section addressing. See the injected Project Memory Index for valid titles."
            ),
          createMissing: tool.schema
            .boolean()
            .optional()
            .describe(
              "For write with headingPath: create the missing heading(s) instead of failing (default: false)"
            ),
          projectName: tool.schema
            .string()
            .optional()
            .describe(
              "Project name override. For project memory targets: which project to operate on. For search: scopes the search to this project instead of the session's own."
            ),
        },
        async execute(args: any, context: { sessionID: string; directory: string }) {
          const sessionID = context.sessionID || context.directory;
          sessionStates.set(sessionID, {
            memoryOperations: [
              {
                action: args.action,
                target: args.target ?? "",
                timestamp: new Date().toISOString(),
              },
            ],
          });
          memoryManager.ensureDirectories();
          validateAction(args.action);

          // Phase 5 hot-reload sync: loadKeeperConfig() is a cheap statSync
          // when the file is unchanged (cached instance); reference equality
          // tells us whether the indexing knobs changed on disk.
          const freshConfig = loadKeeperConfig();
          if (freshConfig.indexing !== memoryManager.getIndexingConfig()) {
            memoryManager.configureIndexing(freshConfig.indexing);
            configureEmbedding(freshConfig.indexing.dtype);
          }

          // Single-writer guard: project-target writes are keeper-only when
          // the keeper is enabled. Reads stay open to everyone.
          if (["write", "edit", "delete"].includes(args.action)) {
            const rejection = keeper.checkWriteAccess(sessionID, args.target);
            if (rejection) {
              plog("info",
                `[memory] Write guard rejected ${args.action}/${args.target} from non-keeper session ${sessionID}`
              );
              return rejection;
            }
          }

          // Per-session project resolution: the tool context carries the
          // SESSION's directory (not the plugin's startup cwd) — required
          // for multi-project correctness. Handlers read args.projectName.
          if (!args.projectName) {
            const sessionProjectName =
              getProjectNameFromDirectory(context.directory) ?? undefined;
            if (sessionProjectName) args.projectName = sessionProjectName;
          }

          // Auto-create project templates when accessing project targets
          if (["project", "corrections", "environment"].includes(args.target)) {
            if (args.projectName) {
              bootstrapManager.createProjectTemplates(args.projectName);
            }
          }

          try {
            switch (args.action) {
              case "index":
                return handleIndex(args, memoryManager);
              case "read":
                return handleRead(args, memoryManager);
              case "write":
                return handleWrite(args, memoryManager);
              case "edit":
                return handleEdit(args, memoryManager);
              case "delete":
                return handleDelete(args, memoryManager);
              case "search":
                return handleSearch(args, memoryManager);
              case "list":
                return handleList(memoryManager);
              case "reindex":
                return await handleReindex(args, memoryManager);
              case "harvest":
                return await handleHarvest(sessionID, keeper);
              default:
                return `Unknown action: ${args.action}`;
            }
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),
    },
  };
};

export default memoryPlugin;

function handleIndex(
  params: { target?: string; projectName?: string },
  memoryManager: MemoryManager
): string {
  const { target, projectName } = params;

  if (!target) {
    return "Error: target is required for index action.";
  }

  validateTarget(target);

  try {
    return memoryManager.renderTargetIndex(target, projectName);
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Failed to build index for ${target}`;
  }
}

function handleRead(
  params: { target?: string; headingPath?: string[]; projectName?: string },
  memoryManager: MemoryManager
): string {
  const { target, headingPath, projectName } = params;

  if (!target) {
    return handleList(memoryManager);
  }

  // Section mode: read only the addressed heading subtree
  if (headingPath && headingPath.length > 0) {
    try {
      const path = validateHeadingPath(headingPath);
      const { displayName, sectionTitle, section } = memoryManager.readSection(
        target,
        path,
        projectName
      );
      return `${displayName} — section "${sectionTitle}" (${path.join(" > ")})\n\n${section}`;
    } catch (error) {
      return error instanceof Error ? error.message : `Unknown target: ${target}`;
    }
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(target);
    const content = memoryManager.readFile(filePath);
    if (!content) {
      return `${displayName} not found or empty.`;
    }
    return content;
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown target: ${target}`;
  }
}

async function handleWrite(
  params: {
    target?: string;
    content?: string;
    mode?: string;
    headingPath?: string[];
    createMissing?: boolean;
    projectName?: string;
  },
  memoryManager: MemoryManager
): Promise<string> {
  const { target, content, mode, headingPath, createMissing, projectName } = params;

  if (!content) {
    return "Error: content is required for write action.";
  }

  if (!target) {
    return "Error: target is required for write action.";
  }

  validateTarget(target);
  validateContent(content);

  // Section mode: insert content directly under the addressed heading
  if (headingPath && headingPath.length > 0) {
    if (mode === "overwrite") {
      return "Error: mode 'overwrite' cannot be combined with headingPath. Omit headingPath to overwrite the whole file.";
    }
    try {
      const path = validateHeadingPath(headingPath);
      const { displayName, sectionTitle, indexText } =
        memoryManager.writeUnderHeading(
          target,
          path,
          content,
          createMissing === true,
          projectName
        );
      return [
        `Wrote under "${sectionTitle}" in ${displayName}.`,
        "",
        "Current index (fresh):",
        indexText,
      ].join("\n");
    } catch (error) {
      return error instanceof Error ? error.message : `Unknown target: ${target}`;
    }
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      projectName
    );

    const timestamp = memoryManager.getLocalTimestamp();

    if (mode === "overwrite") {
      memoryManager.writeFile(filePath, content);
    } else {
      memoryManager.appendFile(filePath, content);
    }

    const reflectionPrompt = [
      "",
      "[REFLECTION TRIGGERED]",
      `After writing to ${displayName}, ask yourself:`,
      "1. Why was this update important?",
      "2. What pattern does this reveal about the user or project?",
      "3. Should this trigger additional memory updates (cross-referencing)?",
      "4. How does this connect to previous memories?",
    ].join("\n");

    return `${mode === "overwrite" ? "Wrote to" : "Appended to"} ${displayName}.${reflectionPrompt}\n\nTimestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown target: ${target}`;
  }
}

async function handleEdit(
  params: {
    target?: string;
    oldString?: string;
    newString?: string;
    headingPath?: string[];
    projectName?: string;
  },
  memoryManager: MemoryManager
): Promise<string> {
  const { target, oldString, newString, headingPath, projectName } = params;

  if (!target) {
    return "Error: target is required for edit action.";
  }

  if (!oldString) {
    return "Error: oldString is required for edit action.";
  }

  if (newString === undefined) {
    return "Error: newString is required for edit action.";
  }

  // Section mode: scope the oldString search to the addressed section
  if (headingPath && headingPath.length > 0) {
    try {
      const path = validateHeadingPath(headingPath);
      const { displayName, sectionTitle } = memoryManager.editInSection(
        target,
        path,
        oldString,
        newString,
        projectName
      );
      const timestamp = memoryManager.getLocalTimestamp();
      return `Edited section "${sectionTitle}" in ${displayName}\n\nTimestamp: ${timestamp}`;
    } catch (error) {
      return error instanceof Error ? error.message : `Failed to edit ${target}`;
    }
  }

  try {
    const { filePath, displayName } = memoryManager.getPathForTarget(
      target,
      projectName
    );
    memoryManager.editFile(filePath, oldString, newString);
    const timestamp = memoryManager.getLocalTimestamp();
    return `Edited ${displayName}\n\nTimestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error ? error.message : `Failed to edit ${target}`;
  }
}

async function handleDelete(
  params: {
    target?: string;
    timestamp?: string;
    headingPath?: string[];
    oldString?: string;
    projectName?: string;
  },
  memoryManager: MemoryManager
): Promise<string> {
  const { target, timestamp, headingPath, oldString, projectName } = params;

  if (!target) {
    return "Error: target is required for delete action.";
  }

  validateTarget(target);

  // Section mode: delete exact text within the addressed section
  if (headingPath && headingPath.length > 0) {
    if (!oldString) {
      return "Error: oldString is required for delete with headingPath. Alternatively, use timestamp (without headingPath) to delete a timestamped entry.";
    }
    try {
      const path = validateHeadingPath(headingPath);
      const { displayName, sectionTitle } = memoryManager.deleteInSection(
        target,
        path,
        oldString,
        projectName
      );
      return `Deleted text from section "${sectionTitle}" in ${displayName}.`;
    } catch (error) {
      return error instanceof Error
        ? error.message
        : `Failed to delete from ${target}`;
    }
  }

  if (!timestamp) {
    return "Error: timestamp is required for delete action (or provide headingPath + oldString). Format: YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.";
  }

  validateTimestamp(timestamp);

  try {
    const result = await memoryManager.deleteByTimestamp(
      target,
      timestamp,
      projectName
    );
    return `${result}\n\nDeleted timestamp: ${timestamp}`;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Failed to delete from ${target}`;
  }
}

async function handleSearch(
  params: { query?: string; max_results?: number; projectName?: string },
  memoryManager: MemoryManager
): Promise<string> {
  const { query, max_results } = params;

  if (!query) {
    return "Error: query is required for search action.";
  }

  try {
    // args.projectName is pre-populated from the SESSION's directory by the
    // tool execute (index.ts) — so the default scope is the session's own
    // project + global memory. An explicit projectName overrides it.
    const results = await memoryManager.semanticSearch(
      query,
      max_results,
      params.projectName ?? null
    );

    if (results.length === 0) {
      return `No results for "${query}".`;
    }

    const output = results
      .map((r) => {
        const ts = r.timestamp ? `[${r.timestamp}]` : "[no timestamp]";
        const heading = r.heading ? ` (${r.heading})` : "";
        const score = r.score.toFixed(4);
        const preview = r.text.slice(0, 200);
        return `${ts} ${r.filePath}${heading}:${score}: ${preview}`;
      })
      .join("\n\n");

    return `Found ${results.length} results:\n\n${output}`;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : `Search failed for query: ${query}`;
  }
}

interface FileWithTimestamps {
  name: string;
  timestamps: string[];
}

function formatFileEntry(f: FileWithTimestamps): string {
  const count = f.timestamps.length;
  if (count === 0) {
    return `- ${f.name} (0 entries)`;
  }
  const recentTs = f.timestamps.slice(0, 3);
  const more = count > 3 ? `\n    ... and ${count - 3} more` : "";
  const tsList = recentTs.map((ts) => `    - ${ts}`).join("\n");
  return `- ${f.name} (${count} entries):\n${tsList}${more}`;
}

function formatFileSection(
  files: FileWithTimestamps[],
  sectionName: string
): string | null {
  if (files.length === 0) return null;
  return `${sectionName}:\n${files.map(formatFileEntry).join("\n")}`;
}

function handleList(
  memoryManager: MemoryManager
): string {
  const grouped = memoryManager.listFilesGroupedByMonth();
  const parts: string[] = [];

  const rootSection = formatFileSection(grouped.root, "Root files");
  if (rootSection) parts.push(rootSection);

  const projectSection = formatFileSection(grouped.project, "Project files");
  if (projectSection) parts.push(projectSection);

  if (parts.length === 0) {
    return "No memory files found.";
  }

  return parts.join("\n");
}

/**
 * `memory --action harvest`: user-initiated keeper spawn. Bypasses every
 * trigger gate; works in all modes (the only trigger in manual/minimal).
 */
async function handleHarvest(sessionID: string, keeper: KeeperManager): Promise<string> {
  if (!keeper.isEnabled()) {
    return "Harvest unavailable: the memory-keeper is disabled (keeper.enabled=false in keeper-config.json).";
  }
  try {
    await keeper.spawnNow(sessionID);
    return "Harvest requested: the memory-keeper is collecting memory-worthy knowledge from this session's recent messages. It writes project memory in the background (git-committed); check the memory files or git log shortly. If there is nothing new since the last harvest, no keeper session is spawned.";
  } catch (err) {
    return `Harvest failed to start: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleReindex(
  args: { projectName?: string },
  memoryManager: MemoryManager
): Promise<string> {
  try {
    // HARD GATE (2.4.5): indexing disabled → reindex must never load the
    // embedding model. Also NON-DESTRUCTIVE: the existing vector index is
    // left untouched on disk, so re-enabling indexing later resumes with
    // whatever was already built (reindex then refreshes it).
    if (!memoryManager.getIndexingConfig().enabled) {
      return "Reindex unavailable: indexing.enabled=false in keeper-config.json. The embedding model never loads while indexing is disabled. Set indexing.enabled=true (hot-reload applies it on the next tool call), then run reindex.";
    }
    // Scoped reindex (2.4.0): global memory + the target project only.
    // args.projectName is pre-populated from the session's directory.
    // Other projects' indexes are untouched — they self-heal lazily on
    // their own next search (ensureIndexed is incremental + hash-deduped).
    const projectName = args.projectName ?? null;
    const vectorStore = await import("./vector-store.js");
    await vectorStore.clearIndexScope(projectName);
    const orphaned = vectorStore.gcProjectIndexes(memoryManager.listFiles().project);

    // Step 1b: Reset the lazy-indexing guard so re-queuing is allowed
    // (ensureIndexed() may have already resolved and skipped earlier).
    memoryManager.resetIndexing();

    // Step 2: Queue the scoped files for re-embedding (fire and forget)
    memoryManager.embedAllExistingFiles(projectName);

    const scopeText = projectName
      ? `global memory + project "${projectName}"`
      : "global memory only";
    return `Reindex started (scope: ${scopeText}; ${orphaned} orphaned project index(es) removed). The index rebuilds in the background.`;
  } catch (error) {
    return `Reindex failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
