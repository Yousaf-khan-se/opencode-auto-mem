# opencode-auto-mem — Architecture

Internal design of the plugin: components, data flow, safety mechanisms, and
the reasoning behind the memory-critical decisions. User-facing knobs are
documented in [USER_GUIDE.md](./USER_GUIDE.md).

## 1. Component map

```
src/
├── index.ts            ← plugin entry: hooks (system.transform, event, tool), action dispatch
├── MemoryManager.ts    ← file I/O, EmbeddingQueue, ensureIndexed, section ops, git commits
├── keeper.ts           ← KeeperManager: trigger modes, debounce/coalescing, spawning, checkpoints, sweeper
├── keeperConfig.ts     ← config v2: presets, validation, hot reload (mtime+size cache)
├── keeperPrompt.ts     ← keeper system prompt + transcript formatter
├── memTags.ts          ← pure <mem> tag extraction (tags mode + boundary handling)
├── headings.ts         ← pure markdown heading-tree utils (index, addressing, surgery)
├── indexCache.ts       ← mtime+size backed heading-index cache (JSON sidecar)
├── chunker.ts          ← markdown → chunks (heading-path chunks for search)
├── vector-store.ts     ← Vectra LocalIndex singletons (root + project), hash-dedupe upserts
├── embedding.ts        ← transformers.js pipeline (int8, ORT arena limits) — lazily imported
├── hash.ts             ← pure SHA-256 (kept separate so chunking never imports transformers)
├── memoryInstructions.ts ← system-prompt injection text (keeper / no-keeper variants)
├── git.ts              ← auto-commit of memory changes
├── atomicWrite.ts      ← tmp+rename writes
├── config.ts           ← path resolution (memory dir per OS)
├── timestampParser.ts  ← <!-- ts --> parsing, orphan stripping
├── validation.ts       ← action/target/content validation
└── logger.ts           ← dual-sink plog (console + client.app.log)
```

## 2. The harvest pipeline (one keeper cycle)

```
You finish a turn (or an assistant message completes — see trigger modes)
   │
   ▼ ① OpenCode fires events → src/index.ts event hook routes them:
       session.created/updated → keeper.observeSessionCreated  (dir map + keeper detection)
       session.idle            → onKeeperIdle (keeper) / onMainSessionIdle (main)
       message.updated         → onAssistantMessageCompleted  (always / immediateOnTags)
       message.part.updated    → observeAssistantText          (immediateOnTags buffer)
       session.compacted       → onSessionCompacted            (compaction mode)
   │
   ▼ ② Debounce/coalesce (per-mode timers: `timers`, `alwaysTimers`)
       running-guard: harvest in flight → dirty flag → coalesced respawn on completion
   │
   ▼ ③ spawnKeeper(sessionID):
       a. resolve session directory → project name (per-session, multi-project safe)
       b. client.session.messages() → full history
       c. DELTA = messages AFTER the checkpoint (keeper-state.json, per project+session)
       d. formatTranscript(delta) — tool-only deltas advance the checkpoint and skip
       e. TRIGGER-MODE GATE: tags mode scans for <mem> (incl. prev-message tail);
          no tags + no fallbackToIdle → checkpoint advances, NO spawn, return
       e2. minDeltaChars guard: tiny deltas skip (tagged deltas exempt) — checkpoint advances
       e3. SCOPE SELECTION: delta (default) | tagsOnly (formatMemTags excerpts;
          zero candidates → advance + skip) | full (formatTranscript(msgs) whole session)
       e4. capTranscript: hard cap at maxTranscriptChars with explicit truncation marker
       f. build keeper system prompt (scope-aware task variant + project memory heading index)
       g. seal tool sandbox: tool.ids() enumeration, everything false except `memory`
          (fail-closed: enumeration available but empty → abort BEFORE create)
       h. session.create(parentID, "[mem-keeper] …") + promptAsync(system, tools, model)
       i. 5-minute watchdog; timeout → abandon, checkpoint NOT advanced (retried later)
   │
   ▼ ④ The keeper agent runs server-side: reads memory, writes
      project.md / corrections.md / environment.md via the memory tool
      (writes are git-committed; vector index is NOT touched on write)
   │
   ▼ ⑤ Keeper session goes idle → onKeeperIdle():
       running cleared → CHECKPOINT ADVANCES (state persisted atomically) →
       deleteSessions? session.delete → dirty? respawn (coalesced follow-up)
```

