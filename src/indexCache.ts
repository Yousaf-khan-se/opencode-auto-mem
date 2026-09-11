// mtime+size backed heading-index cache.
// One JSON sidecar per scope: per-project caches live inside each project
// folder, the global cache lives at the memory root.

import * as fs from "node:fs";
import { atomicWrite } from "./atomicWrite.js";
import type { HeadingNode } from "./types.js";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  index: HeadingNode[];
}

type IndexCacheFile = Record<string, CacheEntry>;

function readCacheFile(cachePath: string): IndexCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Return the cached heading index for filePath if the file has not changed
 * (mtime + size match); otherwise rebuild, persist and return it.
 * Missing files yield an empty index (the cache is left untouched).
 */
export function getCachedIndex(
  filePath: string,
  cachePath: string,
  build: () => HeadingNode[]
): HeadingNode[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cache = readCacheFile(cachePath);
  const entry = cache[filePath];
  if (
    entry &&
    Array.isArray(entry.index) &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.size === stat.size
  ) {
    return entry.index;
  }

  const index = build();
  cache[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, index };
  try {
    atomicWrite(cachePath, JSON.stringify(cache, null, 2));
  } catch {
    // cache is best-effort; never fail an operation because of it
  }
  return index;
}