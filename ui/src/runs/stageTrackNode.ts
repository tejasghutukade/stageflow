import type {
  PipelineTrackNode,
  PipelineTrackProjection,
  RunDetail,
  StageSnapshot,
} from "../api";

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
  run: RunDetail,
  stageId: string,
): PipelineTrackNode | undefined {
  return stageTrackNode(run.pipeline_track, stageId);
}

function stageHasStarted(stage: StageSnapshot): boolean {
  return stage.events?.some((event) => event.event === "started") ?? false;
}

export function isTimelineBlockedStage(
  stage: StageSnapshot,
  trackNode?: PipelineTrackNode,
): boolean {
  return (
    trackNode?.readiness === "blocked" &&
    stage.status === "pending" &&
    !stageHasStarted(stage)
  );
}

export function stageTimelineSubline(
  stage: StageSnapshot,
  trackNode?: PipelineTrackNode,
): string | undefined {
  if (stage.status === "waiting_for_input") return undefined;
  if (isTimelineBlockedStage(stage, trackNode)) return "Blocked";
  return undefined;
}