## 3. The checkpoint model

`keeper-state.json` (per project folder): `{ sessions: { <sessionID>: { lastMessageID, harvested } } }`.

- **Idempotency:** every harvest covers only messages after the last checkpoint —
  restarts, retries, and duplicate triggers can never double-harvest.
- **Advance-on-skip:** tool-only deltas AND untagged deltas (tags mode) advance
  the checkpoint WITHOUT spawning — unprocessed content never accumulates, and
  skipped content is never re-scanned.
- **Crash recovery:** the startup sweeper (idle/always modes only) harvests the
  unharvested tails of up to `sweeperMax` past sessions.
- **Watchdog:** a keeper that never idles within 5 minutes is abandoned without
  advancing the checkpoint — the next trigger retries the same delta.

## 4. Trigger modes — decision table

| Event | idle | tags | always | manual | compaction |
|---|---|---|---|---|---|
| `session.idle` (turn end) | debounce → harvest | tags gate → harvest/skip | harvest (also; checkpoint dedupes) | ✗ | ✗ |
| `message.updated` (completed assistant) | immediateOnTags only: `<mem>` → harvest NOW, cancel pending idle timer | ✗ | coalescing window → harvest | ✗ | ✗ |
| `session.compacted` | ✗ (logged) | ✗ | ✗ | ✗ | harvest now |
| `memory --action harvest` | ✓ (bypasses gates) | ✓ | ✓ | ✓ (only trigger) | ✓ |
| startup sweeper | ✓ (≤ sweeperMax) | ✗ (contract) | ✓ | ✗ | ✗ |

Hybrid = `tags` + `immediateOnTags: true` + `fallbackToIdle: true`.

### Loop safety (why keepers can't spawn keepers)

1. `spawned` set — keeper session IDs from this process; message events from
   them are dropped (anti-feedback guard).
2. Title prefix `[mem-keeper]` — sweeper skips them across restarts.
3. `running`/`dirty` sets — one harvest per session at a time; overlapping
   triggers coalesce into exactly one follow-up.
4. Checkpoints — even if a spawn slips through, an empty delta no-ops it.
5. Tool sandbox — keepers get ONLY the `memory` tool (dynamic blocklist via
   `tool.ids()`, fail-closed when enumeration is available but empty).

## 5. Indexing pipeline & memory-safety design

- **No embedding at boot.** Boot-time embedding loads the ONNX model + ORT
  arena inside OpenCode's single bun process → event-loop starvation, black
  TUI. `embedding.js` is only reachable via dynamic import.
- **No embedding on writes.** With the keeper writing after every turn,
  per-write embedding made ONX native heap churn continuously (1–5GB spikes).
  Writes touch only `.md` files.
- **The one automatic trigger:** `ensureIndexed(scope)` — called from
  `semanticSearch()` before querying with the SEARCH's scope; queues only the
  scoped files (global root always + the target project, or every project when
  `indexing.scope: "all"`) and runs `embeddingQueue.drain()`.
  **Incremental**: `upsertFile` dedupes by chunk SHA-256, so unchanged files
  cost a re-read + hash; only new/changed chunks embed.
- Model: nomic-embed-text-v1.5, `dtype: int8` (~130MB), ORT session options
  `enableCpuMemArena: false, enableMemPattern: false` (no multi-GB arena).
- **Per-project vector indexes (2.4.0):** one Vectra index per scope —
  `memory/indexes/root/` for global files, `memory/indexes/projects/<name>/`
  for each project. A project's index is opened/queried/refreshed ONLY when
  that project is being worked in (or explicitly searched via `projectName`).
  `reindex` clears root + the current project and GCs index dirs whose project
  folder no longer exists (`gcProjectIndexes`); legacy `root.index` /
  `project.index` dirs are ignored and deleted on reindex. A file's index
  follows deterministically from its path (`getProjectNameForFile`), so
  cross-project mis-filing is impossible by construction — only the legacy
  root self-heal purge remains in `upsertFile`. Instances are keyed by index
  path, opened lazily, and initialized serially (Bun NAPI safety preserved).
