// Memory-keeper configuration (keeper-config.json at the memory root).
// Loaded once at plugin start; loaded lazily on first access.

import * as fs from "node:fs";
import * as path from "node:path";

import { getMemoryDir } from "./config.js";
import { plog } from "./logger.js";

export interface KeeperModelConfig {
  providerID: string;
  modelID: string;
}

export type ModePreset =
  | "minimal"
  | "tags"
  | "balanced"
  | "full"
  | "hybrid"
  | "offline";
export type TriggerMode = "idle" | "tags" | "always" | "manual" | "compaction";
export type HarvestScope = "delta" | "tagsOnly" | "full";
export type IndexingTrigger = "search" | "debouncedWrite" | "manual";
export type EmbeddingDtype = "int8" | "fp32";
/** Which projects' memories participate in indexing + search. */
export type IndexingScope = "project" | "all";

/** Indexing-mode knobs (ResolvedConfig.indexing; MemoryManager consumes). */
export interface IndexingConfig {
  enabled: boolean;
  /** When the (expensive) index refresh runs. */
  trigger: IndexingTrigger;
  /** debouncedWrite coalescing window (ms) after the LAST write. */
  writeDebounceMs: number;
  /** ONNX model precision. */
  dtype: EmbeddingDtype;
  /** Max search results (default AND hard cap). */
  topK: number;
  /** When indexing disabled: search falls back to keyword scoring. */
  keywordFallback: boolean;
  /** Scope of indexing + search: the session's project + global root
   *  ("project", default) or every project ("all" = legacy 2.x behavior). */
  scope: IndexingScope;
}

/** Full resolved configuration — every knob explicit, nothing implicit. */
export interface ResolvedConfig {
  /** Resolved preset label ("balanced" when no mode given). */
  mode: ModePreset;
  keeper: {
    enabled: boolean;
    model?: KeeperModelConfig;
    /** Delete keeper sessions after each successful harvest (default true —
     * dead keeper sessions otherwise accumulate in the server forever). */
    deleteSessions: boolean;
    /** Max sessions the startup sweeper harvests (0 = sweeper off). */
    sweeperMax: number;
    trigger: {
      /** What event starts a harvest cycle. */
      mode: TriggerMode;
      /** idle-mode coalescing window (ms) after a turn ends. */
      debounceMs: number;
      /** always-mode coalescing window (ms) between assistant messages. */
      alwaysDebounceMs: number;
      /** idle mode: completed assistant messages containing <mem> harvest immediately. */
      immediateOnTags: boolean;
      /** tags mode: also harvest untagged deltas on idle (safety net). */
      fallbackToIdle: boolean;
    };
    harvest: {
      /** What text the keeper receives: delta | tagsOnly | full. */
      scope: HarvestScope;
      /** Hard cap on transcript size handed to the keeper. */
      maxTranscriptChars: number;
      /** Skip spawns for deltas smaller than this (chars). */
      minDeltaChars: number;
    };
  };
  indexing: IndexingConfig;
  /** Single-writer guard, independent of keeper.enabled. */
  writeGuard: boolean;
}

/** Base preset = exactly the pre-modes behavior (v2.2.0). */
const BALANCED: ResolvedConfig = {
  mode: "balanced",
  keeper: {
    enabled: true,
    deleteSessions: true,
    sweeperMax: 3,
    trigger: {
      mode: "idle",
      debounceMs: 30_000,
      alwaysDebounceMs: 8_000,
      immediateOnTags: false,
      fallbackToIdle: false,
    },
    harvest: { scope: "delta", maxTranscriptChars: 12_000, minDeltaChars: 40 },
  },
  indexing: {
    enabled: true,
    trigger: "search",
    writeDebounceMs: 300_000,
    dtype: "int8",
    topK: 20,
    keywordFallback: true,
    scope: "project",
  },
  writeGuard: true,
};

/** Presets = sparse overrides layered over BALANCED. */
const PRESETS: Record<ModePreset, object> = {
  balanced: {},
  tags: { keeper: { trigger: { mode: "tags" }, harvest: { scope: "tagsOnly" } } },
  minimal: { keeper: { trigger: { mode: "manual" }, harvest: { scope: "tagsOnly" } } },
  full: { keeper: { trigger: { mode: "always" } }, indexing: { trigger: "debouncedWrite" } },
  hybrid: {
    keeper: {
      trigger: { mode: "tags", immediateOnTags: true, fallbackToIdle: true },
      harvest: { scope: "delta" },
    },
  },
  offline: {
    keeper: { enabled: false, trigger: { mode: "manual" } },
    indexing: { enabled: false },
    writeGuard: false,
  },
};

export function getKeeperConfigPath(): string {
  return path.join(getMemoryDir(), "keeper-config.json");
}

// --------------------------------------------------------------- validation

type Warn = (msg: string) => void;

function bool(v: unknown, fallback: boolean, warn: Warn, label: string): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  warn(`${label}: expected boolean, got ${JSON.stringify(v)} — using ${fallback}`);
  return fallback;
}

