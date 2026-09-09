import type { LoadedManifest } from "../types/stageflowManifest.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";

export type ModelSelection = {
  /** stageflow.yaml top-level `model`. */
  global?: string;
  /** Pipeline yaml top-level `model`; overrides global. */
  pipeline?: string;
  /** Stage yaml / inline `model`; overrides pipeline/global. */
  stage?: string;
};

/**
 * stage > pipeline > global. No silent hardcoded fallback — unset is a load error.
 */
export function resolveModelOutcome(
  selection: ModelSelection,
  ctx: { stageId: string; pipelineId: string },
): LoadOutcome<string> {
  const effective = selection.stage ?? selection.pipeline ?? selection.global;
  if (effective === undefined) {
    return loadFailure([
      {
        code: "stage.missing_model",
        message: `Stage "${ctx.stageId}" in pipeline "${ctx.pipelineId}": model is required (set on stage, pipeline, or stageflow.yaml)`,
        category: "stage",
        stageId: ctx.stageId,
      },
    ]);
  }
  return loadSuccess(effective);
}

/** The global tier's model id from an already-loaded manifest, or undefined when missing/unset. */
export function globalModelFromManifest(
  loaded: LoadedManifest | null,
): string | undefined {
  return loaded?.manifest.model;
}
