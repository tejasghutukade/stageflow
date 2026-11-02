import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { IndependenceLevel } from "../types/stage.js";

export type IndependenceSelection = {
  /** stageflow.yaml top-level `independence`. */
  global?: IndependenceLevel;
  /** Root pipeline yaml top-level `independence`; overrides global. */
  pipeline?: IndependenceLevel;
  /** Stage body `independence`; overrides pipeline and global. */
  stage?: IndependenceLevel;
};

/**
 * stage > root pipeline > manifest. Every tier omitted is persistent.
 * Unknown values are rejected at the tier that authored them, before this runs.
 */
export function resolveIndependence(selection: IndependenceSelection): IndependenceLevel {
  return selection.stage ?? selection.pipeline ?? selection.global ?? "persistent";
}

export function globalIndependenceFromManifest(
  loaded: LoadedManifest | null,
): IndependenceLevel | undefined {
  return loaded?.manifest.independence;
}
