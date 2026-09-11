// Isolated smoke-test suite for opencode-auto-mem (plain Node ESM, zero deps).
//
// ISOLATION CONTRACT (do not move these lines below any dist import):
// dist/config.js resolves the memory dir from os.homedir() (USERPROFILE on
// Windows) and dist/vector-store.js resolves index paths from getMemoryDir()
// at call time. The ESM cache makes env-override-before-import mandatory, so
// the very first executable lines redirect APPDATA + USERPROFILE to a fresh
// temp dir — every later dist import then resolves inside it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mem-test-"));
process.env.APPDATA = TEMP_ROOT;
process.env.USERPROFILE = TEMP_ROOT;
// Linux/macOS: os.homedir() reads HOME — redirect it too so the suite is
// platform-portable (CI runs the matrix on ubuntu-latest + windows-latest).
process.env.HOME = TEMP_ROOT;

// Windows: os.homedir() reads USERPROFILE per call (verified on Node 24).
assert.ok(
  path.resolve(os.homedir()).toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
  `homedir must follow redirected USERPROFILE (got ${os.homedir()})`
);

const dist = (name) => import(pathToFileURL(path.resolve("dist", name)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tiny test runner: collects results, prints PASS/FAIL lines, exit 1 on fail.
// ---------------------------------------------------------------------------
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL: ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n      ") : err}`);
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures (dist modules are loaded in main() before tests run)
// ---------------------------------------------------------------------------
let distConfig, distMemoryManager, distTimestampParser, distGit, distKeeper, distKeeperConfig;

// Real memory dir under the temp root (home\AppData\Roaming\opencode\memory).
const memoryDir = () => distConfig.getMemoryDir();

function makeMemoryManager() {
  const mm = new distMemoryManager.MemoryManager(distConfig.loadConfig());
  mm.ensureDirectories();
  return mm;
}

// Convert a flat legacy-style fixture config into the v2 ResolvedConfig shape
// via the real resolveConfig (legacy keeper.debounceMs maps to trigger.*).
function makeResolvedConfig(flat = {}) {
  return distKeeperConfig.resolveConfig({
    keeper: {
      enabled: flat.enabled,
      model: flat.model,
      deleteSessions: flat.deleteSessions,
      debounceMs: flat.debounceMs,
      sweeperMax: flat.sweeperMax,
      trigger: flat.trigger,
      harvest: flat.harvest,
    },
  });
}

// Fake KeeperClient: records every call, answers from canned data.
function makeFakeClient(messagesData) {
  const calls = { create: [], promptAsync: [], delete: [], get: [], messages: [] };
  let createCount = 0;
  return {
    calls,
    session: {
      get: async (args) => {
        calls.get.push(args);
        return { data: { directory: path.join(TEMP_ROOT, "fake-proj") } };
      },
      create: async (args) => {
        calls.create.push(args);
        createCount += 1;
        return { data: { id: `k${createCount}` } };
      },
      promptAsync: async (args) => {
        calls.promptAsync.push(args);
      },
      messages: async (args) => {
        calls.messages.push(args);
        return {
          data: messagesData ?? [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello, this user message carries enough narrative characters to pass the minDeltaChars guard" }] },
            { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "world — and this assistant reply also carries plenty of narrative text for the harvest fixtures" }] },
          ],
        };
      },
      delete: async (args) => {
        calls.delete.push(args);
      },
    },
  };
}

