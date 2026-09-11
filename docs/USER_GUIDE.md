# opencode-auto-mem — User Guide

Markdown-based persistent memory for OpenCode, with a background **memory-keeper**
agent that writes project memory for you, and **configurable modes** that decide
when it runs and how much it costs.

> Internals and design decisions: see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. What the plugin does

- Injects your global memory (`MEMORY.md`, `IDENTITY.md`, `USER.md`) plus a
  heading index of the current project's memory into every session's system prompt.
- Owns three per-project memory files: `project.md`, `corrections.md`,
  `environment.md`.
- Spawns a **memory-keeper** background agent that harvests knowledge from your
  conversations and writes those files — you never stop working to save memory.
- Provides the `memory` tool (read/write/edit/delete/search/list/reindex/harvest).
- All memory writes are git-committed automatically.

## 2. Installation

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["file://C:/Users/<you>/.config/opencode/node_modules/opencode-auto-mem"] }
```

Deploy the build to `~/.config/opencode/node_modules/opencode-auto-mem/`
(**USERPROFILE** `.config` — never `%APPDATA%`) and restart OpenCode.

## 3. Configuration — quick start

Config file: `%APPDATA%/opencode/memory/keeper-config.json` (Windows) or
`~/.config/opencode/memory/keeper-config.json` (Linux/macOS). The file is
**optional** — with no file, the plugin runs in `balanced` mode (the classic
behavior). The file **hot-reloads**: edit it and the next keeper event picks it
up, no restart needed (restart to re-arm startup behavior).

### The six presets

| `mode` | Keeper trigger | What you get | LLM cost |
|---|---|---|---|
| `balanced` *(default)* | Harvest ~30s after each turn ends | Classic behavior: every turn is harvested | ≤1 call / turn |
| `tags` | Harvest **only** when the agent writes `<mem>...</mem>` in its reply | Cheapest always-on mode; untagged turns cost nothing | 1 call / tagged reply |
| `hybrid` | Tags harvest **immediately**; untagged turns still harvest on idle | Fast path for explicit signals + safety net | ≤1 call / turn |
| `full` | Harvest on **every completed assistant message** (8s coalescing) | Most aggressive memory capture | **1+ calls / message** ⚠️ |
| `minimal` | **Nothing automatic** — only `memory --action harvest` | Full manual control | 0 auto calls |
| `offline` | Keeper off, no embeddings, keyword search only | Near-zero footprint | 0, no model ever |

Minimal config examples:

```jsonc
{ "mode": "tags" }                                  // your suggestion #1
{ "mode": "full" }                                  // your suggestion #2
{ "mode": "tags", "keeper": { "trigger": { "fallbackToIdle": true } } }  // hybrid via knobs
```

Any knob you set explicitly **overrides** the preset; the preset fills the rest.

### Preset ↔ resolved knobs (what each mode actually sets)

| Preset | trigger.mode | immediateOnTags | fallbackToIdle | harvest.scope* | indexing* |
|---|---|---|---|---|---|
| `balanced` | `idle` | false | false | `delta` | `search` |
| `tags` | `tags` | false | false | `tagsOnly` | `search` |
| `hybrid` | `tags` | true | true | `delta` | `search` |
| `full` | `always` | false | false | `delta` | `debouncedWrite` |
| `minimal` | `manual` | false | false | `tagsOnly` | `search` |
| `offline` | `manual` (moot, keeper off) | — | — | — | disabled + keyword fallback |

\* These preset defaults are **fully enforced** — `harvest.scope` since Phase 4
and `indexing.trigger`/`indexing.scope` since Phase 5 (see the status matrix in
§9). Explicitly set knobs override the preset. While `indexing.enabled: false`
the embedding model **never loads**: search falls back to keywords (or returns
an explicit disabled notice) and `reindex` is a non-destructive no-op.

## 4. The memory tool

| Action | Description |
|---|---|
| `index` | Heading index (TOC with word counts) of any memory file |
| `read` | Read a file or one section (`headingPath`) |
| `write` | Append, or insert under a heading (`headingPath`, `createMissing`) |
| `edit` | Replace `oldString` → `newString`, scoped to a section |
| `delete` | Delete by `timestamp` or by section-scoped `oldString` |
| `search` | Semantic search (global memory + the current project; pass `projectName` to search a specific project instead) |
| `list` | List all memory files |
| `reindex` | Rebuild the search index (global memory + the current project; orphaned index dirs are GC'd; other projects self-heal lazily). **No-op (non-destructive) while `indexing.enabled: false`** — the embedding model never loads while indexing is off; re-enable first, then reindex |
| `harvest` | **Spawn the memory-keeper for this session NOW** — bypasses every trigger gate; the only trigger in `manual`/`minimal` mode |

**Single-writer mode** (keeper enabled): `write`/`edit`/`delete` on
`project`/`corrections`/`environment` targets are **reserved for the keeper** —
the main agent signals memory-worthy content with `<mem></mem>` tags in its
replies instead. Global targets (`memory`, `identity`, `user`) remain writable.

## 5. The `<mem>` protocol

In `tags`/`hybrid` modes (and any mode, as a hint to the keeper), wrap
memory-worthy content in your reply:

```
<mem> Vectra index routing must use path.relative first-segment checks on Windows </mem>
```

- `tags` mode: tagged content is what gets remembered — anything untagged is
  not harvested (checkpoint advances silently).
- `hybrid` mode: tagged content harvests immediately; untagged turns still get
  a normal idle harvest as a safety net.
- Other modes: tags are treated as high-priority hints by the keeper.

## 6. Configuration reference (every knob)

```jsonc
{
  "mode": "balanced",            // minimal | tags | balanced | full | hybrid | offline

  "keeper": {
    "enabled": true,             // master switch
    "model": { "providerID": "x", "modelID": "y" },  // optional; default = session model
    "deleteSessions": true,      // delete keeper sessions after each harvest
    "sweeperMax": 3,             // startup recovery: harvest up to N past-session tails (0 = off)

    "trigger": {
      "mode": "idle",            // idle | tags | always | manual | compaction
      "debounceMs": 30000,       // idle-mode wait-after-turn (coalescing window)
      "alwaysDebounceMs": 8000,  // always-mode wait-after-message (coalescing window)
      "immediateOnTags": false,  // idle mode: <mem> in a completed reply → harvest NOW
      "fallbackToIdle": false    // tags mode: untagged turns still harvest on idle
    },

    "harvest": {
      "scope": "delta",          // delta | tagsOnly | full          ✅ enforced
      "maxTranscriptChars": 12000, // transcript cap                ✅ enforced
      "minDeltaChars": 40        // skip trivially small deltas     ✅ enforced (tagged deltas exempt)
    }
  },

  "indexing": {
    "enabled": true,             // vector index on
    "trigger": "search",         // search | debouncedWrite | manual ✅ enforced
    "writeDebounceMs": 300000,   // debouncedWrite window            ✅ enforced
    "dtype": "int8",             // int8 | fp32                      ✅ enforced
    "topK": 20,                  // max search results (cap)         ✅ enforced
    "keywordFallback": true,     // search without embeddings        ✅ enforced
    "scope": "project"           // project | all                    ✅ enforced (2.4.0)
  },

  "writeGuard": true             // single-writer guard              ⏳ Phase 6 (today: tied to keeper.enabled)
}
```

### Knob-by-knob explanation

| Knob | What it controls |
|---|---|
| `keeper.trigger.mode` | **What event starts a harvest**: `idle` = turn end (session.idle); `tags` = turn end but only if the delta contains `<mem>`; `always` = every completed assistant message; `manual` = only the `harvest` action; `compaction` = only session.compacted events |
| `debounceMs` / `alwaysDebounceMs` | "Wait for quiet" timers that reset on every new trigger — bursts become ONE harvest. Two clocks because the event tempos differ (turns vs messages) |
| `immediateOnTags` | In `idle` mode: a completed reply containing `<mem>` skips the remaining debounce and harvests immediately |
| `fallbackToIdle` | In `tags` mode: harvest untagged deltas on idle anyway (safety net vs silent loss) |
| `keeper.deleteSessions` | Keeper sessions are real OpenCode sessions; `true` deletes them after their checkpoint advances (audit trail survives in git commits + keeper-state.json) |
| `keeper.sweeperMax` | At plugin startup, harvest the unharvested tails of up to N past sessions (crash recovery). Only active in `idle`/`always` modes |
| `keeper.model` | Which LLM plays the keeper; unset = the session's default model |
| `harvest.scope` | What text the keeper receives: `delta` = new messages since the last harvest; `tagsOnly` = only the `<mem>` excerpts (+2 context lines); `full` = the entire session from message 0 (can correct older memory). The `tags`/`minimal` presets set `tagsOnly` |
| `harvest.maxTranscriptChars` | Hard transcript cap — truncation is marked explicitly (`[...transcript truncated...]`) so the keeper knows content was dropped |
| `harvest.minDeltaChars` | Deltas smaller than this skip the spawn (checkpoint still advances) — EXCEPT deltas carrying `<mem>` tags, which always harvest |
| `indexing.trigger` | When the (expensive) index refresh runs: `search` = right before a search (zero background cost, default); `debouncedWrite` = ONE incremental refresh after `writeDebounceMs` of write-quiet (index stays near-fresh with bounded cost); `manual` = only the explicit `reindex` action |
| `indexing.enabled` + `keywordFallback` | `enabled: false` → the ONNX model NEVER downloads/loads — search, background refresh, AND `reindex` all skip the embedding pipeline (`reindex` is a non-destructive no-op that leaves any built index on disk); search falls back to keyword scoring (`keywordFallback: true`) or returns an explicit disabled notice |
| `indexing.dtype` | Model precision: `int8` (default, ~4× smaller) or `fp32` — applied at first model load; restart/first-search picks it up |
| `indexing.topK` | Max search results (default AND hard cap — config wins over explicit requests) |
| `indexing.scope` | Which projects' memories are indexed + searched: `"project"` (default) = the session's project + global memory only — other projects are never indexed, refreshed, or queried; `"all"` = legacy 2.x behavior spanning every project. An explicit `projectName` on the search action overrides per-call |
| `writeGuard` | **Parsed today, enforced in Phase 6** — setting it now has no effect |

Validation: any invalid knob falls back to its default with a warning in the
log; valid siblings are unaffected. Legacy flat `keeper.debounceMs` is honored.

## 7. Cookbook — "I want X"

| I want… | Config |
|---|---|
| …to never think about memory again (classic) | *(no config file)* or `{"mode":"balanced"}` |
| …minimal LLM cost, explicit memory only | `{"mode":"tags"}` |
| …tags to save instantly, but nothing silently lost | `{"mode":"hybrid"}` |
| …maximum memory capture, cost be damned | `{"mode":"full"}` |
| …memory saved only when I say so | `{"mode":"minimal"}` + tell the agent `memory --action harvest` |
| …zero background anything (weak laptop) | `{"mode":"offline"}` |
| …tags mode but sweep every turn as backup | `{"mode":"tags","keeper":{"trigger":{"fallbackToIdle":true}}}` |
| …always-on but calmer | `{"mode":"full","keeper":{"trigger":{"alwaysDebounceMs":15000}}}` |
| …cheaper keeper model | `{"mode":"balanced","keeper":{"model":{"providerID":"…","modelID":"…"}}}` |

## 8. Troubleshooting

Watch logs — **`opencode.log` only** (the TUI console is silent by design:
raw console output garbles the TUI frame; all plugin lines go to the server
log, service `opencode-auto-mem`):

| Log line | Meaning |
|---|---|
| `[keeper] Config loaded (mode=…)` | Config loaded/hot-reloaded + resolved summary |
| `[keeper] Unknown mode "x" — using "balanced"` | Typo in `mode` |
| `[keeper] …: expected one of … — using …` | A knob had an invalid value; that knob fell back |
| `[keeper] Idle on <id> — harvest scheduled in …ms` | idle/always trigger armed |
| `[keeper] Tags mode: delta … no <mem> tags — checkpoint advances without harvest` | tags mode skipped an untagged turn (normal) |
| `[keeper] immediateOnTags: <mem> detected …` | immediate harvest fired |
| `[keeper] Spawned harvest: main=… keeper=… deltaMessages=…` | keeper session launched |
| `[keeper] No new messages for <id>` | Trigger fired but nothing new since the last checkpoint (normal after an immediate harvest) |
| `[keeper] Sweeper: disabled in trigger mode 'tags'` | Startup sweep correctly gated off |
| `[memory] Write guard rejected …` | Non-keeper session tried to write project memory |

Memory-footprint expectations: `balanced` ≈ 700–800MB steady; the embedding
model loads only on first `search`; `offline` never loads it. If memory grows
continuously during normal turns, verify you are on the current build
(write-decoupled indexing, no boot-time embedding).

**Debugging tip:** to see plugin lines live in the terminal (e.g. while tuning
modes), set the environment variable `OPENCODE_AUTO_MEM_CONSOLE_LOG=1` before
starting OpenCode — it forces the console sink on alongside the server log.
Without it, plugin lines appear ONLY in `opencode.log`
(`findstr /C:"opencode-auto-mem" "%USERPROFILE%\.local\share\opencode\log\opencode.log"`,
adjusting the path to your log dir).

## 9. Implementation status matrix

| Area | Status |
|---|---|
| Config schema v2, presets, per-knob validation, hot reload | ✅ Phase 1 |
| Trigger modes `tags` / `manual` / `compaction` + `fallbackToIdle` + sweeper gating | ✅ Phase 2 |
| `memory --action harvest` | ✅ Phase 2 |
| `always` mode + `immediateOnTags` (message-level triggers) | ✅ Phase 3 |
| Harvest scopes (`tagsOnly`, `full`), transcript caps | ✅ Phase 4 |
| Indexing modes (`debouncedWrite`, `manual`, keyword fallback), dtype/topK knobs | ✅ Phase 5 |
| `writeGuard` decoupled from keeper.enabled; `status` action | ⏳ Phase 6 |
| Full docs final pass | ⏳ Phase 7 |