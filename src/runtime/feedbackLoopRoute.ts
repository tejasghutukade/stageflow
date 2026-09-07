import type { ResolvedPipelineDag, ResolvedPipelineStageNode } from "../types/pipeline.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";

/** Persistent stages on target→source inclusive, forward order (ancestors slice + source). */
export function feedbackRouteStageIds(
  sourceNode: ResolvedPipelineStageNode,
  targetId: string,
): string[] {
  const targetIndex = sourceNode.ancestors.indexOf(targetId);
  if (targetIndex < 0) {
    throw new Error(
      `feedback-loop target "${targetId}" is not an ancestor of "${sourceNode.id}"`,
    );
  }
  return [...sourceNode.ancestors.slice(targetIndex), sourceNode.id];
}

/** All DAG descendants of the feedback-loop source (exclusive of source). */
export function postSourceStageIds(
  dag: ResolvedPipelineDag,
  sourceId: string,
): string[] {
  return [...collectDownstreamStageIds(dag, sourceId)];
}
