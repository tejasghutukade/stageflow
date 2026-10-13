import type { RunDetail } from "../api";
import type { TrackLayout } from "../components/RunTrack";
import type { TrackDetailRow } from "../components/TrackDetailList";
import type { WorkspaceTrackStage } from "../workspace/resolveRunWorkspace";
import { stageCloneLabel } from "../workspace/resolveRunWorkspace";
import { readinessDetail } from "../track/readinessCopy";
import { indexTrackNodes } from "./stageTrackNode";

export function listWaitingHeader(run: RunDetail): string | undefined {
  const waitId = run.waiting_stage_id;
  if (!waitId) return undefined;
  return `Waiting on you: ${stageCloneLabel(run, waitId)}`;
}

export function buildRunTrackView(
  run: RunDetail,
  trackStages: WorkspaceTrackStage[],
  selectedStageId: string | null,
): {
  trackLayout: TrackLayout;
  detailListRows: TrackDetailRow[];
  listHeader?: string;
} {
  const trackNodes = indexTrackNodes(run.pipeline_track);
  const label = (stageId: string) => stageCloneLabel(run, stageId);

  const trackLayout: TrackLayout = {
    mode: "linear",
    linearStages: trackStages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      status: stage.status,
      meta: stage.meta,
    })),
  };

  const detailListRows: TrackDetailRow[] = run.stages.map((snapshot) => {
    const node = trackNodes.get(snapshot.stage_id);
    const waiting =
      run.waiting_stage_id === snapshot.stage_id ||
      snapshot.status === "waiting_for_input";
    const readinessLine = node
      ? readinessDetail({
          readiness: node.readiness,
          blocked_by: node.blocked_by,
          status: snapshot.status,
          blockersLabel: label,
        })
      : undefined;
    return {
      stageId: snapshot.stage_id,
      label: label(snapshot.stage_id),
      status: snapshot.status,
      readiness: node?.readiness,
      attemptCount: snapshot.attempt_count,
      meta: snapshot.last_at,
      promptSummary: snapshot.pending_prompt?.kind,
      readinessLine: node?.readiness === "blocked" ? readinessLine : undefined,
      isWaitingAttention: waiting,
    };
  });

  void selectedStageId;

  return {
    trackLayout,
    detailListRows,
    listHeader: listWaitingHeader(run),
  };
}
