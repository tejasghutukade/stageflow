import type { DraftPackagePayload } from "../../api";

export function writePipelineMemories(draft: DraftPackagePayload, ids: string[]): DraftPackagePayload {
  const memories = ids.length > 0 ? ids : undefined;
  return { ...draft, pipeline: { ...draft.pipeline, memories } };
}

export function readPipelineMemories(draft: DraftPackagePayload): string[] {
  const raw = draft.pipeline.memories;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}
