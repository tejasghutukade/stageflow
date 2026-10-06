import type { PipelineTrackNode, PipelineTrackProjection, RunDetail, StageSnapshot } from "../api";
import { stageCloneLabel } from "../workspace/resolveRunWorkspace";

export function indexTrackNodes(
  projection: PipelineTrackProjection,
): Map<string, PipelineTrackNode> {
  return new Map(projection.nodes.map((node) => [node.stage_id, node]));
}

export function stageTrackNode(
  projection: PipelineTrackProjection | undefined,
  stageId: string,
): PipelineTrackNode | undefined {
  if (!projection) return undefined;
  return projection.nodes.find((node) => node.stage_id === stageId);
}

export function findStageTrackNode(
  run: Pick<RunDetail, "pipeline_track">,
  stageId: string,
): PipelineTrackNode | undefined {
  return stageTrackNode(run.pipeline_track, stageId);
}

export function formatBlockedByLabels(
  run: RunDetail,
  blockedBy: string[] | undefined,
): string | undefined {
  if (!blockedBy?.length) return undefined;
  return blockedBy.map((id) => stageCloneLabel(run, id)).join(", ");
}

export function blockedWaitsOnLine(
  run: RunDetail,
  blockedBy: string[] | undefined,
): string | undefined {
  const labels = formatBlockedByLabels(run, blockedBy);
  if (!labels) return "Blocked";
  return `waits on ${labels}`;
}

export function isTimelineBlockedStage(
  run: Pick<RunDetail, "pipeline_track">,
  stage: StageSnapshot,
  node?: PipelineTrackNode,
): boolean {
  const trackNode = node ?? findStageTrackNode(run, stage.stage_id);
  if (trackNode?.readiness !== "blocked") return false;
  return stage.status === "pending";
}

export function stageTimelineSubline(
  run: RunDetail,
  stage: StageSnapshot,
  node?: PipelineTrackNode,
): string | undefined {
  if (stage.status === "waiting_for_input") return undefined;
  const trackNode = node ?? findStageTrackNode(run, stage.stage_id);
  if (isTimelineBlockedStage(run, stage, trackNode)) return "Blocked";
  return undefined;
}
