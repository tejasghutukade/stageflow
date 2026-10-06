import type { RunDetail } from "../../api";
import { pendingGateLabel } from "./runInspectorFields";
import { statusCopy } from "../../status/runStatus";
import { detailListOrder } from "../../track/layoutPipelineTrack";
import { readinessDetail } from "../../track/readinessCopy";
import { waitsOnCopy } from "../../track/waitsOnCopy";
import type { StatusSignal } from "../statusSignal";
import {
  statusSignalFromReadiness,
  statusSignalFromStageStatus,
} from "../statusSignal";
import type { WorkspaceTrackStage } from "../../workspace/resolveRunWorkspace";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import { findStageTrackNode, indexTrackNodes } from "../../runs/stageTrackNode";

export type GraphBandNode = {
  stageId: string;
  label: string;
  selected: boolean;
  signal: StatusSignal;
  blocked: boolean;
  /** Primary readiness line (Blocked, Needs you · gate, succeeded, …). */
  readinessLine: string;
  /** Secondary line (waits on …) for blocked nodes. */
  waitsLine?: string;
  attemptLine?: string;
  clickable: boolean;
  titleMuted: boolean;
};

function stageHasStarted(
  run: RunDetail,
  stageId: string,
): boolean {
  const snapshot = run.stages.find((s) => s.stage_id === stageId);
  return snapshot?.events?.some((e) => e.event === "started") ?? false;
}

function graphReadinessLines(
  run: RunDetail,
  stageId: string,
): Pick<GraphBandNode, "readinessLine" | "waitsLine"> {
  const trackNode = findStageTrackNode(run, stageId);
  const snapshot = run.stages.find((s) => s.stage_id === stageId);
  const status = snapshot?.status ?? trackNode?.status ?? "pending";
  const label = (id: string) => stageCloneLabel(run, id);

  if (trackNode?.readiness === "blocked") {
    const waits =
      trackNode.blocked_by?.length && label
        ? waitsOnCopy(trackNode.blocked_by, label)
        : undefined;
    return { readinessLine: "Blocked", waitsLine: waits };
  }

  if (status === "waiting_for_input") {
    const gate = pendingGateLabel(snapshot?.pending_prompt);
    return {
      readinessLine: gate ? `Needs you · ${gate}` : "Needs you",
    };
  }

  const detail =
    trackNode &&
    readinessDetail({
      readiness: trackNode.readiness,
      blocked_by: trackNode.blocked_by,
      status,
      blockersLabel: label,
    });
  if (detail) return { readinessLine: detail };

  return { readinessLine: statusCopy(status) };
}

export function buildRunGraphBandView(
  run: RunDetail,
  trackStages: WorkspaceTrackStage[],
  selectedStageId: string | null,
): GraphBandNode[] {
  const trackNodes = indexTrackNodes(run.pipeline_track);
  const orderedIds =
    run.pipeline_track?.nodes?.length ?
      detailListOrder(run.pipeline_track.nodes).map((n) => n.stage_id)
    : trackStages.map((s) => s.id);

  const trackStageById = new Map(trackStages.map((s) => [s.id, s]));

  return orderedIds.map((stageId) => {
    const trackStage = trackStageById.get(stageId);
    const trackNode = trackNodes.get(stageId);
    const snapshot = run.stages.find((s) => s.stage_id === stageId);
    const status = snapshot?.status ?? trackNode?.status ?? "pending";
    const blocked = trackNode?.readiness === "blocked";
    const selected = stageId === selectedStageId;
    const { readinessLine, waitsLine } = graphReadinessLines(run, stageId);

    const signal =
      blocked ? statusSignalFromReadiness("blocked")
      : status === "waiting_for_input" ? statusSignalFromStageStatus(status)
      : trackNode ? statusSignalFromReadiness(trackNode.readiness)
      : statusSignalFromStageStatus(status);

    const clickable =
      status !== "pending" ||
      status === "waiting_for_input" ||
      stageHasStarted(run, stageId);

    const attempt = snapshot?.attempt_count ?? trackNode?.attempt_count;
    const showAttempt =
      attempt != null &&
      attempt > 0 &&
      (selected || status === "waiting_for_input" || status === "running");

    const titleMuted = blocked || (status === "pending" && !selected);

    return {
      stageId,
      label: trackStage?.label ?? stageCloneLabel(run, stageId),
      selected,
      signal,
      blocked,
      readinessLine,
      waitsLine,
      attemptLine: showAttempt ? `attempt ${attempt}` : undefined,
      clickable,
      titleMuted,
    };
  });
}

export function graphBandSelectedHint(
  run: RunDetail,
  selectedStageId: string | null,
): string | undefined {
  if (!selectedStageId) return undefined;
  return stageCloneLabel(run, selectedStageId);
}
