# opencode-auto-mem

Markdown-based persistent memory for OpenCode with a configurable background
**memory-keeper** agent. Patched version of
[@npv12/opencode-memory-md](https://github.com/npv12/opencode-memory-md) built
on the stable OpenCode plugin API.

> **Based on**: [@npv12/opencode-memory-md](https://github.com/npv12/opencode-memory-md)
> (a fork of [opencode-memory-md](https://github.com/npv12/opencode-memory-md)).

- **User manual & configuration reference**: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- **Architecture & design decisions**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Installation

Add to your OpenCode configuration at `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["file://C:/Users/<you>/.config/opencode/node_modules/opencode-auto-mem"]
}
```

Deploy the build to `~/.config/opencode/node_modules/opencode-auto-mem/`
(USERPROFILE `.config` tree — not `%APPDATA%`) and restart OpenCode.

## Quick start — pick a mode

Create an optional config file at
`%APPDATA%/opencode/memory/keeper-config.json` (Windows) or
`~/.config/opencode/memory/keeper-config.json`:

```jsonc
{ "mode": "balanced" }   // no file at all = the same thing
```

| `mode` | Behavior | LLM cost |
|---|---|---|
| `balanced` *(default)* | Harvest ~30s after each turn | ≤1 call / turn |
| `tags` | Harvest **only** when the agent writes `<mem>…</mem>` | 1 call / tagged reply |
| `hybrid` | Tags harvest instantly + idle fallback | ≤1 call / turn |
| `full` | Harvest on every completed assistant message | **1+ calls / message** ⚠️ |
| `minimal` | Nothing automatic — `memory --action harvest` only | 0 |
| `offline` | No keeper, no embeddings, keyword search | 0 |

Every preset is just a bundle of knobs — see the
[full configuration reference](docs/USER_GUIDE.md#6-configuration-reference-every-knob)
for per-knob tuning (`debounceMs`, `fallbackToIdle`, `immediateOnTags`, …).
The config file **hot-reloads** — edit and keep working.

## Memory Files

| File | Purpose | Auto-injected |
|------|---------|---------------|
| `MEMORY.md` | Long-term memory (facts, decisions, preferences) | ✅ |
| `IDENTITY.md` | AI identity (name, persona, behavioral rules) | ✅ |
| `USER.md` | User profile (name, preferences, context) | ✅ |
| `project/{name}/project.md` | Project knowledge: facts, decisions, constraints, open questions | index only |
| `project/{name}/corrections.md` | Corrective memory: mistakes, fixes, lessons | index only |
| `project/{name}/environment.md` | Environment: commands, paths, tooling | index only |
| `BOOTSTRAP.md` | First-run setup instructions (deleted after setup) | first run |

All memory changes are **git-committed** automatically.

## Tool: memory

| Action | Description |
|--------|-------------|
| `index` | Heading index (TOC) of any memory file |
| `read` | Read a file, or one section via `headingPath` |
| `write` | Append, or insert under a heading (`createMissing` supported) |
| `edit` | Replace `oldString` → `newString`, section-scoped |
| `delete` | Delete by `timestamp`, or section-scoped `oldString` |
| `search` | Semantic search (global memory + current project; pass `projectName` to target a specific project) |
| `list` | List all memory files |
| `reindex` | Rebuild the search index (global memory + current project; other projects self-heal lazily) |
| `harvest` | Spawn the memory-keeper NOW (bypasses trigger gates) |

**Single-writer mode** (keeper enabled): project-target writes are reserved
for the keeper — signal memory with `<mem>…</mem>` tags in your replies.

## First Run Flow

**Important:** First setup must be done in OpenCode **build mode** (not plan mode). AI cannot write files in plan mode.

1. Plugin detects no MEMORY.md exists
2. Creates BOOTSTRAP.md with setup instructions
3. AI reads BOOTSTRAP.md and asks user questions interactively
4. AI writes to MEMORY.md, IDENTITY.md, USER.md
5. AI deletes BOOTSTRAP.md
6. Setup complete

## Storage Locations

| What | Windows | Linux/macOS |
|------|---------|-------------|
| Memory data | `%APPDATA%/opencode/memory/` | `~/.config/opencode/memory/` |
| Plugin code (deploy target) | `~/.config/opencode/node_modules/opencode-auto-mem/` | same path |

## Documentation

- **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** — every configuration knob
  explained, preset cookbook, troubleshooting log reference
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — harvest pipeline,
  checkpoint model, trigger semantics, memory-safety design decisions

## License

MIT — see [LICENSE](LICENSE).

Based on [@npv12/opencode-memory-md](https://github.com/npv12/opencode-memory-md) (MIT) — rebuilt on the stable OpenCode plugin API with a background memory-keeper, configurable trigger modes, and project-scoped indexing & search.
