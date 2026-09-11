// Memory-keeper: background sessions that harvest conversation deltas after
// each completed turn and persist project memory. See AGENTS.md "Memory-Keeper
// Architecture" for the verified OpenCode internals this relies on.

import * as fs from "node:fs";
import * as path from "node:path";

import { atomicWrite } from "./atomicWrite.js";
import { directoryIsHome, getProjectNameFromDirectory } from "./config.js";
import type { ResolvedConfig } from "./keeperConfig.js";
import { buildKeeperPrompt, capTranscript, formatTranscript } from "./keeperPrompt.js";
import { buildTagScanText, extractMemTags, formatMemTags } from "./memTags.js";
import { plog } from "./logger.js";

export const KEEPER_TITLE_PREFIX = "[mem-keeper]";

/**
 * Narrative text of a message (non-synthetic text parts, joined).
 */
function messageText(
  msg: { parts?: Array<{ type: string; text?: string; synthetic?: boolean }> } | undefined
): string {
  if (!msg?.parts) return "";
  return msg.parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

/**
 * Tail-truncated narrative text — used to detect a <mem> tag that opened at
 * the very end of the previous checkpoint's last message and closed inside
 * the new delta.
 */
function messageTail(
  msg: { parts?: Array<{ type: string; text?: string; synthetic?: boolean }> } | undefined,
  maxChars = 400
): string {
  const text = messageText(msg);
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Subset of the @opencode-ai/sdk client session domain used by the keeper. */
export interface KeeperClient {
  session: {
    get(args: { path: { id: string } }): Promise<{ data?: { title?: string; directory?: string } }>;
    create(args: {
      body?: { parentID?: string; title?: string };
      query?: { directory?: string };
    }): Promise<{ data?: { id: string } }>;
    promptAsync(args: {
      path: { id: string };
      body: {
        parts: Array<{ type: "text"; text: string }>;
        system?: string;
        tools?: Record<string, boolean>;
        model?: { providerID: string; modelID: string };
      };
    }): Promise<unknown>;
    messages(args: { path: { id: string } }): Promise<{
      data?: Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string; synthetic?: boolean }> }>;
    }>;
    delete(args: { path: { id: string } }): Promise<unknown>;
  };
  tool?: {
    ids?(args: { query?: { directory?: string } }): Promise<{ data?: Array<string> }>;
    list(args: {
      query: { provider: string; model: string; directory?: string };
    }): Promise<{ data?: Array<{ id: string }> }>;
  };
}

/**
 * Tools the keeper must never touch even when dynamic enumeration is
 * unavailable (belt and suspenders). Extended with the delegate family after
 * the delegate-escape incident: a keeper invoked `[tool: delegate]` and sat in
 * a 1-hour delegation. Extra entries for tools that do not exist are harmless —
 * the tools body param is a blocklist; unknown keys are ignored.
 */
const HARDCODED_TOOL_NEGATIVES = [
  "bash", "edit", "write", "read", "grep", "glob", "list", "patch",
  "webfetch", "task", "kill", "todowrite", "todoread", "multiedit",
  "delegate", "delegation_read", "delegation_list",
  "background_output", "background_cancel", "killshell",
];

interface SessionCheckpoint {
  /** Last harvested message ID (inclusive). */
  lastMessageID: string;
  /** Whether this checkpoint was written after a completed keeper run. */
  harvested: boolean;
}

interface ProjectKeeperState {
  /** sessionID → checkpoint (per main session in this project). */
  sessions: Record<string, SessionCheckpoint>;
}

