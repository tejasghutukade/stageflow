import type { PipelineForkConfig } from "../types/pipeline.js";
import type { ForkChoiceShape } from "../types/forkChoice.js";

export function resolveForkChoiceShape(forkConfig: PipelineForkConfig | undefined): ForkChoiceShape | null {
  if (!forkConfig) return null;
  return { cardinality: forkConfig.select, allowNone: forkConfig.allow_none };
}