function makeKeeper(configOverrides = {}) {
  const client = makeFakeClient();
  const mm = makeMemoryManager();
  const keeper = new distKeeper.KeeperManager({
    config: makeResolvedConfig({
      enabled: true,
      deleteSessions: false,
      debounceMs: 10,
      sweeperMax: 3,
      ...configOverrides,
    }),
    client,
    memoryManager: mm,
    indexProvider: () => "## idx",
  });
  return { keeper, client, mm };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const tests = [
  ["env isolation: getMemoryDir() resolves under the temp dir", async () => {
    const dir = distConfig.getMemoryDir();
    assert.ok(
      dir.toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
      `getMemoryDir() must resolve under temp root, got ${dir}`
    );
    assert.ok(
      dir.toLowerCase().startsWith(path.join(os.tmpdir(), "mem-test-").toLowerCase()),
      `getMemoryDir() must resolve under os.tmpdir(), got ${dir}`
    );
  }],

  ["(a) findFirstTimestamp finds first ts + index points at comment", async () => {
    const content = "# Title\n\nIntro text.\n\n<!-- 2026-09-01 10:00:00 -->\n- fact A\n\n<!-- 2026-09-02 11:00:00 -->\n- fact B\n";
    const m = distTimestampParser.findFirstTimestamp(content);
    assert.ok(m, "expected a match");
    assert.equal(m[1], "2026-09-01 10:00:00");
    // index must point at the "<!--" of the FIRST comment, not a later one.
    assert.equal(content.slice(m.index, m.index + 4), "<!--");
    assert.ok(content.slice(m.index).startsWith("<!-- 2026-09-01"));
  }],

  ["(b) parseContentByTimestamp sees 2 entries", async () => {
    const content = "# Title\n\n<!-- 2026-09-01 10:00:00 -->\n- fact A\n\n<!-- 2026-09-02 11:00:00 -->\n- fact B\n";
    const entries = distTimestampParser.parseContentByTimestamp(content);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].timestamp, "2026-09-01 10:00:00");
    assert.ok(entries[0].content.includes("fact A"));
    assert.equal(entries[1].timestamp, "2026-09-02 11:00:00");
    assert.ok(entries[1].content.includes("fact B"));
  }],

  ["(c) deleteByTimestamp keeps preamble + other entries, drops target", async () => {
    const mm = makeMemoryManager();
    const filePath = mm.getMemoryPath();
    const preamble = "# MEMORY.md\n\n## Design Principles\n\n- Divide and conquer\n";
    const content =
      preamble +
      "\n<!-- 2026-09-01 10:00:00 -->\n- fact A\n\n<!-- 2026-09-02 11:00:00 -->\n- fact B\n";
    fs.writeFileSync(filePath, content, "utf-8");

    const result = await mm.deleteByTimestamp("memory", "2026-09-01 10:00:00");
    assert.match(result, /Deleted 1 entries? from MEMORY\.md/);

    const after = fs.readFileSync(filePath, "utf-8");
    assert.ok(after.includes("# MEMORY.md"), "preamble heading must survive");
    assert.ok(after.includes("Divide and conquer"), "preamble body must survive");
    assert.ok(after.includes("2026-09-02 11:00:00"), "kept entry ts must survive");
    assert.ok(after.includes("fact B"), "kept entry content must survive");
    assert.ok(!after.includes("fact A"), "deleted entry content must be gone");
    assert.ok(!after.includes("2026-09-01 10:00:00"), "deleted entry ts must be gone");
  }],

  ["(d) git concurrent-commit: 6 parallel gitCommit() → ≥1 commit, all files in HEAD", async () => {
    // No direct ensureGitRepo() here: test (c) leaves a fire-and-forget commit
    // in the chain, and a direct init could race it. The chained gitCommit
    // runs serialize behind it — the first one initializes the repo.
    // 6 distinct files written in parallel, each followed by a parallel commit.
    // gitCommit returns the serialized chain promise, so Promise.all waits
    // for every queued run — batching into ≥1 commit is the healthy path.
    const names = ["f1.md", "f2.md", "f3.md", "f4.md", "f5.md", "f6.md"];
    await Promise.all(
      names.map((n) => {
        fs.writeFileSync(path.join(memoryDir(), n), `content of ${n}\n`, "utf-8");
        return distGit.gitCommit(`Add ${n}`);
      })
    );
    await sleep(200); // let stderr from any failed run surface

    const log = await execFileAsync("git", ["-C", memoryDir(), "log", "--oneline"]);
    const commitCount = log.stdout.trim().split("\n").filter((l) => l.length > 0).length;
    assert.ok(commitCount >= 1, `expected ≥1 commit, got ${commitCount}`);
    assert.ok(!/index\.lock/i.test(String(log.stderr)), `no index.lock errors expected (stderr: ${log.stderr})`);

    const ls = await execFileAsync("git", ["-C", memoryDir(), "ls-files"]);
    const tracked = ls.stdout.split("\n");
    for (const n of names) {
      assert.ok(
        tracked.includes(n),
        `${n} must be tracked in HEAD (ls-files: ${tracked.join(", ")})`
      );
    }
    assert.ok(!fs.existsSync(path.join(memoryDir(), ".git", "index.lock")), "no index.lock residue");
  }],

  ["(e) .gitignore written by ensureGitRepo contains all artifact entries", async () => {
    // Repo exists by now (test d initialized it via the commit chain). A
    // direct ensureGitRepo() would race test (c)'s still-in-flight commit
    // (concurrent git init); instead drain the chain with a no-op commit —
    // the repo is initialized and .gitignore written by then.
    await distGit.gitCommit("probe");
    const gitignore = fs.readFileSync(path.join(memoryDir(), ".gitignore"), "utf-8");
    for (const entry of [
      "index-cache.json",
      "keeper-state.json",
      "keeper-config.json",
      "root.index/",
      "project.index/",
      "indexes/",
    ]) {
      assert.ok(
        gitignore.split("\n").includes(entry),
        `.gitignore must contain "${entry}" (got: ${JSON.stringify(gitignore)})`
      );
    }
  }],

  ["(f) observeSessionCreated idempotent: keeper-titled session logged once", async () => {
    const { keeper } = makeKeeper();
    const session = { id: "ses-keep-1", directory: "C:\\t\\proj", title: "[mem-keeper] 2026-09-05" };

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      keeper.observeSessionCreated(session);
      keeper.observeSessionCreated(session);
      keeper.observeSessionCreated(session);
    } finally {
      console.log = origLog;
    }

    const registrations = logs.filter((l) => l.includes("ses-keep-1"));
    assert.equal(registrations.length, 1, `expected exactly 1 registration log, got ${registrations.length}: ${JSON.stringify(logs)}`);
    // CONTAINS (not exact-format) so a later plog migration cannot break it.
    assert.ok(registrations[0].includes("Registered spawned keeper session"), "log must contain the registration message");
  }],

  ["(g) checkWriteAccess rejects main session on project targets, allows globals", async () => {
    const { keeper } = makeKeeper();
    // Main (non-keeper) session → project targets rejected.
    for (const target of ["project", "corrections", "environment"]) {
      const msg = keeper.checkWriteAccess("ses-main-1", target);
      assert.ok(msg !== null, `${target} must be rejected for a main session`);
      assert.ok(msg.includes("<mem></mem>"), "rejection must teach the <mem> protocol");
    }
    // Global targets always allowed.
    for (const target of ["memory", "identity", "user"]) {
      assert.equal(keeper.checkWriteAccess("ses-main-1", target), null, `${target} must be allowed`);
    }
    // Keeper sessions pass the guard on project targets.
    keeper.observeSessionCreated({ id: "ses-keep-9", title: "[mem-keeper] x" });
    assert.equal(keeper.checkWriteAccess("ses-keep-9", "project"), null, "keeper session must be allowed");
  }],

  ["(h) sweeper is a no-op when keeper disabled (no session.create calls)", async () => {
    const { keeper, client } = makeKeeper({ enabled: false });
    const listSessions = async () => [
      { id: "s1", directory: "C:\\t\\proj" },
      { id: "s2", directory: "C:\\t\\other" },
    ];
    await keeper.sweepUnharvested(listSessions);
    assert.equal(client.calls.create.length, 0, "disabled keeper must not create sessions");
    // Also no debounce timers armed (spawn path never reached).
    await sleep(50);
    assert.equal(client.calls.create.length, 0, "disabled keeper must stay silent after debounce window");
  }],

  ["(i) sweeper runs sweepUnharvested without touching live paths", async () => {
    const { keeper, client, mm } = makeKeeper({ enabled: true, debounceMs: 5 });
    // A past main session with no checkpoint → unharvested tail → sweep
    // routes it to onMainSessionIdle (debounced spawn). Directory is a fake
    // path inside the temp root.
    const fakeProjDir = path.join(TEMP_ROOT, "fake-proj");
    const listSessions = async () => [{ id: "old-main-1", directory: fakeProjDir }];
    await keeper.sweepUnharvested(listSessions);
    await sleep(100); // debounceMs=5 + spawn latency

    assert.ok(
      client.calls.create.length >= 1,
      `sweeper must spawn ≥1 harvest session (got ${client.calls.create.length})`
    );
    const createCall = client.calls.create[0];
    assert.equal(createCall.query.directory, fakeProjDir, "spawn must target the session's own directory");
    assert.ok(createCall.body.title.startsWith("[mem-keeper]"), "spawn title must carry the keeper prefix");
    assert.ok(client.calls.promptAsync.length >= 1, "spawn must promptAsync the keeper session");
    assert.ok(
      client.calls.promptAsync[0].body.system.includes("memory-keeper"),
      "keeper prompt must be the system prompt"
    );
    assert.equal(
      client.calls.promptAsync[0].body.tools["memory"],
      true,
      "tools map must enable memory"
    );

    // All keeper state writes stayed inside the temp memory dir.
    const statePath = path.join(mm.getProjectFolder("fake-proj"), "keeper-state.json");
    assert.ok(
      statePath.toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
      `keeper-state.json must live under temp (got ${statePath})`
    );

    // Simulate keeper completion: clears the 5-min watchdog and advances the
    // checkpoint — then verify state landed in temp only.
    await keeper.onKeeperIdle("k1");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.sessions["old-main-1"].lastMessageID, "m2", "checkpoint must advance to last message");
    assert.equal(state.sessions["old-main-1"].harvested, true);
  }],

  // -------------------------------------------------------------------------
  // Logger (dual-sink plog) — module state is shared across these 4 tests,
  // so order matters: (log i) must run before any initPluginLogger call.
  // Each test imports dist/logger.js lazily so a missing module fails THIS
  // test, not the whole suite.
  // -------------------------------------------------------------------------
  ["(log i) plog before initPluginLogger never throws, console sink fires", async () => {
    const distLogger = await dist("logger.js");
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      // Must not throw even though no client was ever initialized.
      distLogger.plog("info", "[keeper] before any init");
    } finally {
      console.log = origLog;
    }
    assert.ok(
      logs.some((l) => l.includes("[keeper] before any init")),
      `console sink must fire pre-init (captured: ${JSON.stringify(logs)})`
    );
  }],

  ["(log ii) after init, plog dispatches the exact body to app.log once, console stays SILENT", async () => {
    const distLogger = await dist("logger.js");
    const recorded = [];
    distLogger.initPluginLogger({
      app: { log: async (args) => { recorded.push(args); } },
    });

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      distLogger.plog("info", "[keeper] x", { k: 1 });
    } finally {
      console.log = origLog;
    }
    await sleep(5); // fire-and-forget dispatch slack

    assert.equal(
      logs.filter((l) => l.includes("[keeper] x")).length,
      0,
      "console sink must NOT fire when the app sink is armed (it garbles the TUI)"
    );
    assert.deepEqual(
      recorded,
      [{ body: { service: "opencode-auto-mem", level: "info", message: "[keeper] x", extra: { k: 1 } } }],
      "app.log must receive exactly one call with the exact body"
    );
  }],

  ["(log iii) rejected app.log promise is swallowed (no console fallback)", async () => {
    const distLogger = await dist("logger.js");
    distLogger.initPluginLogger({
      app: { log: async () => { throw new Error("sink down"); } },
    });

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);

    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      distLogger.plog("warn", "[keeper] reject me");
      await sleep(20); // macrotask tick: an unhandled rejection would fire here
    } finally {
      console.warn = origWarn;
      process.removeListener("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, null, `rejected log() promise must be swallowed (got ${unhandled})`);
    assert.equal(
      warns.filter((w) => w.includes("[keeper] reject me")).length,
      0,
      "console sink must stay silent even when the app sink rejects (server log still records the send attempt)"
    );
  }],

  ["(log v) OPENCODE_AUTO_MEM_CONSOLE_LOG=1 forces the console sink back on", async () => {
    const distLogger = await dist("logger.js");
    distLogger.initPluginLogger({
      app: { log: async () => {} },
    });
    process.env.OPENCODE_AUTO_MEM_CONSOLE_LOG = "1";
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      distLogger.plog("info", "[keeper] escape hatch line");
    } finally {
      console.log = origLog;
      delete process.env.OPENCODE_AUTO_MEM_CONSOLE_LOG;
    }
    assert.ok(
      logs.some((l) => l.includes("[keeper] escape hatch line")),
      "escape-hatch env var must re-enable the console sink alongside the app sink"
    );
  }],

  ["(log iv) initPluginLogger(undefined) is a safe no-op", async () => {
    const distLogger = await dist("logger.js");
    const recorded = [];
    distLogger.initPluginLogger({ app: { log: async (args) => { recorded.push(args); } } });
    // Must not throw; leaves the logger console-only.
    distLogger.initPluginLogger(undefined);

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      distLogger.plog("debug", "[keeper] after undefined init");
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.some((l) => l.includes("[keeper] after undefined init")), "console sink must fire after undefined init");
    assert.equal(recorded.length, 0, "undefined init must leave no app domain armed");
  }],

  // -------------------------------------------------------------------------
  // Bug A — keeper one-shot: `running` must be cleared when a keeper session
  // completes its harvest (onKeeperIdle), so the NEXT idle on the same main
  // session spawns a NEW harvest. Pre-fix, `running` is never cleared on
  // completion → every later idle takes the dirty path → the keeper harvests
  // only the first turn ever.
  // -------------------------------------------------------------------------
  ["(j) Bug A: running cleared on harvest completion — every turn re-harvests", async () => {
    // Custom fake client: MUTABLE message list (closure) so harvest #2 sees a
    // fresh delta — a fixed 2-message fake would make the second harvest skip
    // for the RIGHT reason (empty delta) and produce a false green.
    const messages = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "turn one question" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "turn one answer" }] },
    ];
    const calls = { create: [] };
    let createCount = 0;
    const client = {
      session: {
        get: async () => ({ data: { directory: "C:\\t\\proj" } }),
        create: async (args) => {
          calls.create.push(args);
          createCount += 1;
          return { data: { id: `k${createCount}` } };
        },
        promptAsync: async () => {},
        messages: async () => ({ data: messages }),
        delete: async () => {},
      },
    };
    const mm = makeMemoryManager();
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, sweeperMax: 3 }),
      client,
      memoryManager: mm,
      indexProvider: () => "## idx",
    });

    // Harvest #1: sweeper routes the unharvested main1 to onMainSessionIdle
    // (public entry point) → debounced spawn of keeper k1 over delta [m1, m2].
    await keeper.sweepUnharvested(async () => [{ id: "main1", directory: "C:\\t\\proj" }]);
    await sleep(60);
    assert.equal(calls.create.length, 1, `harvest #1 must spawn exactly 1 keeper (got ${calls.create.length})`);

    // Keeper k1 completes → checkpoint advances to m2; `running` must clear.
    await keeper.onKeeperIdle("k1");

    // Turn 2 arrives (fresh delta m3) → idle on the SAME main session. This is
    // the production path for turn 2's session.idle event.
    messages.push({ info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "turn two question with additional narrative context so the delta passes the minDeltaChars guard" }] });
    keeper.onMainSessionIdle("main1");
    await sleep(60);
    // Pre-fix: running never cleared → idle marks dirty and returns → the
    // keeper harvests only the first turn ever (create stuck at 1).
    assert.equal(calls.create.length, 2, `harvest #2 must spawn a NEW keeper after completion (got ${calls.create.length})`);

    // Failure-mode QA: idle while k2's harvest is running → dirty marked, NO
    // spawn (create count static while running).
    messages.push({ info: { id: "m4", role: "user" }, parts: [{ type: "text", text: "turn three question with additional narrative context so the delta passes the minDeltaChars guard" }] });
    keeper.onMainSessionIdle("main1");
    await sleep(60);
    assert.equal(calls.create.length, 2, `idle during a running harvest must NOT spawn (got ${calls.create.length})`);

    // Dirty-respawn fires only AFTER onKeeperIdle: k2 completes → the coalesced
    // dirty flag respawns harvest #3 over delta [m4] as keeper k3.
    await keeper.onKeeperIdle("k2");
    await sleep(60);
    assert.equal(calls.create.length, 3, `dirty-respawn must spawn the coalesced harvest (got ${calls.create.length})`);

    // Cleanup: k3 completes → checkpoint at m4, no dirty left, watchdog cleared
    // (the final onKeeperIdle also disarms the 5-min timeout so the process
    // can exit).
    await keeper.onKeeperIdle("k3");
    const state = JSON.parse(
      fs.readFileSync(path.join(mm.getProjectFolder("proj"), "keeper-state.json"), "utf-8")
    );
    assert.equal(state.sessions["main1"].lastMessageID, "m4", "checkpoint must track the last harvested message");
    assert.equal(state.sessions["main1"].harvested, true);
  }],

  // -------------------------------------------------------------------------
  // Bug C — the startup sweeper must skip [mem-keeper]-titled sessions: old
  // keeper sessions from a previous server run get re-harvested at every
  // restart because the in-memory `spawned` set starts empty. Title comes
  // from session.list data (zero extra API calls, restart-safe). Every skip
  // decision must emit a plog line with the canonical vocabulary.
  // -------------------------------------------------------------------------
  ["(k) Bug C: sweeper skips keeper-titled sessions + logs every skip decision", async () => {
    const calls = { create: [] };
    let createCount = 0;
    const client = {
      session: {
        get: async () => ({ data: { directory: "C:\\t\\proj" } }),
        create: async (args) => {
          calls.create.push(args);
          createCount += 1;
          return { data: { id: `k${createCount}` } };
        },
        promptAsync: async () => {},
        messages: async () => ({
          data: [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello, this user message carries enough narrative characters to pass the minDeltaChars guard" }] },
            { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "world — and this assistant reply also carries plenty of narrative text for the harvest fixtures" }] },
          ],
        }),
        delete: async () => {},
      },
    };
    const mm = makeMemoryManager();
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5, sweeperMax: 5 }),
      client,
      memoryManager: mm,
      indexProvider: () => "## idx",
    });

    // fast-keeper: registered as one of OUR spawned keepers → skip-keeper-fast.
    keeper.observeSessionCreated({ id: "fast-keeper", title: "[mem-keeper] reg" });
    // done-main: pre-seeded harvested checkpoint → skip-already-harvested.
    const projFolder = mm.getProjectFolder("proj");
    fs.mkdirSync(projFolder, { recursive: true });
    fs.writeFileSync(
      path.join(projFolder, "keeper-state.json"),
      JSON.stringify({ sessions: { "done-main": { lastMessageID: "m0", harvested: true } } }),
      "utf-8"
    );

    // One candidate per skip class + the two sessions that decide the bug:
    // old-keeper (keeper-titled → must NEVER spawn) and main9 (must spawn).
    const listSessions = async () => [
      { id: "no-dir" },                                                    // skip-no-directory
      { id: "home-dir", directory: TEMP_ROOT },                            // skip-home
      { id: "fast-keeper", directory: "C:\\t\\proj" },                     // skip-keeper-fast
      { id: "old-keeper", directory: "C:\\t\\proj", title: "[mem-keeper] 2026-09-05" }, // skip-keeper-title
      { id: "no-proj", directory: "C:\\" },                                // skip-no-project
      { id: "done-main", directory: "C:\\t\\proj" },                       // skip-already-harvested
      { id: "main9", directory: "C:\\t\\proj" },                            // swept
    ];

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      await keeper.sweepUnharvested(listSessions);
      await sleep(150); // debounceMs=5 + spawn latency
    } finally {
      console.log = origLog;
    }

    // Core Bug C assertion: the keeper-titled session must NEVER be spawned
    // (pre-fix the `spawned` set is empty at startup → it was re-harvested).
    const oldKeeperCreates = calls.create.filter((c) => c.body?.parentID === "old-keeper");
    assert.equal(
      oldKeeperCreates.length, 0,
      `old-keeper must not be harvested (got ${oldKeeperCreates.length} creates)`
    );
    // Exactly one spawn, and it targets main9.
    assert.equal(
      calls.create.length, 1,
      `exactly one harvest spawn expected (got ${calls.create.length}: ${JSON.stringify(calls.create.map((c) => c.body?.parentID))})`
    );
    assert.equal(calls.create[0].body.parentID, "main9", "the single spawn must target main9");
    assert.ok(calls.create[0].body.title.startsWith("[mem-keeper]"), "spawn title must carry the keeper prefix");

    // Every skip decision is logged with its canonical vocabulary word.
    for (const word of [
      "skip-no-directory",
      "skip-home",
      "skip-keeper-fast",
      "skip-keeper-title",
      "skip-no-project",
      "skip-already-harvested",
      "swept",
    ]) {
      assert.ok(
        logs.some((l) => l.includes(word)),
        `expected a sweeper log line containing "${word}" (captured: ${JSON.stringify(logs)})`
      );
    }

    // Clear the watchdog for the spawned keeper (k1 = main9's harvest) and
    // prove old-keeper never gained a checkpoint.
    await keeper.onKeeperIdle("k1");
    const state = JSON.parse(fs.readFileSync(path.join(projFolder, "keeper-state.json"), "utf-8"));
    assert.equal(state.sessions["main9"].lastMessageID, "m2", "main9 checkpoint must advance");
    assert.equal(state.sessions["old-keeper"], undefined, "old-keeper must never gain a checkpoint");
  }],
  // -------------------------------------------------------------------------
  // (l) Contract: keeper prompt rule 1 mandates read-before-write. The index
  // shows headings only — the keeper must `read` a heading before writing
  // under it, skip semantically-identical entries, and prefer `edit` over
  // re-adding (live proof: the same fact was written twice by two keeper runs).
  // -------------------------------------------------------------------------
  ["(l) keeper prompt rule 1: mandatory read-before-write + no-redundancy", async () => {
    const { buildKeeperPrompt } = await dist("keeperPrompt.js");
    const prompt = buildKeeperPrompt("proj", "## idx");
    for (const fragment of [
      "`read` that heading first",
      "Before writing ANY entry",
      "duplicates are worse than gaps",
      "prefer `edit`",
    ]) {
      assert.ok(
        prompt.includes(fragment),
        `keeper prompt rule 1 must contain "${fragment}" (prompt rule 1: ${prompt.split("\n").find((l) => l.startsWith("1."))})`
      );
    }
  }],
  // -------------------------------------------------------------------------
  // (m) Bug B / T1: tool.ids-first enumeration seals the sandbox. The ids
  // response includes dynamic/MCP tools (delegate, github_*) that hardcoded
  // negatives can never cover; every enumerated id must be present with
  // memory=true and everything else false.
  // -------------------------------------------------------------------------
  ["(m) Bug B: tool.ids enumeration seals the blocklist (delegate/github locked)", async () => {
    const ids = ["bash", "edit", "delegate", "delegation_read", "memory", "github_create_or_update_file"];
    const calls = { create: [], promptAsync: [] };
    let createCount = 0;
    const client = {
      session: {
        get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
        create: async (args) => { calls.create.push(args); createCount += 1; return { data: { id: `k${createCount}` } }; },
        promptAsync: async (args) => { calls.promptAsync.push(args); },
        messages: async () => ({ data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello, this user message carries enough narrative characters to pass the minDeltaChars guard" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "world — and this assistant reply also carries plenty of narrative text for the harvest fixtures" }] },
        ] }),
        delete: async () => {},
      },
      tool: { ids: async () => ({ data: ids }) },
    };
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, sweeperMax: 3 }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    await keeper.sweepUnharvested(async () => [{ id: "main-t1", directory: path.join(TEMP_ROOT, "fake-proj") }]);
    await sleep(60);
    await keeper.onKeeperIdle("k1"); // clear watchdog

    assert.equal(calls.promptAsync.length, 1, "spawn must promptAsync once");
    const tools = calls.promptAsync[0].body.tools;
    assert.equal(tools["memory"], true, "memory must stay enabled");
    for (const id of ids) {
      assert.ok(id in tools, `enumerated id "${id}" must be present in the map`);
    }
    for (const id of ["bash", "edit", "delegate", "delegation_read", "github_create_or_update_file"]) {
      assert.equal(tools[id], false, `enumerated tool "${id}" must be disabled (blocklist semantics)`);
    }
  }],
  // -------------------------------------------------------------------------
  // (n) Bug B / T2: legacy fallback — no tool domain + no model. The hardcoded
  // negatives must include the extended delegate family, not just the old list.
  // -------------------------------------------------------------------------
  ["(n) Bug B: legacy fallback map carries extended hardcoded negatives", async () => {
    const calls = { create: [], promptAsync: [] };
    let createCount = 0;
    const client = {
      session: {
        get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
        create: async (args) => { calls.create.push(args); createCount += 1; return { data: { id: `k${createCount}` } }; },
        promptAsync: async (args) => { calls.promptAsync.push(args); },
        messages: async () => ({ data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello, this user message carries enough narrative characters to pass the minDeltaChars guard" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "world — and this assistant reply also carries plenty of narrative text for the harvest fixtures" }] },
        ] }),
        delete: async () => {},
      },
      // NO tool domain at all.
    };
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, sweeperMax: 3 }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    await keeper.sweepUnharvested(async () => [{ id: "main-t2", directory: path.join(TEMP_ROOT, "fake-proj") }]);
    await sleep(60);
    await keeper.onKeeperIdle("k1"); // clear watchdog

    assert.equal(calls.promptAsync.length, 1, "legacy path must still spawn");
    const tools = calls.promptAsync[0].body.tools;
    assert.equal(tools["memory"], true, "memory must stay enabled");
    for (const danger of [
      "bash", "edit", "write", "read", "grep", "glob", "list", "patch",
      "webfetch", "task", "kill", "todowrite", "todoread", "multiedit",
      "delegate", "delegation_read", "delegation_list",
      "background_output", "background_cancel", "killshell",
    ]) {
      assert.equal(tools[danger], false, `hardcoded negative "${danger}" must be false (got ${tools[danger]})`);
    }
  }],
  // -------------------------------------------------------------------------
  // (o) Bug B / T3: fail-closed — tool.ids exists but THROWS and no model is
  // configured. Enumeration was possible and failed, so the spawn must abort:
  // zero session.create calls, zero promptAsync, error logged.
  // -------------------------------------------------------------------------
  ["(o) Bug B: enumeration failure aborts the spawn fail-closed", async () => {
    const calls = { create: [], promptAsync: [] };
    const errs = [];
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    let client;
    try {
      client = {
        session: {
          get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
          create: async (args) => { calls.create.push(args); return { data: { id: "k1" } }; },
          promptAsync: async (args) => { calls.promptAsync.push(args); },
          messages: async () => ({ data: [
            { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hello, this single user message carries enough narrative characters to pass the minDeltaChars guard" }] },
          ] }),
          delete: async () => {},
        },
        tool: { ids: async () => { throw new Error("registry exploded"); } },
      };
      const keeper = new distKeeper.KeeperManager({
        config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, sweeperMax: 3 }),
        client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
      });
      await keeper.sweepUnharvested(async () => [{ id: "main-t3", directory: path.join(TEMP_ROOT, "fake-proj") }]);
      await sleep(60);
    } finally {
      console.error = origErr;
    }
    assert.equal(calls.create.length, 0, `fail-closed must abort the spawn (got ${calls.create.length} creates)`);
    assert.equal(calls.promptAsync.length, 0, "no prompt may reach a keeper session on fail-closed");
    assert.ok(
      errs.some((l) => l.includes("fail-closed")),
      `error log must mention fail-closed (captured: ${JSON.stringify(errs)})`
    );
  }],
  // -------------------------------------------------------------------------
  // (p) Bug E: project routing must be memory-dir-relative (segment check),
  // not a "/project/" substring probe — the substring check missed every
  // Windows backslash path AND false-positived on project-named ancestors.
  // -------------------------------------------------------------------------
  ["(p) Bug E: isProjectFilePath routes by memory-dir-relative first segment", async () => {
    const { isProjectFilePath, getProjectNameForFile } = await dist("vector-store.js");
    const memDir = distConfig.getMemoryDir();
    assert.equal(
      isProjectFilePath(path.join(memDir, "project", "proj1", "project.md")),
      true,
      "a file under <memoryDir>\\project must route to the project index"
    );
    assert.equal(
      isProjectFilePath(path.join(memDir, "MEMORY.md")),
      false,
      "a root memory file must stay in the root index"
    );
    // Forward-slash path with a project-named ANCESTOR — the old substring
    // probe (`includes("/project/")`) mis-routed this to the project index.
    const ancestorTrap = path.join(TEMP_ROOT, "project", "sub", "MEMORY.md").replace(/\\/g, "/");
    assert.equal(
      isProjectFilePath(ancestorTrap),
      false,
      "a project-named ancestor outside the memory dir must not mis-route"
    );
    // Project-name derivation for per-project index routing (2.4.0).
    assert.equal(
      getProjectNameForFile(path.join(memDir, "project", "proj1", "project.md")),
      "proj1",
      "project files must resolve to their project folder name"
    );
    assert.equal(
      getProjectNameForFile(path.join(memDir, "MEMORY.md")),
      null,
      "root files must resolve to no project"
    );
  }],

  // -------------------------------------------------------------------------
  // (q) Bug E: purgeFileFromIndex removes only matching-filePath items, and
  // upsertFile self-heals mis-filed chunks out of the ROOT index. 2.4.0:
  // per-project indexes (<memoryDir>/indexes/projects/<name>/) — cross-PROJECT
  // mis-filing is impossible by construction; only root heal remains. Seeded
  // directly via vectra with dummy vectors — no model load, offline suite.
  // -------------------------------------------------------------------------
  ["(q) Bug E: purge + self-healing root cleanup on upsert (per-project indexes)", async () => {
    const distVector = await dist("vector-store.js");
    const { LocalIndex } = await import("vectra");
    const memDir = distConfig.getMemoryDir();
    // Must live under <memDir>\project for routing to classify it as project.
    const projectFilePath = path.join(memDir, "project", "fake-proj", "project.md");
    const projIndexPath = path.join(memDir, "indexes", "projects", "fake-proj");
    const rootIdxPath = path.join(memDir, "indexes", "root");

    // Seed the per-project index: two chunks of project.md + one of corrections.md.
    const seeder = new LocalIndex(projIndexPath);
    if (!(await seeder.isIndexCreated())) await seeder.createIndex();
    await seeder.insertItem({ vector: [0.1, 0.2, 0.3], metadata: { filePath: projectFilePath, heading: "Facts", text: "a", chunkHash: "h1" } });
    await seeder.insertItem({ vector: [0.4, 0.5, 0.6], metadata: { filePath: "C:\\t\\proj\\corrections.md", heading: "Corrections", text: "b", chunkHash: "h2" } });
    await seeder.insertItem({ vector: [0.7, 0.8, 0.9], metadata: { filePath: projectFilePath, heading: "Facts", text: "c", chunkHash: "h3" } });

    await distVector.purgeFileFromIndex(projIndexPath, projectFilePath);

    // Fresh instance reads from disk — avoids vectra in-memory caching.
    const verifier = new LocalIndex(projIndexPath);
    const afterPurge = await verifier.listItems();
    assert.deepEqual(
      afterPurge.map((i) => `${i.metadata.filePath}#${i.metadata.chunkHash}`).sort(),
      ["C:\\t\\proj\\corrections.md#h2"],
      "purge must remove only project.md items, keeping corrections.md"
    );

    // Self-heal: seed the ROOT index with a mis-filed project-file chunk, then
    // an upsertFile with EMPTY chunks (no embedding) must purge it from root.
    // closeIndexes() drops the dist module's cached LocalIndex instances —
    // the cached instances predate this seeding and vectra instances don't
    // re-read disk. This simulates the real cross-restart heal boundary: the
    // mis-filing and the heal are always separated by a plugin restart.
    const rootSeeder = new LocalIndex(rootIdxPath);
    if (!(await rootSeeder.isIndexCreated())) await rootSeeder.createIndex();
    await rootSeeder.insertItem({ vector: [0.2, 0.4, 0.6], metadata: { filePath: projectFilePath, heading: "Facts", text: "stale", chunkHash: "h9" } });
    await distVector.closeIndexes();

    await distVector.upsertFile(projectFilePath, []);

    const rootVerifier = new LocalIndex(rootIdxPath);
    const rootItems = await rootVerifier.listItems();
    assert.equal(
      rootItems.filter((i) => i.metadata.filePath === projectFilePath).length,
      0,
      "upsert must purge the mis-filed chunk from the root index (self-heal)"
    );
  }],
  // -------------------------------------------------------------------------
  // (r) Search timestamps must come from the CHUNK's own first timestamp
  // comment, not the FILE's first timestamp (the old per-result file re-read
  // stamped every result with project.md's oldest ts — misleading).
  // -------------------------------------------------------------------------
  ["(r) search: timestampForChunk reads the chunk's own timestamp", async () => {
    const mm = makeMemoryManager();
    assert.equal(
      mm.timestampForChunk("<!-- 2026-09-01 10:00:00 -->\nfact A"),
      "2026-09-01 10:00:00",
      "a chunk with its own ts comment must yield that ts"
    );
    assert.equal(
      mm.timestampForChunk("no ts here"),
      undefined,
      "a chunk without a ts comment must yield undefined (renders [no timestamp])"
    );
  }],
  // -------------------------------------------------------------------------
  // (s) `list` must aggregate timestamps across ALL .md files in a project
  // folder (deduped, descending) — pre-fix it only read the FIRST file, so
  // folders with multiple files showed "1 entries" of stale data.
  // -------------------------------------------------------------------------
  ["(s) list aggregates timestamps across all project-folder files", async () => {
    const mm = makeMemoryManager();
    const folder = mm.getProjectFolder("multi");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "project.md"), "# P\n\n<!-- 2026-09-01 10:00:00 -->\n- a\n", "utf-8");
    fs.writeFileSync(path.join(folder, "corrections.md"), "# C\n\n<!-- 2026-09-02 11:00:00 -->\n- b\n", "utf-8");
    fs.writeFileSync(path.join(folder, "environment.md"), "# E\n\n<!-- 2026-08-31 09:00:00 -->\n- c\n", "utf-8");

    const grouped = mm.listFilesGroupedByMonth();
    const entry = grouped.project.find((e) => e.name === "project/multi");
    assert.ok(entry, "project/multi entry must exist");
    assert.deepEqual(
      entry.timestamps,
      ["2026-09-02 11:00:00", "2026-09-01 10:00:00", "2026-08-31 09:00:00"],
      `project entry timestamps must be the deduped descending union of all 3 files (got ${JSON.stringify(entry.timestamps)})`
    );
    assert.equal(entry.timestamps.length, 3, "union count = 3 distinct timestamps");

    // Failure mode: empty folder → 0 entries, no crash.
    const emptyFolder = mm.getProjectFolder("empty");
    fs.mkdirSync(emptyFolder, { recursive: true });
    const emptyEntry = grouped.project.find((e) => e.name === "project/empty");
    // NOTE: grouped was computed BEFORE the empty folder existed — recompute.
    const grouped2 = mm.listFilesGroupedByMonth();
    const emptyEntry2 = grouped2.project.find((e) => e.name === "project/empty");
    assert.ok(emptyEntry2, "project/empty entry must exist");
    assert.deepEqual(emptyEntry2.timestamps, [], "empty folder → 0 entries, no crash");
  }],
  // -------------------------------------------------------------------------
  // (t) Section DELETE can leave an orphaned timestamp comment behind (its
  // entry text was removed but the <!-- ts --> stayed). stripOrphanTimestamps
  // removes a ts comment followed by only whitespace up to the next ts /
  // heading / EOF; a ts with following content is untouched.
  // -------------------------------------------------------------------------
  ["(t) stripOrphanTimestamps removes orphaned ts comments (delete path only)", async () => {
    const { stripOrphanTimestamps } = await dist("timestampParser.js");
    // Orphan: ts followed by only whitespace up to the next heading.
    assert.equal(
      stripOrphanTimestamps("## H\n\n<!-- 2026-09-01 10:00:00 -->\n\n## Next"),
      "## H\n\n## Next",
      "orphaned ts (nothing after it before next heading) must be removed"
    );
    // Orphan: ts followed by only whitespace up to EOF.
    assert.equal(
      stripOrphanTimestamps("## H\n\n<!-- 2026-09-01 10:00:00 -->\n\n"),
      "## H\n\n",
      "orphaned ts at EOF must be removed"
    );
    // Kept: ts with following content.
    assert.equal(
      stripOrphanTimestamps("## H\n\n<!-- 2026-09-01 10:00:00 -->\n- kept fact\n"),
      "## H\n\n<!-- 2026-09-01 10:00:00 -->\n- kept fact\n",
      "ts with following content must be preserved"
    );
    // Orphan: a ts whose region up to the NEXT ts holds only whitespace —
    // the plan's rule is literal: "ts followed by only whitespace up to next
    // ts/heading/EOF = orphan". The next ts (with content) survives.
    assert.equal(
      stripOrphanTimestamps("## H\n\n<!-- 2026-09-01 10:00:00 -->\n\n<!-- 2026-09-02 11:00:00 -->\n- b\n"),
      "## H\n\n<!-- 2026-09-02 11:00:00 -->\n- b\n",
      "a ts introducing no content before the next ts must be stripped; the content-bearing ts survives"
    );
    // Orphan pair: BOTH ts comments have no content at all (plan case: ts
    // followed by only whitespace up to next ts/heading/EOF = orphan).
    assert.equal(
      stripOrphanTimestamps("## H\n\n<!-- 2026-09-01 10:00:00 -->\n\n<!-- 2026-09-02 11:00:00 -->\n\n## Next"),
      "## H\n\n## Next",
      "a chain of content-less ts comments must be fully removed"
    );
  }],

  // -------------------------------------------------------------------------
  // (u) End-to-end: deleting an entry's text via editInSection with an EMPTY
  // newString (the section-delete path) must not leave the entry's ts
  // comment orphaned behind.
  // -------------------------------------------------------------------------
  ["(u) section delete leaves no orphan ts residue", async () => {
    const mm = makeMemoryManager();
    const filePath = mm.getProjectPath("orphan");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      "# Project Memory\n\n## Facts\n\n<!-- 2026-09-01 10:00:00 -->\n- only fact\n",
      "utf-8"
    );
    mm.editInSection("project", ["Project Memory", "Facts"], "- only fact", "", "orphan");
    const after = fs.readFileSync(filePath, "utf-8");
    assert.ok(
      !after.includes("2026-09-01 10:00:00"),
      `deleted entry's ts must not be orphaned (got: ${JSON.stringify(after)})`
    );
    assert.ok(after.includes("# Project Memory"), "doc heading must survive");
    assert.ok(after.includes("## Facts"), "section heading must survive");
  }],

  // -------------------------------------------------------------------------
  // Phase 1 — keeper-config v2: presets, per-knob validation, hot reload.
  // All tests lazily import dist/keeperConfig.js and reset the module's
  // mtime cache first (module state persists across tests in one process).
  // -------------------------------------------------------------------------
  ["(cfg1) mode:tags preset resolves trigger+scope, keeps indexing=search", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({ mode: "tags" });
    assert.equal(cfg.mode, "tags");
    assert.equal(cfg.keeper.trigger.mode, "tags");
    assert.equal(cfg.keeper.harvest.scope, "tagsOnly");
    assert.equal(cfg.indexing.trigger, "search", "tags preset must not change indexing");
    assert.equal(cfg.keeper.enabled, true, "preset must not disable keeper");
  }],

  ["(cfg2) mode:full preset resolves always+debouncedWrite", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({ mode: "full" });
    assert.equal(cfg.mode, "full");
    assert.equal(cfg.keeper.trigger.mode, "always");
    assert.equal(cfg.keeper.trigger.alwaysDebounceMs, 8000);
    assert.equal(cfg.indexing.trigger, "debouncedWrite");
  }],

  ["(cfg3) explicit knob overrides preset (tags mode, delta scope)", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({
      mode: "tags",
      keeper: { harvest: { scope: "delta" } },
    });
    assert.equal(cfg.mode, "tags");
    assert.equal(cfg.keeper.harvest.scope, "delta", "explicit knob must win over preset");
    assert.equal(cfg.keeper.trigger.mode, "tags", "preset still fills unset knobs");
  }],

  ["(cfg4) unknown preset warns and resolves balanced values", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const warns = [];
    const cfg = kc.resolveConfig({ mode: "yolo" }, (msg) => warns.push(msg));
    assert.equal(cfg.mode, "balanced");
    assert.equal(cfg.keeper.trigger.mode, "idle");
    assert.ok(
      warns.some((w) => /unknown mode/i.test(w)),
      `expected an unknown-mode warning, got: ${JSON.stringify(warns)}`
    );
  }],

  ["(cfg5) malformed JSON and missing file → balanced defaults, never throw", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    fs.mkdirSync(memoryDir(), { recursive: true });
    fs.writeFileSync(keeperConfigPath(), "{ this is not json", "utf-8");
    const bad = kc.loadKeeperConfig();
    assert.equal(bad.mode, "balanced");
    assert.equal(bad.keeper.trigger.mode, "idle");

    kc.__resetKeeperConfigCache();
    fs.rmSync(keeperConfigPath(), { force: true });
    const missing = kc.loadKeeperConfig();
    assert.equal(missing.mode, "balanced");
    assert.equal(missing.keeper.enabled, true);
  }],

  ["(cfg6) mode:offline → keeper off, indexing off, keyword fallback on, guard off", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({ mode: "offline" });
    assert.equal(cfg.keeper.enabled, false);
    assert.equal(cfg.indexing.enabled, false);
    assert.equal(cfg.indexing.keywordFallback, true);
    assert.equal(cfg.writeGuard, false);
  }],

  ["(cfg7) hot reload: file change → new values; same file → cached identity", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    writeKeeperConfig({ keeper: { trigger: { debounceMs: 1111 } } });
    const first = kc.loadKeeperConfig();
    assert.equal(first.keeper.trigger.debounceMs, 1111);

    await sleep(30); // mtime granularity
    writeKeeperConfig({ keeper: { trigger: { debounceMs: 222222 } } }); // different size too
    const second = kc.loadKeeperConfig();
    assert.equal(second.keeper.trigger.debounceMs, 222222, "mtime+size change must invalidate the cache");

    const third = kc.loadKeeperConfig();
    assert.equal(third, second, "unchanged file must return the cached instance");
  }],

  ["(cfg8) balanced default (empty object) matches today's behavior exactly", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({});
    assert.equal(cfg.mode, "balanced");
    assert.equal(cfg.keeper.enabled, true);
    assert.equal(cfg.keeper.deleteSessions, true);
    assert.equal(cfg.keeper.sweeperMax, 3);
    assert.equal(cfg.keeper.trigger.mode, "idle");
    assert.equal(cfg.keeper.trigger.debounceMs, 30000);
    assert.equal(cfg.keeper.trigger.immediateOnTags, false);
    assert.equal(cfg.keeper.trigger.fallbackToIdle, false);
    assert.equal(cfg.keeper.harvest.scope, "delta");
    assert.equal(cfg.keeper.harvest.maxTranscriptChars, 12000);
    assert.equal(cfg.keeper.harvest.minDeltaChars, 40);
    assert.equal(cfg.indexing.enabled, true);
    assert.equal(cfg.indexing.trigger, "search");
    assert.equal(cfg.indexing.writeDebounceMs, 300000);
    assert.equal(cfg.indexing.dtype, "int8");
    assert.equal(cfg.indexing.topK, 20);
    assert.equal(cfg.indexing.keywordFallback, true);
    assert.equal(cfg.writeGuard, true);
  }],

  ["(cfg9) per-knob validation: invalid values default, valid siblings preserved", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({
      keeper: {
        enabled: false, // valid — must survive
        trigger: { mode: 123, debounceMs: "x", alwaysDebounceMs: -3, immediateOnTags: "yes" },
        harvest: { scope: 42, minDeltaChars: -1 },
      },
      indexing: { dtype: 7, topK: 0, writeDebounceMs: -5, keywordFallback: "yes", trigger: "nope" },
      writeGuard: 7,
    });
    assert.equal(cfg.keeper.enabled, false, "valid sibling must survive");
    assert.equal(cfg.keeper.trigger.mode, "idle");
    assert.equal(cfg.keeper.trigger.debounceMs, 30000);
    assert.equal(cfg.keeper.trigger.alwaysDebounceMs, 8000);
    assert.equal(cfg.keeper.trigger.immediateOnTags, false);
    assert.equal(cfg.keeper.harvest.scope, "delta");
    assert.equal(cfg.keeper.harvest.minDeltaChars, 40);
    assert.equal(cfg.indexing.dtype, "int8");
    assert.equal(cfg.indexing.topK, 20);
    assert.equal(cfg.indexing.writeDebounceMs, 300000);
    assert.equal(cfg.indexing.keywordFallback, true);
    assert.equal(cfg.indexing.trigger, "search");
    assert.equal(cfg.writeGuard, true);
  }],

  ["(cfg10) legacy flat keys (keeper.debounceMs) still honored", async () => {
    const kc = await dist("keeperConfig.js");
    kc.__resetKeeperConfigCache();
    const cfg = kc.resolveConfig({
      keeper: { enabled: true, deleteSessions: false, debounceMs: 5000, sweeperMax: 1 },
    });
    assert.equal(cfg.keeper.trigger.debounceMs, 5000, "legacy keeper.debounceMs maps to trigger.debounceMs");
    assert.equal(cfg.keeper.sweeperMax, 1);
    assert.equal(cfg.keeper.deleteSessions, false);
    assert.equal(cfg.keeper.trigger.mode, "idle");
  }],

  // -------------------------------------------------------------------------
  // Phase 2 — trigger modes: tags / manual / compaction + fallbackToIdle +
  // sweeper gating + <mem> extraction + harvest action.
  // -------------------------------------------------------------------------
  ["(mt1) extractMemTags: single, multiple, unterminated, empty", async () => {
    const mt = await dist("memTags.js");
    const one = mt.extractMemTags("before\n<mem> save this fact </mem>\nafter");
    assert.equal(one.length, 1);
    assert.equal(one[0].tag, "save this fact");
    assert.ok(one[0].context.includes("before"), "context must include preceding lines");
    const multi = mt.extractMemTags("<mem>a</mem> middle <mem>b</mem>");
    assert.equal(multi.length, 2);
    assert.equal(multi[1].tag, "b");
    assert.equal(mt.extractMemTags("no tags here").length, 0);
    assert.equal(mt.extractMemTags("<mem>unterminated tag").length, 0);
    assert.equal(mt.extractMemTags("").length, 0);
    assert.equal(mt.extractMemTags("<mem></mem>").length, 0, "empty tag body is skipped");
  }],

  ["(mt2) buildTagScanText: tag split across the checkpoint boundary is found", async () => {
    const mt = await dist("memTags.js");
    assert.equal(mt.buildTagScanText("T", ""), "T", "no prevTail → transcript unchanged");
    const merged = mt.buildTagScanText("new text bar</mem>", "<mem>remember the foo");
    const found = mt.extractMemTags(merged);
    assert.equal(found.length, 1, "open tag in prev tail + close in delta must be found");
    assert.ok(found[0].tag.includes("remember the foo"), `tag must contain prev-tail part (got: ${JSON.stringify(found[0]?.tag)})`);
    assert.ok(found[0].tag.includes("new text bar"), "tag must contain delta part");
  }],

  ["(tag1) tags mode: delta WITH <mem> → spawn happens", async () => {
    const client = tagClient("Here is the fix explained. <mem> vectra routing uses path.relative segments </mem>");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "tags" } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainT1");
    await sleep(60);
    assert.equal(client.calls.create.length, 1, `tagged delta must spawn (got ${client.calls.create.length})`);
    assert.equal(client.calls.create[0].body.parentID, "mainT1");
    await keeper.onKeeperIdle("k1");
  }],

  ["(tag2) tags mode: delta WITHOUT tags → no spawn, checkpoint advances", async () => {
    const client = tagClient("plain answer with no tags at all");
    const mm = makeMemoryManager();
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "tags" } }),
      client, memoryManager: mm, indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainT2");
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "untagged delta must not spawn");
    assert.equal(client.calls.promptAsync.length, 0, "no prompt may reach any session");
    const statePath = path.join(mm.getProjectFolder("fake-proj"), "keeper-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.sessions["mainT2"].harvested, true, "checkpoint must advance without harvest");
    assert.equal(state.sessions["mainT2"].lastMessageID, "m2");
  }],

  ["(tag3) tags mode + fallbackToIdle: untagged delta still spawns", async () => {
    const client = tagClient("plain answer, no tags");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "tags", fallbackToIdle: true } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainT3");
    await sleep(60);
    assert.equal(client.calls.create.length, 1, "fallbackToIdle must harvest untagged deltas");
    await keeper.onKeeperIdle("k1");
  }],

  ["(man1) manual mode: idle events never spawn", async () => {
    const client = tagClient("<mem> tagged, but manual mode ignores idle </mem>");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "manual" } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainM1");
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "manual mode must not spawn on idle");
  }],

  ["(man2) manual mode: spawnNow spawns immediately", async () => {
    const client = tagClient("content to harvest on demand");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "manual" } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    await keeper.spawnNow("mainM2");
    assert.equal(client.calls.create.length, 1, "spawnNow must spawn");
    await keeper.onKeeperIdle("k1");
  }],

  ["(cmp1) compaction mode: idle no-op, onSessionCompacted spawns", async () => {
    const client = tagClient("content to rescue after compaction");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "compaction" } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainC1");
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "compaction mode must not spawn on idle");
    await keeper.onSessionCompacted("mainC1");
    assert.equal(client.calls.create.length, 1, "compaction event must spawn");
    await keeper.onKeeperIdle("k1");
  }],

  ["(sw2) sweeper disabled in tags mode", async () => {
    const client = tagClient("whatever");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, sweeperMax: 3, trigger: { mode: "tags" } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    await keeper.sweepUnharvested(async () => [{ id: "old1", directory: path.join(TEMP_ROOT, "fake-proj") }]);
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "sweeper must not spawn in tags mode");
  }],

  ["(act1) harvest action is a valid tool action", async () => {
    const v = await dist("validation.js");
    assert.doesNotThrow(() => v.validateAction("harvest"), "harvest must be a valid action");
  }],

  // -------------------------------------------------------------------------
  // Phase 3 — message-level triggers: always mode + immediateOnTags.
  // Entry point under test: keeper.onAssistantMessageCompleted(info) — the
  // event info shape is { id, sessionID, role, time: { completed? } } (no
  // parts — verified in SDK types.gen.d.ts; text arrives via
  // message.part.updated → keeper.observeAssistantText).
  // -------------------------------------------------------------------------
  ["(al1) always: 3 completed assistant messages → 1 coalesced spawn", async () => {
    const client = tagClient("content");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5000, trigger: { mode: "always", alwaysDebounceMs: 20 } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    for (let i = 1; i <= 3; i++) {
      keeper.onAssistantMessageCompleted({ id: `am${i}`, sessionID: "mainA", role: "assistant", time: { created: 1, completed: 2 } });
    }
    await sleep(80);
    assert.equal(client.calls.create.length, 1, `coalescing window must yield exactly 1 spawn (got ${client.calls.create.length})`);
    assert.equal(client.calls.create[0].body.parentID, "mainA");
    await keeper.onKeeperIdle("k1");
  }],

  ["(al2) always: streaming update (no time.completed) is ignored", async () => {
    const client = tagClient("content");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5000, trigger: { mode: "always", alwaysDebounceMs: 10 } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onAssistantMessageCompleted({ id: "amsgS", sessionID: "mainA", role: "assistant", time: { created: 1 } });
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "streaming updates must never schedule a harvest");
  }],

  ["(al3) always: keeper-session messages ignored (spawn-loop guard)", async () => {
    const client = tagClient("content");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5000, trigger: { mode: "always", alwaysDebounceMs: 10 } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.observeSessionCreated({ id: "k9", title: "[mem-keeper] reg" });
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "k9", role: "assistant", time: { created: 1, completed: 2 } });
    await sleep(50);
    assert.equal(client.calls.create.length, 0, "our own keepers' messages must never schedule a harvest");
  }],

  ["(al4) user-role messages and non-message modes are ignored", async () => {
    const client = tagClient("content");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5000, trigger: { mode: "always", alwaysDebounceMs: 10 } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "mainA", role: "user", time: { created: 1, completed: 2 } });
    await sleep(30);
    assert.equal(client.calls.create.length, 0, "user messages must not schedule a harvest");

    const compactionKeeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "compaction" } }),
      client: tagClient("x"), memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    compactionKeeper.onAssistantMessageCompleted({ id: "amsg2", sessionID: "mainB", role: "assistant", time: { created: 1, completed: 2 } });
    await sleep(30);
    assert.equal(client.calls.create.length, 0, "non-always/non-idle+tags modes must ignore message events");
  }],

  ["(al5) always: message during running harvest → dirty respawn after completion", async () => {
    // Growing messages fixture: the respawn must find NEW content (m3) that
    // arrived mid-harvest — a static transcript yields "nothing to harvest".
    const calls = { create: [], promptAsync: [] };
    let n = 0;
    const msgs = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "work session context for the always-mode harvest fixture" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "assistant answer with sufficient narrative length for the fixture" }] },
    ];
    const client = {
      session: {
        get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
        create: async (a) => { calls.create.push(a); n++; return { data: { id: `k${n}` } }; },
        promptAsync: async (a) => { calls.promptAsync.push(a); },
        messages: async () => ({ data: msgs }),
        delete: async () => {},
      },
    };
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 1, trigger: { mode: "always", alwaysDebounceMs: 10 } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    // NOTE: unique session ID "mainA5" — earlier tests (e.g. al1) persist
    // checkpoints for "mainA" in the shared temp keeper-state.json, which
    // would make this session's delta empty ("No new messages").
    keeper.onMainSessionIdle("mainA5");
    await sleep(50); // k1 spawned (debounce 1ms), running
    assert.equal(calls.create.length, 1, "first harvest must spawn");
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "mainA5", role: "assistant", time: { created: 1, completed: 2 } }); // → dirty
    msgs.push({ info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "new content mid-harvest with enough narrative characters for the guard" }] });
    await keeper.onKeeperIdle("k1"); // harvest completes → dirty respawn over [m3]
    await sleep(100);
    assert.equal(calls.create.length, 2, `dirty follow-up must respawn (got ${calls.create.length})`);
    await keeper.onKeeperIdle("k2");
  }],

  ["(iot1) immediateOnTags: tagged completion harvests NOW and cancels the idle timer", async () => {
    const client = tagClient("partial answer");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 50, trigger: { immediateOnTags: true } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainI1"); // arms the 50ms idle timer
    keeper.observeAssistantText({ messageID: "amsg1", type: "text", text: "fix explained <mem> remember the routing rule </mem>" });
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "mainI1", role: "assistant", time: { created: 1, completed: 2 } });
    await sleep(120);
    assert.equal(client.calls.create.length, 1, `immediate harvest must spawn exactly once — a second create means the idle timer was NOT cancelled (got ${client.calls.create.length})`);
    await keeper.onKeeperIdle("k1");
  }],

  ["(iot2) immediateOnTags: untagged message → no immediate spawn, idle timer still fires", async () => {
    const client = tagClient("plain text without any tags");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 50, trigger: { immediateOnTags: true } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainI2");
    keeper.observeAssistantText({ messageID: "amsg1", type: "text", text: "plain text without any tags" });
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "mainI2", role: "assistant", time: { created: 1, completed: 2 } });
    await sleep(150);
    assert.equal(client.calls.create.length, 1, "untagged delta must still harvest via the pending idle timer");
    await keeper.onKeeperIdle("k1");
  }],

  ["(iot3) immediateOnTags:false: tagged completion does NOT bypass the debounce", async () => {
    const client = tagClient("x");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({ enabled: true, deleteSessions: false, debounceMs: 5000, trigger: { immediateOnTags: false } }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainI3");
    keeper.observeAssistantText({ messageID: "amsg1", type: "text", text: "note <mem> tagged content </mem>" });
    keeper.onAssistantMessageCompleted({ id: "amsg1", sessionID: "mainI3", role: "assistant", time: { created: 1, completed: 2 } });
    await sleep(100);
    assert.equal(client.calls.create.length, 0, "feature off → tagged messages must wait for the idle debounce");
  }],

  // -------------------------------------------------------------------------
  // Phase 4 — harvest scopes (delta | tagsOnly | full) + transcript caps +
  // per-scope prompt variants.
  // -------------------------------------------------------------------------
  ["(s1) formatMemTags: excerpts only — untagged text excluded", async () => {
    const mt = await dist("memTags.js");
    const out = mt.formatMemTags([
      { tag: "a durable fact", context: "context line above\nmore context" },
      { tag: "second candidate", context: "other context" },
    ]);
    assert.ok(out.includes("[memory-candidate #1]"), "candidates must be numbered");
    assert.ok(out.includes("a durable fact"), "tag content must be present");
    assert.ok(out.includes("context line above"), "surrounding context must be present");
    assert.ok(out.includes("[memory-candidate #2]"), "all candidates rendered");
    assert.equal(mt.formatMemTags([]), "", "zero candidates → empty transcript");
  }],

  ["(s2) capTranscript: boundary exact (== max unchanged, > max truncated)", async () => {
    const kp = await dist("keeperPrompt.js");
    const exact = "x".repeat(500);
    assert.equal(kp.capTranscript(exact, 500), exact, "transcript exactly at cap must be unchanged");
    const over = "y".repeat(501);
    const capped = kp.capTranscript(over, 500);
    assert.ok(capped.startsWith("y".repeat(500)), "capped transcript must start with the allowed prefix");
    assert.ok(capped.includes("[...transcript truncated"), "truncation marker must be present");
    assert.ok(capped.length < 600, `capped transcript must stay near the cap (got ${capped.length})`);
    const short = kp.capTranscript("tiny", 500);
    assert.equal(short, "tiny", "short transcript must be unchanged");
  }],

  ["(s3) tags mode + scope tagsOnly: keeper receives ONLY tag excerpts", async () => {
    // Tag on its OWN line, with the untagged chatter 3+ lines above — the
    // 2-line context window legitimately includes adjacent lines, but the
    // distant chatter must be excluded.
    const client = tagClient(
      "untagged conversational chatter\nsecond line of chatter\nthird line of chatter\n<mem> remember the vectra rule </mem>"
    );
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "tags" }, harvest: { scope: "tagsOnly" },
      }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainTO");
    await sleep(60);
    assert.equal(client.calls.promptAsync.length, 1, "tagged delta must spawn");
    const text = client.calls.promptAsync[0].body.parts[0].text;
    const system = client.calls.promptAsync[0].body.system;
    assert.ok(text.includes("remember the vectra rule"), `tag excerpt must reach the keeper (got: ${text})`);
    assert.ok(!text.includes("untagged conversational chatter"), "untagged transcript must NOT reach a tagsOnly keeper");
    assert.ok(system.includes("MEMORY CANDIDATES"), "tagsOnly prompt variant must be used");
    await keeper.onKeeperIdle("k1");
  }],

  ["(s4) scope tagsOnly with zero tags (idle combo): skip + checkpoint advances", async () => {
    const client = tagClient("plain text, nothing tagged");
    const mm = makeMemoryManager();
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "idle" }, harvest: { scope: "tagsOnly" },
      }),
      client, memoryManager: mm, indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainTO4");
    await sleep(60);
    assert.equal(client.calls.create.length, 0, "tagsOnly with no tags must skip the spawn");
    const state = JSON.parse(fs.readFileSync(path.join(mm.getProjectFolder("fake-proj"), "keeper-state.json"), "utf-8"));
    assert.equal(state.sessions["mainTO4"].harvested, true, "checkpoint must advance");
    assert.equal(state.sessions["mainTO4"].lastMessageID, "m2");
  }],

  ["(s5) scope full: keeper sees the WHOLE session, even pre-checkpoint messages", async () => {
    const calls = { create: [], promptAsync: [] };
    let n = 0;
    const client = {
      session: {
        get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
        create: async (a) => { calls.create.push(a); n++; return { data: { id: `k${n}` } }; },
        promptAsync: async (a) => { calls.promptAsync.push(a); },
        messages: async () => ({ data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "early fact from message one" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "middle answer from message two" }] },
          { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "latest content from message three" }] },
        ] }),
        delete: async () => {},
      },
    };
    const mm = makeMemoryManager();
    // Pre-seed the checkpoint at m1 → delta would be [m2, m3]; full must include m1 anyway.
    const projFolder = mm.getProjectFolder("fake-proj");
    fs.mkdirSync(projFolder, { recursive: true });
    fs.writeFileSync(path.join(projFolder, "keeper-state.json"), JSON.stringify({
      sessions: { mainF: { lastMessageID: "m1", harvested: true } },
    }), "utf-8");
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "idle" }, harvest: { scope: "full" },
      }),
      client, memoryManager: mm, indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainF");
    await sleep(60);
    assert.equal(calls.promptAsync.length, 1, "full scope must spawn");
    const text = calls.promptAsync[0].body.parts[0].text;
    const system = calls.promptAsync[0].body.system;
    assert.ok(text.includes("early fact from message one"), `pre-checkpoint message must be included in full scope (got: ${text})`);
    assert.ok(text.includes("latest content from message three"), "latest message must be included");
    assert.ok(system.includes("FULL conversation transcript"), "full prompt variant must be used");
    await keeper.onKeeperIdle("k1");
  }],

  ["(s6) maxTranscriptChars integration: full scope transcript is capped", async () => {
    const calls = { create: [], promptAsync: [] };
    let n = 0;
    const filler = "filler sentence designed to exceed the cap quickly. ";
    const client = {
      session: {
        get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
        create: async (a) => { calls.create.push(a); n++; return { data: { id: `k${n}` } }; },
        promptAsync: async (a) => { calls.promptAsync.push(a); },
        messages: async () => ({ data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: filler.repeat(40) }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: filler.repeat(40) }] },
        ] }),
        delete: async () => {},
      },
    };
    const keeper = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "idle" }, harvest: { scope: "full", maxTranscriptChars: 1000 },
      }),
      client, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    keeper.onMainSessionIdle("mainFC");
    await sleep(60);
    assert.equal(calls.promptAsync.length, 1, "capped full-scope harvest must still spawn");
    const text = calls.promptAsync[0].body.parts[0].text;
    assert.ok(text.includes("[...transcript truncated"), "truncation marker must reach the keeper");
    assert.ok(text.length < 1500, `capped transcript must stay near maxTranscriptChars (got ${text.length})`);
    await keeper.onKeeperIdle("k1");
  }],

  ["(s7) minDeltaChars: trivially small deltas skip (untagged) but tagged deltas spawn", async () => {
    // Untagged small delta → skip + advance.
    const c1 = tagClient("tiny");
    const mm1 = makeMemoryManager();
    const k1 = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "idle" }, harvest: { minDeltaChars: 500 },
      }),
      client: c1, memoryManager: mm1, indexProvider: () => "## idx",
    });
    k1.onMainSessionIdle("mainMD1");
    await sleep(60);
    assert.equal(c1.calls.create.length, 0, "small untagged delta must skip");
    const st = JSON.parse(fs.readFileSync(path.join(mm1.getProjectFolder("fake-proj"), "keeper-state.json"), "utf-8"));
    assert.equal(st.sessions["mainMD1"].harvested, true, "skip must advance the checkpoint");

    // Tagged small delta → the explicit signal is precious: spawn anyway.
    const c2 = tagClient("tiny <mem> small but explicit </mem>");
    const k2 = new distKeeper.KeeperManager({
      config: makeResolvedConfig({
        enabled: true, deleteSessions: false, debounceMs: 1,
        trigger: { mode: "tags" }, harvest: { minDeltaChars: 500 },
      }),
      client: c2, memoryManager: makeMemoryManager(), indexProvider: () => "## idx",
    });
    k2.onMainSessionIdle("mainMD2");
    await sleep(60);
    assert.equal(c2.calls.create.length, 1, "tagged delta must spawn despite minDeltaChars");
    await k2.onKeeperIdle("k1");
  }],

  ["(s8) prompt variants: per-scope contract lines", async () => {
    const kp = await dist("keeperPrompt.js");
    const tagsOnly = kp.buildKeeperPrompt("p", "## idx", "tagsOnly");
    assert.ok(tagsOnly.includes("MEMORY CANDIDATES"), "tagsOnly variant must describe candidates");
    assert.ok(tagsOnly.includes("never lose a candidate"), "tagsOnly variant must mandate candidate preservation");
    const full = kp.buildKeeperPrompt("p", "## idx", "full");
    assert.ok(full.includes("FULL conversation transcript"), "full variant must describe the scope");
    assert.ok(full.includes("`edit` the existing entry"), "full variant must mandate edit-over-append for corrections");
    const delta = kp.buildKeeperPrompt("p", "## idx");
    assert.ok(delta.includes("newest unread part"), "default (delta) prompt must be unchanged");
    assert.ok(!delta.includes("MEMORY CANDIDATES"), "delta prompt must not leak variant text");
    // 2.4.1 hierarchy guidance: every variant teaches topical sub-heading
    // organization (the flat two-level-only prompt produced flat memory files
    // whose entire section is one search chunk — retrieval precision loss).
    assert.ok(delta.includes("sub-heading"), "delta prompt must teach sub-heading organization");
    assert.ok(delta.includes('"Audit Defects: agents/"'), "delta prompt must carry a three-level headingPath example");
    assert.ok(tagsOnly.includes("sub-heading"), "tagsOnly prompt must teach sub-heading routing");
    assert.ok(full.includes("Sub-topic"), "full prompt must carry a three-level example");
    assert.ok(delta.includes("~400 chars"), "entry-length cap must be present");
    assert.ok(delta.includes("ORGANIZE FOR RETRIEVAL"), "retrieval-oriented organization rule must be present");
    assert.ok(delta.includes("never nest deeper than H4"), "nesting cap must be present");
    assert.ok(full.includes("resolved Open Questions"), "full scope must mandate closing resolved questions");
  }],

  ["(s8b) no-keeper instructions: hierarchy guidance mirrors the keeper's", async () => {
    const mi = await dist("memoryInstructions.js");
    const nk = mi.MEMORY_AWARENESS_INSTRUCTIONS_NO_KEEPER;
    assert.ok(nk.includes("Organize with Sub-headings"), "no-keeper variant must teach sub-heading organization (main agent is the writer there)");
    assert.ok(nk.includes('"Build Commands"'), "no-keeper variant must carry a three-level headingPath example");
    assert.ok(nk.includes("~400 chars"), "no-keeper entry-length cap must be present");
    assert.ok(nk.includes("never nest deeper than H4"), "no-keeper nesting cap must be present");
    assert.ok(nk.includes("createMissing: true"), "no-keeper sub-heading creation must mention createMissing");
    // Keeper-mode instructions must stay signal-only: the KEEPER owns structure
    // and placement — the main agent only signals via <mem> tags there.
    assert.ok(
      !mi.MEMORY_AWARENESS_INSTRUCTIONS.includes("Organize with Sub-headings"),
      "keeper-mode instructions must NOT gain writer-structure guidance"
    );
  }],

  // -------------------------------------------------------------------------
  // Phase 5 — indexing modes (trigger: search|debouncedWrite|manual,
  // enabled: false) + keyword fallback + dtype/topK plumbing.
  // -------------------------------------------------------------------------
  ["(s9) indexMode plumbing: MemoryManager reads indexing config", async () => {
    const mm = makeMemoryManager();
    mm.configureIndexing({ enabled: true, trigger: "search", writeDebounceMs: 300000, keywordFallback: true, topK: 20, scope: "project" });
    mm.configureEmbedding("int8");
    // Smoke: no throw, state readable.
    assert.equal(mm.getIndexingConfig().trigger, "search");
    assert.equal(mm.getIndexingConfig().scope, "project", "scope knob must be stored");
  }],

  ["(s10) debouncedWrite: 5 rapid writes → exactly 1 refresh after quiet", async () => {
    const mm = makeMemoryManager();
    let refreshes = 0;
    mm.configureIndexing({ enabled: true, trigger: "debouncedWrite", writeDebounceMs: 60, keywordFallback: true, topK: 20 });
    mm.onIndexRefresh(() => { refreshes++; });
    for (let i = 0; i < 5; i++) {
      mm.writeFile(mm.getMemoryPath(), `# Memory\n\ndebug entry number ${i} with some text\n`);
    }
    await sleep(30);
    assert.equal(refreshes, 0, "no refresh while writes keep arriving within the window");
    await sleep(120);
    assert.equal(refreshes, 1, `exactly one coalesced refresh after quiet (got ${refreshes})`);
  }],

  ["(s11) debouncedWrite: no timer armed at construction (never at boot)", async () => {
    const mm = makeMemoryManager();
    let refreshes = 0;
    mm.configureIndexing({ enabled: true, trigger: "debouncedWrite", writeDebounceMs: 50, keywordFallback: true, topK: 20 });
    mm.onIndexRefresh(() => { refreshes++; });
    await sleep(120);
    assert.equal(refreshes, 0, "construction + config must not arm the refresh timer");
  }],

  ["(s12) trigger manual: search skips refresh; ensureIndexed stays callable", async () => {
    const mm = makeMemoryManager();
    let refreshes = 0;
    mm.configureIndexing({ enabled: true, trigger: "manual", writeDebounceMs: 50, keywordFallback: true, topK: 20 });
    mm.onIndexRefresh(() => { refreshes++; });
    mm.writeFile(mm.getMemoryPath(), "# Memory\n\ncontent for the manual-mode fixture\n");
    await sleep(120);
    assert.equal(refreshes, 0, "manual mode must not arm write-path timers");
    // Explicit ensureIndexed is allowed in manual mode (backs the reindex action).
    await mm.ensureIndexed();
    assert.ok(true, "ensureIndexed must not throw in manual mode");
  }],

  ["(s13) keywordSearch: ranked hits, scoped to the given project + root", async () => {
    const mm = makeMemoryManager();
    const p = mm.getProjectPath("kwproj");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "# Project Memory\n\n## Facts\n\n- vectra routing uses path.relative segments\n- database runs on postgres\n\n## Commands\n\n- npm run build compiles the plugin\n", "utf-8");
    // A SECOND project whose content ALSO matches — must NOT appear (scoping).
    const other = mm.getProjectPath("otherproj");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, "# Project Memory\n\n## Facts\n\n- vectra routing uses path.relative segments\n", "utf-8");

    const hits = await mm.keywordSearch("vectra path routing", 5, "kwproj");
    assert.ok(hits.length >= 1, `term-overlap query must return hits (got ${hits.length})`);
    assert.ok(hits[0].text.includes("vectra"), "top hit must be the overlapping chunk");
    assert.ok(hits[0].score > 0, "top hit must carry a positive score");
    assert.equal(hits[0].filePath, p);
    assert.ok(hits.every((h) => h.filePath === p), "scoped keyword search must never return other projects' chunks");
    const none = await mm.keywordSearch("zzzqqq", 5);
    assert.equal(none.length, 0, "no-overlap query must return zero hits");
  }],

  ["(s14) indexing disabled + keywordFallback: search works without embeddings", async () => {
    const mm = makeMemoryManager();
    const p = mm.getProjectPath("kwproj2");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "# Project Memory\n\n## Facts\n\n- the deploy target is the USERPROFILE config tree\n", "utf-8");
    mm.configureIndexing({ enabled: false, trigger: "search", writeDebounceMs: 300000, keywordFallback: true, topK: 20, scope: "project" });
    const hits = await mm.semanticSearch("USERPROFILE config deploy", 5, "kwproj2");
    assert.ok(hits.length >= 1, `keyword fallback must serve the search (got ${hits.length})`);
    assert.ok(hits[0].text.includes("USERPROFILE"));
  }],

  ["(s15) indexing disabled + keywordFallback:false → explicit disabled message", async () => {
    const mm = makeMemoryManager();
    mm.configureIndexing({ enabled: false, trigger: "search", writeDebounceMs: 300000, keywordFallback: false, topK: 20, scope: "project" });
    const hits = await mm.semanticSearch("anything", 5);
    assert.equal(hits.length, 1, "disabled search returns a single explanatory entry");
    assert.match(hits[0].text, /disabled/i);
  }],

  ["(s16) topK from config: results sliced to configured count", async () => {
    const mm = makeMemoryManager();
    mm.configureIndexing({ enabled: false, trigger: "search", writeDebounceMs: 300000, keywordFallback: true, topK: 1, scope: "project" });
    const p = mm.getProjectPath("kwproj3");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "# Project Memory\n\n## Facts\n\n- alpha fact\n- beta fact\n- gamma fact\n", "utf-8");
    const hits = await mm.semanticSearch("alpha beta gamma", 50, "kwproj3");
    assert.ok(hits.length <= 1, `topK=1 must slice keyword results (got ${hits.length})`);
  }],

  // -------------------------------------------------------------------------
  // 2.4.0 — project-scoped indexing & search: vector-store scope routing,
  // ensureIndexed scope, debouncedWrite dirty-scope refresh, orphan GC.
  // -------------------------------------------------------------------------
  ["(s18) vector-store scoping: search hits root + only the target project", async () => {
    const distVector = await dist("vector-store.js");
    const { LocalIndex } = await import("vectra");
    const memDir = distConfig.getMemoryDir();
    const seed = async (indexPath, filePath, text, vector) => {
      const idx = new LocalIndex(indexPath);
      if (!(await idx.isIndexCreated())) await idx.createIndex();
      await idx.insertItem({ vector, metadata: { filePath, heading: "H", text, chunkHash: `${filePath}:${text}` } });
    };
    const rootPath = path.join(memDir, "indexes", "root");
    const aPath = path.join(memDir, "indexes", "projects", "scopeA");
    const bPath = path.join(memDir, "indexes", "projects", "scopeB");
    await seed(rootPath, "ROOT.md", "global-root-fact", [1, 0, 0]);
    await seed(aPath, "A.md", "project-a-fact", [0, 1, 0]);
    await seed(bPath, "B.md", "project-b-fact", [0, 0, 1]);
    // Drop cached instances so the search re-reads the freshly seeded dirs.
    await distVector.closeIndexes();

    const query = [1, 1, 1];
    const scoped = await distVector.semanticSearch(query, 10, "scopeA", "project");
    const scopedFiles = scoped.map((r) => r.filePath);
    assert.ok(scopedFiles.includes("ROOT.md"), "root index must always participate");
    assert.ok(scopedFiles.includes("A.md"), "target project index must participate");
    assert.ok(!scopedFiles.includes("B.md"), "other projects must NOT participate in scoped search");

    const all = await distVector.semanticSearch(query, 10, null, "all");
    const allFiles = all.map((r) => r.filePath);
    assert.ok(allFiles.includes("A.md") && allFiles.includes("B.md"), "scope=all must span every project (legacy behavior)");

    const rootOnly = await distVector.semanticSearch(query, 10, null, "project");
    assert.deepEqual(rootOnly.map((r) => r.filePath), ["ROOT.md"], "no project → root index only");
  }],

  ["(s19) ensureIndexed scope: only root + the target project are indexed", async () => {
    const mm = makeMemoryManager();
    mm.configureIndexing({ enabled: true, trigger: "search", writeDebounceMs: 300000, keywordFallback: true, topK: 20, scope: "project" });
    const aPath = mm.getProjectPath("idxscope-a");
    const bPath = mm.getProjectPath("idxscope-b");
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    fs.mkdirSync(path.dirname(bPath), { recursive: true });
    fs.writeFileSync(aPath, "# Project Memory\n\n## Facts\n\n- alpha content for indexing scope test\n", "utf-8");
    fs.writeFileSync(bPath, "# Project Memory\n\n## Facts\n\n- beta content for indexing scope test\n", "utf-8");

    // Offline suite: embedText fails fast (no model), but upsertFile creates
    // the index dir BEFORE embedding — dir existence is the scope signal.
    await mm.ensureIndexed("idxscope-a");

    const memDir = distConfig.getMemoryDir();
    const projectsIdx = path.join(memDir, "indexes", "projects");
    assert.ok(fs.existsSync(path.join(memDir, "indexes", "root")), "root index must be created");
    assert.ok(fs.existsSync(path.join(projectsIdx, "idxscope-a")), "target project index must be created");
    assert.ok(!fs.existsSync(path.join(projectsIdx, "idxscope-b")), "unrelated project must NOT be indexed");
  }],

  ["(s20) debouncedWrite dirty scoping: project writes refresh only that project", async () => {
    const mm = makeMemoryManager();
    let refreshes = 0;
    mm.configureIndexing({ enabled: true, trigger: "debouncedWrite", writeDebounceMs: 50, keywordFallback: true, topK: 20, scope: "project" });
    mm.onIndexRefresh(() => { refreshes++; });
    const pPath = mm.getProjectPath("dirtyproj");
    fs.mkdirSync(path.dirname(pPath), { recursive: true });
    // Earlier tests (s18/s19) create the root index — remove it so this test
    // can prove that project-only writes never create a root index.
    fs.rmSync(path.join(distConfig.getMemoryDir(), "indexes", "root"), { recursive: true, force: true });
    mm.writeFile(pPath, "# Project Memory\n\n## Facts\n\n- dirty write one with some text\n");
    mm.writeFile(pPath, "# Project Memory\n\n## Facts\n\n- dirty write one with some text\n- dirty write two\n");
    await sleep(30);
    assert.equal(refreshes, 0, "no refresh while writes keep arriving within the window");
    await sleep(300);
    assert.equal(refreshes, 1, `exactly one coalesced refresh after quiet (got ${refreshes})`);
    const memDir = distConfig.getMemoryDir();
    assert.ok(fs.existsSync(path.join(memDir, "indexes", "projects", "dirtyproj")), "dirty project's index must be created");
    assert.ok(!fs.existsSync(path.join(memDir, "indexes", "root")), "root index must NOT be created when only project files were written");
  }],

  ["(s21) orphan GC: index dirs without a live project folder are removed", async () => {
    const distVector = await dist("vector-store.js");
    const memDir = distConfig.getMemoryDir();
    const ghost = path.join(memDir, "indexes", "projects", "ghost-project");
    const kept = path.join(memDir, "indexes", "projects", "realproj");
    fs.mkdirSync(ghost, { recursive: true });
    fs.mkdirSync(kept, { recursive: true });
    fs.mkdirSync(path.join(memDir, "project", "realproj"), { recursive: true });

    const removed = distVector.gcProjectIndexes(["realproj"]);
    assert.ok(removed >= 1, "at least the ghost index dir must be garbage-collected");
    assert.ok(!fs.existsSync(ghost), "ghost index must be gone");
    assert.ok(fs.existsSync(kept), "index with a live project folder must stay");
  }],

  ["(s17) dtype plumbing: configureEmbedding routes to embedding module state", async () => {
    const emb = await dist("embedding.js");
    emb.__resetEmbeddingForTests();
    const mm = makeMemoryManager();
    mm.configureEmbedding("fp32");
    assert.equal(emb.getActiveDtype(), "fp32", "fp32 must reach the embedding module");
    mm.configureEmbedding("int8");
    assert.equal(emb.getActiveDtype(), "int8", "int8 must reach the embedding module");
    assert.throws(() => mm.configureEmbedding("q8"), "invalid dtype must throw at the caller");
  }],

  ["(h1) embedding: import.meta.url cache path resolves under Node (no __dirname)", async () => {
    const emb = await dist("embedding.js");
    // Under plain Node ESM, ANY use of __dirname in dist/embedding.js throws
    // at call time. getModelCachePath() must be import.meta.url-derived so
    // this call — and every embed — works identically under Node and Bun.
    const p = emb.getModelCachePath();
    assert.equal(typeof p, "string", "getModelCachePath must return a string");
    assert.ok(path.isAbsolute(p), `cache path must be absolute (got ${p})`);
    assert.ok(
      p.toLowerCase().endsWith(".cache"),
      `cache path must end at the transformers .cache dir (got ${p})`
    );
    // And it must be import-derived: <pluginRoot>/../node_modules/@huggingface/transformers/.cache
    assert.ok(p.includes(path.join("@huggingface", "transformers", ".cache")));
  }],

  // -------------------------------------------------------------------------
  // (s22) indexing.enabled=false: the embedding pipeline must never run —
  // embedAllExistingFiles() and ensureIndexed() must not touch the index
  // (dir creation is the harness proxy for "the queue processed", see s19).
  // -------------------------------------------------------------------------
  ["(s22) indexing disabled: embedAllExistingFiles + ensureIndexed never load the model", async () => {
    const mm = makeMemoryManager();
    mm.configureIndexing({ enabled: false, trigger: "search", writeDebounceMs: 300000, keywordFallback: true, topK: 20, scope: "project" });
    const pPath = mm.getProjectPath("noindex-proj");
    fs.mkdirSync(path.dirname(pPath), { recursive: true });
    fs.writeFileSync(pPath, "# Project Memory\n\n## Facts\n\n- content that would normally be indexed\n", "utf-8");

    const memDir = distConfig.getMemoryDir();
    const indexesDir = path.join(memDir, "indexes");
    // Clean slate: earlier tests (s18/s19/s20) may have left index dirs.
    fs.rmSync(indexesDir, { recursive: true, force: true });

    // Both entry points that reach the embedding pipeline must no-op.
    await mm.ensureIndexed(null);
    mm.embedAllExistingFiles(null);
    // Force any REGRESSED queue to process: with the guard missing, the
    // queue would be non-empty and upsertFile would create the index dir
    // before the (offline-failing) embed. Guard present → queue empty →
    // drain resolves immediately without creating anything.
    await mm.embeddingQueue.drain();
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(
      !fs.existsSync(indexesDir),
      "no index dir may be created while indexing.enabled=false — the embedding model must never load"
    );
  }],

  // -------------------------------------------------------------------------
  // (s23) findMisplacedConfigFile: stray ~/.config/opencode/memory copy is
  // detected on Windows when the canonical file is absent (real-world
  // incident 2026-09-11). Non-win32 → always null (path is canonical there).
  // -------------------------------------------------------------------------
  ["(s23) config misplacement: stray .config copy detected on win32, silent elsewhere", async () => {
    const kc = await dist("keeperConfig.js");
    const canonical = kc.getKeeperConfigPath();
    const misplaced = path.join(
      os.homedir(), ".config", "opencode", "memory", "keeper-config.json"
    );
    // Clean slate (harness temp dirs only — never the real home).
    fs.rmSync(canonical, { force: true });
    fs.rmSync(misplaced, { force: true });

    if (os.platform() === "win32") {
      fs.mkdirSync(path.dirname(misplaced), { recursive: true });
      fs.writeFileSync(misplaced, '{"mode":"tags"}', "utf-8");
      assert.equal(
        kc.findMisplacedConfigFile(), misplaced,
        "stray .config copy must be detected when the canonical file is absent"
      );
      // Canonical present → no warning (the stray is harmless noise then).
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, "{}", "utf-8");
      assert.equal(
        kc.findMisplacedConfigFile(), null,
        "no warning when the canonical config exists"
      );
    }
    // Neither file anywhere → silence (no false positive), on every platform.
    fs.rmSync(misplaced, { force: true });
    fs.rmSync(canonical, { force: true });
    assert.equal(
      kc.findMisplacedConfigFile(), null,
      "no warning when no config exists anywhere"
    );
  }],
];

