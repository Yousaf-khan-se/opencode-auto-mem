import { pipeline } from "@huggingface/transformers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getActiveDtype, setActiveDtype } from "./embeddingConfig.js";

process.env.TRANSFORMERS_VERBOSITY = "error";
process.env.ORT_LOGGING_LEVEL = "error";

let embedder: any = null;
let initPromise: Promise<void> | null = null;

/**
 * Model-cache dir: <transformers package dir>/.cache — the same location
 * transformers.js uses as its DEFAULT_CACHE_DIR, computed here explicitly so
 * the cache-validity/retry logic below can target the real files.
 *
 * ESM-parity (Gotcha 11 hardened): derived from import.meta.url, NEVER
 * __dirname (a CJS global that throws under Node ESM — the plugin is
 * "type": "module"). Bun tolerates CJS globals in ESM, Node does not; this
 * module must behave identically under both.
 *
 * Layout rule (Gotcha 12): this file is <pluginRoot>/dist/embedding.js.
 * - Deployed: <config>/node_modules/opencode-auto-mem/dist → pluginRoot =
 *   <config>/node_modules/opencode-auto-mem → parent = <config>/node_modules
 *   → cache = <config>/node_modules/@huggingface/transformers/.cache (the
 *   REAL live cache).
 * - Workspace: <repo>/dist → parent = <repo> → cache = <repo>/node_modules/...
 *   (the workspace's own transformers copy).
 */
export function getModelCachePath(): string {
  const thisFile = fileURLToPath(import.meta.url); // <pluginRoot>/dist/embedding.js
  const distDir = path.dirname(thisFile); // <pluginRoot>/dist
  const pluginRoot = path.dirname(distDir); // <pluginRoot>
  const modulesRoot = path.dirname(pluginRoot); // deployed: <config>/node_modules | workspace: <repo>
  return path.join(modulesRoot, "@huggingface", "transformers", ".cache");
}

function isModelCacheValid(): boolean {
  const cachePath = getModelCachePath();
  const modelPath = path.join(
    cachePath,
    "nomic-ai",
    "nomic-embed-text-v1.5",
    "onnx",
    "model.onnx"
  );

  if (!fs.existsSync(modelPath)) {
    return false;
  }

  const stat = fs.statSync(modelPath);
  if (stat.size < 1000000) {
    return false;
  }

  return true;
}

function clearModelCache(): void {
  try {
    const cachePath = getModelCachePath();
    const modelPath = path.join(cachePath, "nomic-ai", "nomic-embed-text-v1.5");

    if (fs.existsSync(modelPath)) {
      fs.rmSync(modelPath, { recursive: true, force: true });
    }
  } catch {}
}

async function initEmbedder(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      let retries = 0;
      const maxRetries = 2;

      while (retries <= maxRetries) {
        try {
          if (!isModelCacheValid()) {
            clearModelCache();
          }

          embedder = await pipeline(
            "feature-extraction",
            "nomic-ai/nomic-embed-text-v1.5",
            {
              // Phase 5: dtype from config (int8 default, ~4x smaller than
              // fp32). Routed via the pure embeddingConfig module.
              dtype: getActiveDtype(),
              // Gotcha 12 fix: explicit cache_dir at the REAL transformers
              // cache location (deployed: <config>/node_modules/@huggingface/
              // transformers/.cache — where the live model already lives).
              // Without this, pipeline() silently used its own package-dir
              // default and the cache-validity/retry logic below was dead
              // code validating a nonexistent path.
              cache_dir: getModelCachePath(),
              session_options: {
                // P2: Constrain ORT's memory arena. Without these, ORT
                // pre-allocates a multi-GB arena for the worst-case
                // intermediate tensor shape and never releases it back to
                // the OS. Disabling the arena + memory-pattern caching keeps
                // resident memory close to the model weight size (~130MB int8)
                // instead of 2-4GB.
                enableCpuMemArena: false,
                enableMemPattern: false,
              },
            }
          );
          return;
        } catch (err) {
          const errMsg = (err as Error).message;
          if (
            errMsg.includes("Protobuf parsing failed") ||
            errMsg.includes("corrupt")
          ) {
            clearModelCache();
            retries++;
            if (retries > maxRetries) {
              throw new Error(
                `Failed to load embedding model after ${maxRetries} retries. ` +
                  `Model cache may be corrupted. Try: rm -rf node_modules/@huggingface/transformers/.cache`
              );
            }
            continue;
          }
          throw err;
        }
      }
    })();
  }
  await initPromise;
}

async function getEmbedder(): Promise<any> {
  if (!embedder) {
    await initEmbedder();
  }
  return embedder;
}

export async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

// Re-export the pure hash util from its own module (src/hash.ts) so that
// importing embedText-related code never drags @huggingface/transformers
// into the boot-time module graph. hashContent itself is pure crypto.
export { hashContent } from "./hash.js";

// Phase 5 exports: dtype observability + test reset (drops the loaded
// embedder so the next embedText re-initializes with the new dtype).
export { getActiveDtype } from "./embeddingConfig.js";

export function __resetEmbeddingForTests(): void {
  embedder = null;
  initPromise = null;
  setActiveDtype("int8");
}
