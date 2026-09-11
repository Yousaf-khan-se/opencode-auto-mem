import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { getMemoryDir } from "./config.js";
import { plog } from "./logger.js";

const execFileAsync = promisify(execFile);

async function runGit(memoryDir: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: memoryDir });
  return result.stdout;
}

const GITIGNORE_CONTENT = [
  "index-cache.json",
  "keeper-state.json",
  "keeper-config.json",
  "root.index/",
  "project.index/",
  "indexes/",
  "",
].join("\n");

export async function ensureGitRepo(): Promise<void> {
  const memoryDir = getMemoryDir();
  const gitDir = path.join(memoryDir, ".git");

  if (!fs.existsSync(gitDir)) {
    try {
      await runGit(memoryDir, ["init"]);
      await runGit(memoryDir, ["config", "user.name", "OpenCode Memory"]);
      await runGit(memoryDir, [
        "config",
        "user.email",
        "memory@opencode.local",
      ]);
    } catch (err) {
      plog("error",
        `[git] Failed to initialize repo: ${(err as Error).message}`
      );
    }
  }

  // Generated artifacts must stay out of the memory repo: heading-index
  // caches, keeper state, keeper config, and vectra vector indexes.
  // Rewritten when content drifts (not only when missing) so new entries
  // reach repos whose .gitignore predates them.
  const gitignorePath = path.join(memoryDir, ".gitignore");
  try {
    if (fs.readFileSync(gitignorePath, "utf-8") !== GITIGNORE_CONTENT) {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
    }
  } catch {
    try {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
    } catch (err) {
      plog("error", `[git] Failed to write .gitignore: ${(err as Error).message}`);
    }
  }
}

// Memory writes fire gitCommit() concurrently (main agent + keeper can write
// several files in rapid succession, and `git add .` takes the repo-wide
// index.lock). Chain every commit through one promise so they execute
// strictly one at a time — with `git add .`, the first commit in a batch
// naturally captures concurrently-written files, so later no-op commits
// (nothing to commit) are the expected healthy path.
let commitChain: Promise<void> = Promise.resolve();

export function gitCommit(operation: string): Promise<void> {
  const run = async (): Promise<void> => {
    const memoryDir = getMemoryDir();
    await ensureGitRepo();
    try {
      await runGit(memoryDir, ["add", "."]);
      const status = await runGit(memoryDir, ["status", "--porcelain"]);
      if (!status.trim()) {
        plog("info", `[git] Commit noop: ${operation}`);
        return;
      }
      await runGit(memoryDir, ["commit", "-m", operation]);
      plog("info", `[git] Commit committed: ${operation}`);
    } catch (err) {
      const errorMessage = (err as Error).message;
      if (!errorMessage.includes("nothing to commit")) {
        plog("error", `[git] Commit failed: ${errorMessage}`);
      }
    }
  };
  commitChain = commitChain.then(run, run);
  return commitChain;
}