function intIn(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
  warn: Warn,
  label: string
): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return v;
  warn(`${label}: expected integer in [${min}, ${max}], got ${JSON.stringify(v)} — using ${fallback}`);
  return fallback;
}

function oneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
  warn: Warn,
  label: string
): T {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  warn(`${label}: expected one of ${allowed.join("|")}, got ${JSON.stringify(v)} — using ${fallback}`);
  return fallback;
}

const MODE_PRESETS: readonly ModePreset[] = ["minimal", "tags", "balanced", "full", "hybrid", "offline"];
const TRIGGER_MODES: readonly TriggerMode[] = ["idle", "tags", "always", "manual", "compaction"];
const HARVEST_SCOPES: readonly HarvestScope[] = ["delta", "tagsOnly", "full"];
const INDEXING_TRIGGERS: readonly IndexingTrigger[] = ["search", "debouncedWrite", "manual"];
const DTYPES: readonly EmbeddingDtype[] = ["int8", "fp32"];
const INDEXING_SCOPES: readonly IndexingScope[] = ["project", "all"];

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (target[k] === null || typeof target[k] !== "object") target[k] = {};
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

/**
 * Pure preset resolution + per-knob validation. Never throws — any invalid
 * knob falls back to its resolved default while valid siblings are preserved.
 * `onWarn` receives one message per rejected/unknown knob (omittable for
 * silent operation, e.g. tests).
 */
export function resolveConfig(raw: unknown, onWarn?: Warn): ResolvedConfig {
  const warn: Warn = onWarn ?? (() => {});
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, any>;
  const keeperRaw = (typeof obj.keeper === "object" && obj.keeper !== null ? obj.keeper : {}) as Record<string, any>;
  const triggerRaw = (typeof keeperRaw.trigger === "object" && keeperRaw.trigger !== null ? keeperRaw.trigger : {}) as Record<string, any>;
  const harvestRaw = (typeof keeperRaw.harvest === "object" && keeperRaw.harvest !== null ? keeperRaw.harvest : {}) as Record<string, any>;
  const indexingRaw = (typeof obj.indexing === "object" && obj.indexing !== null ? obj.indexing : {}) as Record<string, any>;

  // 1. Resolve the preset label.
  let mode: ModePreset = "balanced";
  if (obj.mode !== undefined) {
    if (typeof obj.mode === "string" && (MODE_PRESETS as readonly string[]).includes(obj.mode)) {
      mode = obj.mode as ModePreset;
    } else {
      warn(`Unknown mode ${JSON.stringify(obj.mode)} — using "balanced" (valid: ${MODE_PRESETS.join(", ")})`);
    }
  }

  // 2. Start from the preset (deep clone so callers can't mutate the tables).
  const cfg: ResolvedConfig = structuredClone({ ...BALANCED, mode });

  // 3. Overlay the preset's sparse overrides onto the clone.
  const overrides = PRESETS[mode] as Record<string, any>;
  if (overrides.keeper) deepMerge(cfg.keeper as unknown as Record<string, unknown>, overrides.keeper);
  if (overrides.indexing) deepMerge(cfg.indexing as unknown as Record<string, unknown>, overrides.indexing);
  if (overrides.writeGuard !== undefined) cfg.writeGuard = overrides.writeGuard as boolean;

  // 4. Overlay explicit user knobs (validated; invalid → keep resolved value).
  cfg.keeper.enabled = bool(keeperRaw.enabled, cfg.keeper.enabled, warn, "keeper.enabled");
  cfg.keeper.deleteSessions = bool(keeperRaw.deleteSessions, cfg.keeper.deleteSessions, warn, "keeper.deleteSessions");
  cfg.keeper.sweeperMax = intIn(keeperRaw.sweeperMax, cfg.keeper.sweeperMax, 0, 100, warn, "keeper.sweeperMax");
  cfg.keeper.trigger.mode = oneOf(triggerRaw.mode, TRIGGER_MODES, cfg.keeper.trigger.mode, warn, "keeper.trigger.mode");
  cfg.keeper.trigger.debounceMs = intIn(triggerRaw.debounceMs, cfg.keeper.trigger.debounceMs, 0, 3_600_000, warn, "keeper.trigger.debounceMs");
  cfg.keeper.trigger.alwaysDebounceMs = intIn(triggerRaw.alwaysDebounceMs, cfg.keeper.trigger.alwaysDebounceMs, 0, 3_600_000, warn, "keeper.trigger.alwaysDebounceMs");
  cfg.keeper.trigger.immediateOnTags = bool(triggerRaw.immediateOnTags, cfg.keeper.trigger.immediateOnTags, warn, "keeper.trigger.immediateOnTags");
  cfg.keeper.trigger.fallbackToIdle = bool(triggerRaw.fallbackToIdle, cfg.keeper.trigger.fallbackToIdle, warn, "keeper.trigger.fallbackToIdle");
  cfg.keeper.harvest.scope = oneOf(harvestRaw.scope, HARVEST_SCOPES, cfg.keeper.harvest.scope, warn, "keeper.harvest.scope");
  cfg.keeper.harvest.maxTranscriptChars = intIn(harvestRaw.maxTranscriptChars, cfg.keeper.harvest.maxTranscriptChars, 1000, 1_000_000, warn, "keeper.harvest.maxTranscriptChars");
  cfg.keeper.harvest.minDeltaChars = intIn(harvestRaw.minDeltaChars, cfg.keeper.harvest.minDeltaChars, 0, 100_000, warn, "keeper.harvest.minDeltaChars");
  cfg.indexing.enabled = bool(indexingRaw.enabled, cfg.indexing.enabled, warn, "indexing.enabled");
  cfg.indexing.trigger = oneOf(indexingRaw.trigger, INDEXING_TRIGGERS, cfg.indexing.trigger, warn, "indexing.trigger");
  cfg.indexing.writeDebounceMs = intIn(indexingRaw.writeDebounceMs, cfg.indexing.writeDebounceMs, 1000, 86_400_000, warn, "indexing.writeDebounceMs");
  cfg.indexing.dtype = oneOf(indexingRaw.dtype, DTYPES, cfg.indexing.dtype, warn, "indexing.dtype");
  cfg.indexing.topK = intIn(indexingRaw.topK, cfg.indexing.topK, 1, 100, warn, "indexing.topK");
  cfg.indexing.keywordFallback = bool(indexingRaw.keywordFallback, cfg.indexing.keywordFallback, warn, "indexing.keywordFallback");
  cfg.indexing.scope = oneOf(indexingRaw.scope, INDEXING_SCOPES, cfg.indexing.scope, warn, "indexing.scope");
  cfg.writeGuard = bool(obj.writeGuard, cfg.writeGuard, warn, "writeGuard");

  // 5. Model override (applies to any preset).
  const modelRaw = keeperRaw.model;
  if (
    modelRaw &&
    typeof modelRaw === "object" &&
    typeof modelRaw.providerID === "string" &&
    typeof modelRaw.modelID === "string"
  ) {
    cfg.keeper.model = { providerID: modelRaw.providerID, modelID: modelRaw.modelID };
  }

  // 6. Legacy: pre-v2 files stored the idle debounce at keeper.debounceMs.
  if (keeperRaw.debounceMs !== undefined && triggerRaw.debounceMs === undefined) {
    cfg.keeper.trigger.debounceMs = intIn(
      keeperRaw.debounceMs,
      cfg.keeper.trigger.debounceMs,
      0,
      3_600_000,
      warn,
      "keeper.debounceMs (legacy)"
    );
  }

  return cfg;
}