- **Indexing modes (Phase 5 + 2.4.0 scope):** `indexing.trigger` selects the
  refresh trigger —
  `search` (default: `ensureIndexed()` right before querying, scoped to the
  search's project), `debouncedWrite`
  (single coalescing timer armed ONLY by actual writes, never at boot; tracks
  WHICH scopes got dirty — a root flag + per-project set — and fires one
  incremental refresh for the dirty scopes only after `writeDebounceMs` of
  quiet), `manual` (only the
  explicit `reindex` action; `ensureIndexed()` no-ops with a log line).
  `indexing.scope` selects WHICH projects participate in indexing + search:
  `"project"` (default: the session's project + global root) or `"all"`
  (legacy 2.x cross-project behavior).
  `indexing.enabled: false` → the transformers package is never imported, the
  model never loads — search, `ensureIndexed()`, AND the explicit `reindex`
  action all skip the embedding pipeline (reindex is a non-destructive no-op
  that leaves the built index on disk for later re-enabling);
  `semanticSearch()` routes to `keywordSearch()` (pure
  term-overlap scoring over chunkMarkdown chunks, scoped identically) when
  `keywordFallback: true`,
  else returns an explicit disabled entry. `dtype` (int8 default) flows through
  the pure `embeddingConfig.ts` state module (keeperConfig re-exports
  `configureEmbedding` so index.ts routes it at startup without touching
  transformers). `topK` is the default AND hard cap of search results. Tool
  execute re-checks config (reference equality on the hot-reload cache) so
  indexing knobs apply live without a restart.

## 6. Config resolution pipeline

```
keeper-config.json (mtime+size cache → hot reload)
  → resolveConfig(raw):
      1. mode label (unknown → warn + balanced)
      2. deep-clone BALANCED base        (= pre-modes behavior)
      3. overlay preset overrides        (sparse, per mode)
      4. overlay explicit user knobs     (per-knob validation; invalid → default + warn)
      5. model override
      6. legacy keeper.debounceMs → trigger.debounceMs
  → ResolvedConfig (fully explicit; consumed by KeeperManager / MemoryManager)
```

Precedence: explicit knob > preset > balanced default. Never throws.

## 7. Design decision log

| Decision | Why |
|---|---|
| Writes decoupled from embedding | Keeper writes every turn → continuous ONNX churn (1–5GB). Index refreshes lazily at search (hash-dedupe makes it cheap). |
| Fresh keeper session per harvest (not a singleton) | Singleton context grows forever, relies on compaction, drifts. |
| `deleteSessions: true` default | Dead keeper sessions accumulate in server memory + session list forever; audit trail lives in git + keeper-state.json. |
| Checkpoint advances on skip (tags/no-delta) | Prevents unbounded re-scanning of the same content. |
| Checkpoint does NOT advance on watchdog timeout | Timed-out harvests retry with the same delta. |
| Separate `alwaysTimers` from idle `timers` | Different event tempos → independently tunable coalescing windows. |
| Text buffer (8KB tail × 200) for immediateOnTags | `message.updated` carries no text (verified SDK types); buffer deleted on completion — bounded memory. |
| Sweeper gated to idle/always | A blind sweep would harvest untagged tails, violating tags/manual/compaction contracts. |
| tool.ids-first fail-closed sandbox | `tools` body param is a BLOCKLIST; hardcoded negatives can't cover dynamic MCP tools (delegate-escape incident). |
| Dual-sink plog | `console.*` never reached opencode.log; `client.app.log()` does. |
| Console sink OFF when the app sink is armed (env `OPENCODE_AUTO_MEM_CONSOLE_LOG=1` escape hatch) | The TUI shares the server process's stdout — raw console lines inject into the middle of the rendered frame (garbled positioning). Server log carries everything; console only for app-sink-less contexts (tests) or explicit debugging. |
| Project-scoped indexing & search (2.4.0) | Working on project A must not index, refresh, or query project B — that wastes resources and leaks unrelated memories into results. One Vectra index per project under `indexes/projects/<name>/`; cross-project recall is an explicit opt-in (`projectName` search arg / `indexing.scope: "all"`). |

## 8. Implementation status

✅ Phases 1–5 (config v2 + presets + hot reload; trigger modes tags/manual/
compaction + fallbackToIdle + sweeper gating; harvest action; always +
immediateOnTags; harvest scopes delta/tagsOnly/full + caps + prompt variants;
indexing modes search/debouncedWrite/manual + keyword fallback + dtype/topK).
⏳ Phase 6 writeGuard/status. See USER_GUIDE.md §9 for the matrix.