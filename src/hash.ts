import * as crypto from "node:crypto";

/**
 * SHA-256 hex hash of a string. Lives in its own module (NOT embedding.ts) so
 * that chunker/MemoryManager can hash chunk content without pulling the
 * heavy @huggingface/transformers package into the boot-time module graph.
 */
export function hashContent(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}