const KEEPER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class KeeperManager {
  private config: ResolvedConfig;
  private memoryManager: { getProjectFolder(projectName: string): string };
  private indexProvider: (projectName: string) => string | null;
  private client: KeeperClient;
  /** sessionID → directory (populated from session.created events). */
  private sessionDirectories = new Map<string, string>();
  /** Main sessions with a keeper currently running. */
  private running = new Set<string>();
  /** Main sessions marked dirty while their keeper was running. */
  private dirty = new Set<string>();
  /** Keeper session IDs we spawned (fast loop guard). */
  private spawned = new Set<string>();
  /** Debounce timers per session. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Keeper completion timeouts per session. */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Always-mode per-message coalescing timers (separate clock from idle). */
  private alwaysTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Accumulated assistant text per messageID (from message.part.updated) —
   * consumed by immediateOnTags when a message completes. Only populated
   * while idle+immediateOnTags is active; entries are deleted on completion
   * and hard-capped below.
   */
  private assistantTextBuffers = new Map<string, string>();

  /**
   * Cap for sessionDirectories (session.updated fires for EVERY session,
   * including delegation/agent children — unbounded growth over a long-lived
   * server). Maps preserve insertion order, so pruning deletes the oldest.
   */
  private static readonly MAX_SESSION_DIRECTORIES = 500;

  constructor(opts: {
    config: ResolvedConfig;
    client: KeeperClient;
    memoryManager: { getProjectFolder(projectName: string): string };
    indexProvider: (projectName: string) => string | null;
  }) {
    this.config = opts.config;
    this.client = opts.client;
    this.memoryManager = opts.memoryManager;
    this.indexProvider = opts.indexProvider;
  }

  // ------------------------------------------------------------- state file

  private statePath(projectName: string): string {
    return path.join(this.memoryManager.getProjectFolder(projectName), "keeper-state.json");
  }

  private loadProjectState(projectName: string): ProjectKeeperState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath(projectName), "utf-8"));
      if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object") {
        return raw as ProjectKeeperState;
      }
    } catch {
      // missing/corrupt → fresh
    }
    return { sessions: {} };
  }

  private saveProjectState(projectName: string, state: ProjectKeeperState): void {
    try {
      atomicWrite(this.statePath(projectName), JSON.stringify(state, null, 2));
    } catch (err) {
      plog("error", `[keeper] Failed to persist state for ${projectName}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- guards

  /**
   * Register sessionID→directory mapping + keeper detection from
   * session.created/updated events. Idempotent: session.updated fires many
   * times per session lifecycle, so registration + logging happen only on the
   * first observation of a given session ID.
   */
  observeSessionCreated(session: { id: string; directory?: string; title?: string }): void {
    if (session.directory) {
      this.sessionDirectories.set(session.id, session.directory);
      // Prune oldest entries when over cap (prevents unbounded growth on
      // long-lived servers — session.updated fires for every session).
      if (this.sessionDirectories.size > KeeperManager.MAX_SESSION_DIRECTORIES) {
        const excess = this.sessionDirectories.size - KeeperManager.MAX_SESSION_DIRECTORIES;
        let pruned = 0;
        for (const key of this.sessionDirectories.keys()) {
          if (pruned >= excess) break;
          this.sessionDirectories.delete(key);
          pruned++;
        }
      }
    }
    if (session.title?.startsWith(KEEPER_TITLE_PREFIX) && !this.spawned.has(session.id)) {
      this.spawned.add(session.id);
      plog("info", `[keeper] Registered spawned keeper session: ${session.id}`);
    }
  }

  /** Fast guard for event routing: is this one of our keepers? */
  isKeeperSessionFast(sessionID: string): boolean {
    return this.spawned.has(sessionID);
  }

  /** Slow guard: check the session's title via session.get (restart-safe fallback). */
  async isKeeperSession(sessionID: string): Promise<boolean> {
    if (this.spawned.has(sessionID)) return true;
    try {
      const res = await this.client.session.get({ path: { id: sessionID } });
      const title = res?.data?.title ?? "";
      if (title.startsWith(KEEPER_TITLE_PREFIX)) {
        this.spawned.add(sessionID);
        plog("info", `[keeper] Title-based keeper detection for ${sessionID}`);
        return true;
      }
    } catch (err) {
      plog("error", `[keeper] session.get failed for guard check: ${(err as Error).message}`);
    }
    return false;
  }

  isEnabled(): boolean {
    return this.config.keeper.enabled;
  }

  /** Directory known for a session (from events or session.get), else null. */
  async getSessionDirectory(sessionID: string): Promise<string | null> {
    const known = this.sessionDirectories.get(sessionID);
    if (known) return known;
    try {
      const res = await this.client.session.get({ path: { id: sessionID } });
      const dir = res?.data?.directory;
      if (dir) {
        this.sessionDirectories.set(sessionID, dir);
        return dir;
      }
    } catch {
      // leave null
    }
    return null;
  }

  // --------------------------------------------------------------- triggers

  private keeperParents = new Map<string, string>();
  private keeperProjects = new Map<string, string>();
  private harvestedUpTo = new Map<string, string>();

  /**
   * Entry point for session.idle events on main (non-keeper) sessions.
   * Debounced: coalesces idle bursts into one harvest after debounceMs.
   * manual/compaction modes never harvest on idle — their triggers are
   * spawnNow() / onSessionCompacted() respectively.
   */
  onMainSessionIdle(sessionID: string): void {
    const triggerMode = this.config.keeper.trigger.mode;
    if (triggerMode === "manual" || triggerMode === "compaction") return;
    if (this.running.has(sessionID)) {
      this.dirty.add(sessionID);
      plog("info", `[keeper] Idle during running harvest for ${sessionID} — marked dirty`);
      return;
    }
    const existing = this.timers.get(sessionID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionID);
      this.spawnKeeper(sessionID).catch((err) =>
        plog("error", `[keeper] Spawn failed for ${sessionID}: ${(err as Error).message}`)
      );
    }, this.config.keeper.trigger.debounceMs);
    this.timers.set(sessionID, timer);
    plog("info", `[keeper] Idle on ${sessionID} — harvest scheduled in ${this.config.keeper.trigger.debounceMs}ms`);
  }

  /** A keeper session we spawned just went idle = harvest complete. */
  async onKeeperIdle(keeperSessionID: string): Promise<void> {
    const parentID = this.keeperParents.get(keeperSessionID);
    const projectName = this.keeperProjects.get(keeperSessionID);
    this.keeperParents.delete(keeperSessionID);
    this.keeperProjects.delete(keeperSessionID);
    this.spawned.delete(keeperSessionID);

    const timeout = this.timeouts.get(keeperSessionID);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(keeperSessionID);
    }

    if (!parentID || !projectName) {
      plog("info", `[keeper] Keeper ${keeperSessionID} idle but no parent/project tracked — no checkpoint advanced`);
      return;
    }
    plog("info", `[keeper] Harvest complete for ${parentID} (keeper ${keeperSessionID})`);

    // Must precede the dirty-respawn below: it re-enters onMainSessionIdle,
    // which must see `running` empty or the respawn degrades to a dirty-mark.
    this.running.delete(parentID);
    plog("debug", `[keeper] running.delete(${parentID})`);

    // Advance checkpoint to the last message ID we handed to the keeper.
    const lastID = this.harvestedUpTo.get(keeperSessionID);
    this.harvestedUpTo.delete(keeperSessionID);
    if (lastID) {
      const state = this.loadProjectState(projectName);
      state.sessions[parentID] = { lastMessageID: lastID, harvested: true };
      this.saveProjectState(projectName, state);
      plog("info", `[keeper] Checkpoint advanced for ${parentID} → ${lastID}`);
    }

    if (this.config.keeper.deleteSessions) {
      try {
        await this.client.session.delete({ path: { id: keeperSessionID } });
        plog("info", `[keeper] Deleted keeper session ${keeperSessionID} (deleteSessions=true)`);
      } catch (err) {
        plog("error", `[keeper] Failed to delete keeper session: ${(err as Error).message}`);
      }
    }

    // Coalesced follow-up if new turns arrived while harvesting.
    if (this.dirty.has(parentID)) {
      this.dirty.delete(parentID);
      plog("info", `[keeper] Dirty flag set for ${parentID} — respawning harvest`);
      this.onMainSessionIdle(parentID);
    }
  }

  // -------------------------------------------------------------- spawning

  /**
   * Explicit, user-initiated harvest (memory tool `harvest` action). Bypasses
   * every trigger gate — the caller asked for it by name. Fails-closed errors
   * propagate to the caller.
   */
  spawnNow(sessionID: string): Promise<void> {
    return this.spawnKeeper(sessionID);
  }

  /**
   * compaction-trigger entry: harvest immediately after a session.compacted
   * event so knowledge the summary dropped gets rescued. No debounce —
   * compaction is already a rare, heavyweight event. No-ops in every other
   * trigger mode (those modes' contracts don't include compaction harvests).
   */
  async onSessionCompacted(sessionID: string): Promise<void> {
    if (this.config.keeper.trigger.mode !== "compaction") return;
    plog("info", `[keeper] session.compacted on ${sessionID} — harvest starting now`);
    await this.spawnNow(sessionID);
  }

  // --------------------------------------------------- message-level triggers

  /**
   * observeAssistantText: accumulate assistant message text from
   * message.part.updated events. ONLY active while idle+immediateOnTags is
   * on (the only consumer). Hard-capped: 8KB tail per message, 200 messages.
   */
  observeAssistantText(part: {
    messageID?: string;
    type?: string;
    text?: string;
    synthetic?: boolean;
  }): void {
    const trigger = this.config.keeper.trigger;
    if (!(trigger.mode === "idle" && trigger.immediateOnTags)) return;
    if (!part?.messageID || part.type !== "text") return;
    if (part.synthetic) return;
    if (typeof part.text !== "string" || part.text.length === 0) return;

    const prev = this.assistantTextBuffers.get(part.messageID) ?? "";
    const next = prev + part.text;
    this.assistantTextBuffers.set(
      part.messageID,
      next.length > 8000 ? next.slice(-8000) : next
    );
    if (this.assistantTextBuffers.size > 200) {
      const excess = this.assistantTextBuffers.size - 200;
      let pruned = 0;
      for (const key of this.assistantTextBuffers.keys()) {
        if (pruned >= excess) break;
        this.assistantTextBuffers.delete(key);
        pruned++;
      }
    }
  }

  /**
   * Entry point for message.updated events. Two consumers:
   * - always mode: every COMPLETED assistant message schedules a harvest
   *   behind the alwaysDebounceMs coalescing window.
   * - idle mode + immediateOnTags: a completed assistant message whose
   *   buffered text carries <mem> tags harvests immediately, cancelling any
   *   pending idle debounce (the explicit signal jumps the queue).
   * All other trigger modes ignore message events entirely. Our own keepers'
   * messages are always ignored (spawn-loop guard).
   */
  onAssistantMessageCompleted(info: {
    id?: string;
    sessionID?: string;
    role?: string;
    time?: { created?: number; completed?: number };
  }): void {
    const trigger = this.config.keeper.trigger;
    const alwaysOn = trigger.mode === "always";
    const immediateOn = trigger.mode === "idle" && trigger.immediateOnTags;
    if (!alwaysOn && !immediateOn) return;

    const sessionID = info?.sessionID;
    if (!sessionID) return;

    // Consume + free the text buffer regardless of the guards below (a
    // completed message will never stream more parts).
    const messageID = info?.id;
    const bufferedText = messageID
      ? this.assistantTextBuffers.get(messageID) ?? ""
      : "";
    if (messageID) this.assistantTextBuffers.delete(messageID);

    if (this.spawned.has(sessionID)) return; // spawn-loop guard
    if (info.role !== "assistant") return;
    if (!info.time?.completed) return; // streaming update, not a finished message

    if (alwaysOn) {
      this.scheduleAlwaysHarvest(sessionID);
      return;
    }

    // idle + immediateOnTags
    const tags = extractMemTags(bufferedText);
    if (tags.length === 0) return;
    if (this.running.has(sessionID)) {
      this.dirty.add(sessionID);
      plog("info", `[keeper] immediateOnTags during running harvest for ${sessionID} — marked dirty`);
      return;
    }
    const pending = this.timers.get(sessionID);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(sessionID);
    }
    plog("info", `[keeper] immediateOnTags: <mem> detected in ${sessionID} — harvesting immediately`);
    this.spawnKeeper(sessionID).catch((err) =>
      plog("error", `[keeper] immediateOnTags spawn failed for ${sessionID}: ${(err as Error).message}`)
    );
  }

  /** always-mode scheduling: per-session coalescing via alwaysDebounceMs. */
  private scheduleAlwaysHarvest(sessionID: string): void {
    if (this.running.has(sessionID)) {
      this.dirty.add(sessionID);
      plog("info", `[keeper] Message during running harvest for ${sessionID} — marked dirty`);
      return;
    }
    const existing = this.alwaysTimers.get(sessionID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.alwaysTimers.delete(sessionID);
      this.spawnKeeper(sessionID).catch((err) =>
        plog("error", `[keeper] Always-spawn failed for ${sessionID}: ${(err as Error).message}`)
      );
    }, this.config.keeper.trigger.alwaysDebounceMs);
    this.alwaysTimers.set(sessionID, timer);
    plog("info",
      `[keeper] Assistant message on ${sessionID} — always-harvest scheduled in ${this.config.keeper.trigger.alwaysDebounceMs}ms`
    );
  }

  private async spawnKeeper(sessionID: string): Promise<void> {
    const directory = await this.getSessionDirectory(sessionID);
    if (!directory || directoryIsHome(directory)) {
      plog("info", `[keeper] No usable directory for ${sessionID} — skipping harvest`);
      return;
    }
    const projectName = getProjectNameFromDirectory(directory);
    if (!projectName) {
      plog("info", `[keeper] No project name for ${directory} — skipping harvest`);
      return;
    }

    // Fetch the conversation and compute the delta since the last checkpoint.
    const msgsRes = await this.client.session.messages({ path: { id: sessionID } });
    const msgs = msgsRes?.data ?? [];
    const state = this.loadProjectState(projectName);
    const checkpoint = state.sessions[sessionID];
    const startIndex = checkpoint && checkpoint.harvested
      ? msgs.findIndex((m) => m.info.id === checkpoint.lastMessageID) + 1
      : 0;
    const delta = startIndex > 0 ? msgs.slice(startIndex) : msgs;
    const lastID = msgs.length > 0 ? msgs[msgs.length - 1].info.id : null;

    if (delta.length === 0 || !lastID) {
      plog("info", `[keeper] No new messages for ${sessionID} — nothing to harvest`);
      return;
    }
    const deltaTranscript = formatTranscript(delta);
    if (!deltaTranscript) {
      plog("info", `[keeper] Delta for ${sessionID} has no narrative text (tool-only) — skipping`);
      // Still advance checkpoint so tool-only turns don't accumulate.
      state.sessions[sessionID] = { lastMessageID: lastID, harvested: true };
      this.saveProjectState(projectName, state);
      return;
    }

    const trigger = this.config.keeper.trigger;
    const harvest = this.config.keeper.harvest;

    // <mem> tags extracted ONCE — reused by the tags gate, the minDeltaChars
    // exemption, and the tagsOnly scope. The prev-message tail closes the
    // checkpoint-boundary gap (tag opened before the checkpoint, closed here).
    const prevTail = startIndex > 0 ? messageTail(msgs[startIndex - 1]) : "";
    const memTags = extractMemTags(buildTagScanText(deltaTranscript, prevTail));

    // Trigger-mode gate (tags): spawn only when the delta carries <mem>
    // blocks — the main agent's explicit memory signals. With fallbackToIdle,
    // untagged deltas harvest on idle as a safety net. Either way the
    // checkpoint advances (no spawn → skip) so unprocessed deltas never
    // accumulate forever.
    if (trigger.mode === "tags" && memTags.length === 0 && !trigger.fallbackToIdle) {
      plog("info",
        `[keeper] Tags mode: delta for ${sessionID} has no <mem> tags — checkpoint advances without harvest`
      );
      state.sessions[sessionID] = { lastMessageID: lastID, harvested: true };
      this.saveProjectState(projectName, state);
      return;
    }

    // minDeltaChars guard: trivially small deltas are not worth a keeper run
    // — EXCEPT when the delta carries explicit <mem> signals (a small tag is
    // still worth harvesting). Checkpoint advances on skip.
    if (
      deltaTranscript.length < harvest.minDeltaChars &&
      memTags.length === 0 &&
      trigger.mode !== "manual"
    ) {
      plog("info",
        `[keeper] Delta for ${sessionID} below minDeltaChars (${deltaTranscript.length} < ${harvest.minDeltaChars}) — skipping`
      );
      state.sessions[sessionID] = { lastMessageID: lastID, harvested: true };
      this.saveProjectState(projectName, state);
      return;
    }

    // Phase 4: scope-based transcript selection.
    let transcript = deltaTranscript;
    const scope = harvest.scope;
    if (scope === "tagsOnly") {
      transcript = formatMemTags(memTags);
      if (!transcript) {
        // Defensive combo (e.g. idle + tagsOnly, nothing tagged): skip.
        plog("info",
          `[keeper] scope tagsOnly: no <mem> candidates for ${sessionID} — checkpoint advances without harvest`
        );
        state.sessions[sessionID] = { lastMessageID: lastID, harvested: true };
        this.saveProjectState(projectName, state);
        return;
      }
    } else if (scope === "full") {
      // Whole session from message 0 — the keeper can correct older entries.
      transcript = formatTranscript(msgs);
    }

    // Transcript cap (huge sessions can exceed it in any scope).
    transcript = capTranscript(transcript, harvest.maxTranscriptChars);

    const indexSection = this.indexProvider(projectName);
    if (indexSection === null) {
      plog("error", `[keeper] No memory index available for ${projectName} — skipping harvest`);
      return;
    }
    const system = buildKeeperPrompt(projectName, indexSection, scope);
    const tools = await this.buildToolsBlocklist(directory);

    this.running.add(sessionID);
    try {
      const created = await this.client.session.create({
        body: {
          parentID: sessionID,
          title: `${KEEPER_TITLE_PREFIX} ${new Date().toISOString().slice(0, 19)}`,
        },
        query: { directory },
      });
      const keeperID = created?.data?.id;
      if (!keeperID) throw new Error("session.create returned no id");
      this.spawned.add(keeperID);
      this.keeperParents.set(keeperID, sessionID);
      this.keeperProjects.set(keeperID, projectName);
      this.harvestedUpTo.set(keeperID, lastID);

      const partsLabel =
        scope === "tagsOnly"
          ? `Memory candidates to harvest (project: ${projectName}):\n\n${transcript}`
          : scope === "full"
          ? `Full conversation transcript to harvest (project: ${projectName}):\n\n${transcript}`
          : `Conversation delta to harvest (project: ${projectName}):\n\n${transcript}`;
      const body: {
        parts: Array<{ type: "text"; text: string }>;
        system: string;
        tools: Record<string, boolean>;
        model?: { providerID: string; modelID: string };
      } = {
        parts: [{ type: "text", text: partsLabel }],
        system,
        tools,
      };
      if (this.config.keeper.model) body.model = this.config.keeper.model;

      await this.client.session.promptAsync({ path: { id: keeperID }, body });
      plog("info",
        `[keeper] Spawned harvest: main=${sessionID} keeper=${keeperID} deltaMessages=${delta.length} transcriptChars=${transcript.length}`
      );

      // Completion watchdog: if the keeper never idles within 5 minutes, abandon it.
      const timeout = setTimeout(() => {
        plog("error", `[keeper] Harvest for ${sessionID} timed out — abandoning (checkpoint NOT advanced; next idle retries)`);
        this.running.delete(sessionID);
        this.keeperParents.delete(keeperID);
        this.keeperProjects.delete(keeperID);
        this.harvestedUpTo.delete(keeperID);
        this.timeouts.delete(keeperID);
        this.spawned.delete(keeperID);
      }, KEEPER_TIMEOUT_MS);
      this.timeouts.set(keeperID, timeout);
    } catch (err) {
      this.running.delete(sessionID);
      throw err;
    }
  }

  /**
   * Verified semantics (v1.18.27): the `tools` body param can only DISABLE —
   * unspecified tools stay enabled (blocklist, not whitelist). So enumerate
   * every tool and disable all except `memory`.
   *
   * Enumeration order:
   * 1. `tool.ids` — lists every builtin AND dynamically registered tool id
   *    without needing a provider/model; the only path that can seal the
   *    sandbox against tools added later by other plugins (MCP).
   * 2. `tool.list` fallback — requires provider+model (config.model).
   * 3. Fail-closed: if an enumeration path was AVAILABLE but yielded no tool
   *    ids, the sandbox cannot be sealed (hardcoded negatives can never cover
   *    dynamic MCP tools — the exact delegate-escape class), so we throw and
   *    spawnKeeper aborts BEFORE session.create / running.add. Next idle
   *    retries.
   * 4. If NO enumeration is possible (no tool domain / no model — legacy
   *    clients and plain fakes), return the best-effort hardcoded map.
   */
  private async buildToolsBlocklist(directory: string): Promise<Record<string, boolean>> {
    const tools: Record<string, boolean> = {};
    let enumerationAttempted = false;

    // 1. Preferred: tool.ids (no provider/model needed).
    if (this.client.tool?.ids) {
      enumerationAttempted = true;
      try {
        const res = await this.client.tool.ids({ query: { directory } });
        for (const id of res?.data ?? []) {
          if (id) tools[id] = id === "memory";
        }
      } catch (err) {
        plog("warn", `[keeper] tool.ids failed: ${(err as Error).message}`);
      }
      if (Object.keys(tools).length > 0) {
        for (const danger of HARDCODED_TOOL_NEGATIVES) tools[danger] = false;
        tools["memory"] = true;
        plog("info", `[keeper] Tools map sealed via tool.ids: ${Object.keys(tools).length} entries, memory=true`);
        return tools;
      }
    }

    // 2. Fallback: tool.list (requires provider+model).
    if (this.client.tool?.list && this.config.keeper.model) {
      enumerationAttempted = true;
      try {
        const res = await this.client.tool.list({
          query: { provider: this.config.keeper.model.providerID, model: this.config.keeper.model.modelID, directory },
        });
        for (const item of res?.data ?? []) {
          if (item.id) tools[item.id] = item.id === "memory";
        }
      } catch (err) {
        plog("warn", `[keeper] tool.list failed: ${(err as Error).message}`);
      }
      if (Object.keys(tools).length > 0) {
        for (const danger of HARDCODED_TOOL_NEGATIVES) tools[danger] = false;
        tools["memory"] = true;
        plog("info", `[keeper] Tools map built via tool.list: ${Object.keys(tools).length} entries, memory=true`);
        return tools;
      }
    }

    // 3. Fail-closed: enumeration was possible but yielded nothing.
    if (enumerationAttempted) {
      plog("error", "[keeper] Tool enumeration failed — aborting harvest (fail-closed)");
      throw new Error("fail-closed: tool enumeration yielded no tool ids");
    }

    // 4. Legacy best-effort: no enumeration available at all.
    for (const danger of HARDCODED_TOOL_NEGATIVES) tools[danger] = false;
    tools["memory"] = true;
    plog("info", `[keeper] Tools map built: ${Object.keys(tools).length} entries, memory=true`);
    return tools;
  }

  // --------------------------------------------------------------- sweeper

  /**
   * Startup recovery: harvest unharvested tails of past sessions (sessions
   * whose checkpoint is missing or not fully harvested). Requires a
   * session.list function on the client; silently skips when unavailable.
   */
  async sweepUnharvested(listSessions: () => Promise<Array<{ id: string; directory?: string; title?: string }>>): Promise<void> {
    if (!this.config.keeper.enabled || this.config.keeper.sweeperMax <= 0) return;
    // Sweeper honors the trigger-mode contract: only idle/always harvest
    // untagged session tails. In tags mode a blind sweep would harvest
    // untagged content (violating the mode), and manual/compaction have
    // their own explicit entry points.
    const SWEEPABLE_MODES = new Set(["idle", "always"]);
    if (!SWEEPABLE_MODES.has(this.config.keeper.trigger.mode)) {
      plog("info", `[keeper] Sweeper: disabled in trigger mode '${this.config.keeper.trigger.mode}'`);
      return;
    }
    try {
      const sessions = await listSessions();
      let swept = 0;
      for (const s of sessions) {
        if (swept >= this.config.keeper.sweeperMax) break;
        if (!s.directory) {
          plog("debug", `[keeper] Sweeper: skip-no-directory ${s.id}`);
          continue;
        }
        if (directoryIsHome(s.directory)) {
          plog("debug", `[keeper] Sweeper: skip-home ${s.id}`);
          continue;
        }
        if (this.isKeeperSessionFast(s.id)) {
          plog("debug", `[keeper] Sweeper: skip-keeper-fast ${s.id}`);
          continue;
        }
        // Restart-safe keeper detection: old keeper sessions from previous
        // server runs are not in the in-memory `spawned` set, but their title
        // still carries the prefix (title comes from session.list data — no
        // extra API calls).
        if (s.title?.startsWith(KEEPER_TITLE_PREFIX)) {
          plog("debug", `[keeper] Sweeper: skip-keeper-title ${s.id}`);
          continue;
        }
        const projectName = getProjectNameFromDirectory(s.directory);
        if (!projectName) {
          plog("debug", `[keeper] Sweeper: skip-no-project ${s.id}`);
          continue;
        }
        const state = this.loadProjectState(projectName);
        const cp = state.sessions[s.id];
        if (cp && cp.harvested) {
          plog("debug", `[keeper] Sweeper: skip-already-harvested ${s.id}`);
          continue;
        }
        plog("info", `[keeper] Sweeper: swept — harvesting tail of past session ${s.id} (${projectName})`);
        this.onMainSessionIdle(s.id);
        swept++;
      }
      if (swept === 0) plog("info", `[keeper] Sweeper: no unharvested session tails found`);
    } catch (err) {
      plog("error", `[keeper] Sweeper failed: ${(err as Error).message}`);
    }
  }

  /**
   * Single-writer guard for the memory tool: when the keeper is enabled,
   * write/edit/delete on project targets are only allowed from keeper
   * sessions. Returns null when allowed, or a rejection message.
   */
  checkWriteAccess(sessionID: string, target: string): string | null {
    if (!this.config.keeper.enabled) return null;
    if (!["project", "corrections", "environment"].includes(target)) return null;
    if (this.spawned.has(sessionID)) return null;
    return [
      `Write access to "${target}" is reserved for the memory-keeper.`,
      `You cannot modify project memory files directly.`,
      ``,
      `To have something remembered: include a short explanation (or a concise memory candidate) inside <mem></mem> tags in your reply.`,
      `The memory-keeper will read it, extract the key points, and write them to the correct file and heading.`,
      ``,
      `Reading is always allowed: use read/index/search freely.`,
    ].join("\n");
  }
}