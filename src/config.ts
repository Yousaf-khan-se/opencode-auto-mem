import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { MemoryConfig } from "./types.js";

export function getMemoryDir(): string {
  const home = os.homedir();
  if (os.platform() === "win32") {
    return path.join(home, "AppData", "Roaming", "opencode", "memory");
  }
  return path.join(home, ".config", "opencode", "memory");
}

export function getProjectDir(memoryDir: string): string {
  return path.join(memoryDir, "project");
}

export function getCurrentProjectName(): string | null {
  try {
    const cwd = process.cwd();
    return path.basename(cwd);
  } catch {
    return null;
  }
}

/**
 * True when the current working directory is the user's home directory itself.
 * Used to skip auto-creating a project memory folder for a directory that is
 * not actually a project.
 */
export function isHomeDirectory(): boolean {
  try {
    return path.resolve(process.cwd()) === path.resolve(os.homedir());
  } catch {
    return false;
  }
}

/**
 * Project name for an arbitrary session directory (not the plugin's cwd).
 * Returns null for the home directory itself or unresolvable paths.
 */
export function getProjectNameFromDirectory(directory: string): string | null {
  try {
    const resolved = path.resolve(directory);
    if (resolved === path.resolve(os.homedir())) return null;
    const base = path.basename(resolved);
    return base || null;
  } catch {
    return null;
  }
}

/**
 * True when the given directory IS the home directory (session-directory
 * variant of isHomeDirectory for non-cwd directories).
 */
export function directoryIsHome(directory: string): boolean {
  try {
    return path.resolve(directory) === path.resolve(os.homedir());
  } catch {
    return false;
  }
}

export function resolvePath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(filePath);
}

export function loadConfig(): MemoryConfig {
  const memoryDir = getMemoryDir();
  const projectDir = getProjectDir(memoryDir);
  const currentProjectName = getCurrentProjectName();
  return { memoryDir, projectDir, currentProjectName };
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