// ---------------------------------------------------------------------------
// Phase 1 helpers — keeper-config v2 tests (need distConfig, loaded in main).
// ---------------------------------------------------------------------------
const keeperConfigPath = () => path.join(memoryDir(), "keeper-config.json");
function writeKeeperConfig(obj) {
  fs.mkdirSync(path.dirname(keeperConfigPath()), { recursive: true });
  fs.writeFileSync(keeperConfigPath(), JSON.stringify(obj, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 2 helpers — trigger-mode tests: inline client whose assistant reply
// is the given text, session directory resolves to the fake project.
// ---------------------------------------------------------------------------
function tagClient(assistantText) {
  const calls = { create: [], promptAsync: [], delete: [] };
  let n = 0;
  return {
    calls,
    session: {
      get: async () => ({ data: { directory: path.join(TEMP_ROOT, "fake-proj") } }),
      create: async (args) => {
        calls.create.push(args);
        n += 1;
        return { data: { id: `k${n}` } };
      },
      promptAsync: async (args) => {
        calls.promptAsync.push(args);
      },
      messages: async () => ({
        data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "work question about the project setup" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: assistantText }] },
        ],
      }),
      delete: async (args) => {
        calls.delete.push(args);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Force transformers.js offline BEFORE any dist module that could trigger
  // a model load: the local model cache is absent in CI/fresh clones, and a
  // remote fetch would both hit the network and write into node_modules.
  const transformers = await import("@huggingface/transformers");
  transformers.env.allowRemoteModels = false;

  // Import all dist modules AFTER env redirection (module-load path capture).
  distConfig = await dist("config.js");
  distMemoryManager = await dist("MemoryManager.js");
  distTimestampParser = await dist("timestampParser.js");
  distGit = await dist("git.js");
  distKeeper = await dist("keeper.js");
  distKeeperConfig = await dist("keeperConfig.js");

  // Hard gate before any fs-touching test.
  const { getMemoryDir } = distConfig;
  const dir = getMemoryDir();
  assert.ok(
    dir.toLowerCase().startsWith(TEMP_ROOT.toLowerCase()),
    `getMemoryDir() must resolve under the temp root before fs tests (got ${dir})`
  );

  for (const [name, fn] of tests) await test(name, fn);

  // Let the fire-and-forget embedding queue drain (its items fail fast in
  // offline mode) so output isn't truncated by process.exit.
  await sleep(300);

  const failures = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failures}/${results.length} tests passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("SUITE CRASH:", err);
  process.exit(1);
});
