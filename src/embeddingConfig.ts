// Pure embedding-config state — NO @huggingface/transformers import.
// Lives in its own module so config routing (keeperConfig / MemoryManager)
// never drags the heavy transformers package into the boot-time module
// graph. embedding.ts READS the dtype here when the pipeline initializes.

import type { EmbeddingDtype } from "./keeperConfig.js";

let activeDtype: EmbeddingDtype = "int8";

export function setActiveDtype(dtype: EmbeddingDtype): void {
  activeDtype = dtype;
}

export function getActiveDtype(): EmbeddingDtype {
  return activeDtype;
}