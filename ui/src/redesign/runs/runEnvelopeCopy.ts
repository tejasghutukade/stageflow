import type { RunDetail } from "../../api";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";

export function inboundEnvelopeTitle(
  run: RunDetail,
  fromStageId: string | null | undefined,
): string {
  if (fromStageId) {
    return `Incoming · from ${stageCloneLabel(run, fromStageId)}`;
  }
  return "Incoming";
}

export function inboundEnvelopeEmpty(
  run: RunDetail,
  stageId: string,
  fromStageId: string | null | undefined,
): string {
  const label = stageCloneLabel(run, stageId);
  if (fromStageId) {
    return `No handoff from ${stageCloneLabel(run, fromStageId)} for ${label} yet.`;
  }
  return `No incoming handoff — ${label} is the first stage in this run.`;
}

export function outboundEnvelopeTitle(
  run: RunDetail,
  toStageId: string | null | undefined,
): string {
  if (toStageId) {
    return `Outgoing · to ${stageCloneLabel(run, toStageId)}`;
  }
  return "Outgoing";
}

export function outboundEnvelopeEmpty(
  run: RunDetail,
  stageId: string,
  toStageId: string | null | undefined,
): string {
  const label = stageCloneLabel(run, stageId);
  if (toStageId) {
    return `No handoff from ${label} to ${stageCloneLabel(run, toStageId)} yet.`;
  }
  return `No outgoing handoff from ${label} yet.`;
}