// -------------------------------------------------- hot-reload cache

interface CacheEntry {
  key: string;
  config: ResolvedConfig;
}
let cache: CacheEntry | null = null;
let lastErrorKey: string | null = null;

/**
 * Load keeper-config.json with hot reload: the file is stat'd on every call;
 * when mtime+size are unchanged the cached resolution is returned (cheap),
 * otherwise the file is re-read and re-resolved. Missing file → balanced
 * defaults. Invalid file → balanced defaults + warn (once per file version).
 * Never throws: config problems must not break the plugin.
 */
export function loadKeeperConfig(): ResolvedConfig {
  const configPath = getKeeperConfigPath();
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(configPath);
  } catch {
    stat = null;
  }

  if (!stat) {
    cache = null;
    if (lastErrorKey !== "missing") {
      plog("info",
        `[keeper] No config file at ${configPath} — using balanced defaults (keeper idle-triggered, embedding at search)`
      );
      lastErrorKey = "missing";
    }
    return resolveConfig(null);
  }

  const key = `${stat.mtimeMs}:${stat.size}`;
  if (cache && cache.key === key) return cache.config;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const config = resolveConfig(raw, (msg) => plog("warn", `[keeper] ${configPath}: ${msg}`));
    cache = { key, config };
    lastErrorKey = null;
    plog("info",
      `[keeper] Config loaded (mode=${config.mode}, trigger=${config.keeper.trigger.mode}, scope=${config.keeper.harvest.scope}, indexing=${config.indexing.enabled ? `${config.indexing.trigger}/${config.indexing.scope}` : "off"}, deleteSessions=${config.keeper.deleteSessions})`
    );
    return config;
  } catch (err) {
    if (lastErrorKey !== key) {
      plog("error",
        `[keeper] Failed to load ${configPath} (${(err as Error).message}) — using balanced defaults`
      );
      lastErrorKey = key;
    }
    return resolveConfig(null);
  }
}

/** Test hook: drop the hot-reload cache so the next load re-reads the file. */
export function __resetKeeperConfigCache(): void {
  cache = null;
  lastErrorKey = null;
}

// Phase 5: dtype routing. `configureEmbedding` lives here (a pure module) so
// index.ts can route config ONCE at startup without importing the heavy
// transformers package (which embedding.ts owns).
export { setActiveDtype as configureEmbedding } from "./embeddingConfig.js";