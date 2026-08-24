import type {
  PendingPrompt,
  PipelineTrackNode,
  RunDetail,
  StageEnvelopeView,
  StageSnapshot,
} from "../api";
import type { DetailView } from "../routes";
import type { DagTrackNode } from "../components/PipelineDagTrack";
import type { TrackDetailRow } from "../components/TrackDetailList";
import type { TrackLayout } from "../components/RunTrack";
import { ringStatus, statusCopy, type RingStatus } from "../status/runStatus";
import {
  detailListOrder,
  groupNodesByLayer,
  isLinearPipelineTrack,
} from "../track/layoutPipelineTrack";
import { readinessDetail } from "../track/readinessCopy";

export type SessionChipKind = "alive" | "closed" | null;

export type ComposerState =
  | { kind: "reply"; prompt: PendingPrompt }
  | { kind: "idle"; label: string }
  | { kind: "none" };

export type OperatorSelection = {
  previousStageId: string | null;
  userPicked: boolean;
  drawerStageId: string | null;
  wasWaitingArtifact?: boolean;
};

export type WorkspaceDrawer = {
  fromStageId: string;
  toStageId: string | undefined;
  envelope: StageEnvelopeView;
};

export type WorkspaceEnvelope = {
  fromStageId: string;
  toStageId: string | undefined;
  envelope: StageEnvelopeView | null;
};

export type WorkspaceTrackStage = {
  id: string;
  label: string;
  status: RingStatus;
  selected: boolean;
  meta?: string;
  envelope: { summary: string; artifactCount: number } | null;
};

export type ArtifactFile = { path: string; meta?: string };

export type ArtifactBackedPrompt = Extract<PendingPrompt, { kind: "artifact_backed" }>;

export type RunWorkspace = {
  selectedStageId: string | null;
  selectedStage: StageSnapshot | null;
  kind: "stream" | "artifact" | "envelope" | "empty";
  composer: ComposerState;
  showDecide: boolean;
  decidePrompt: ArtifactBackedPrompt | undefined;
  artifactReadOnly: boolean;
  selectedPath: string | undefined;
  trackStages: WorkspaceTrackStage[];
  trackLayout: TrackLayout;
  detailListRows: TrackDetailRow[];
  artifactFiles: ArtifactFile[];
  sessionChip: SessionChipKind;
  inboundEnvelope: StageEnvelopeView | null;
  inboundFromStageId: string | undefined;
  inboundToStageId: string | undefined;
  drawer: WorkspaceDrawer | null;
  envelope: WorkspaceEnvelope | null;
  liveStream: boolean;
  activeEnvelopeId: string | null;
  waitingArtifact: boolean;
  syncStreamRoute: boolean;
};

function stageExists(run: RunDetail, stageId: string): boolean {
  return run.stages.some((s) => s.stage_id === stageId);
}

function snapshotById(run: RunDetail): Map<string, StageSnapshot> {
  return new Map(run.stages.map((s) => [s.stage_id, s]));
}

function orderedStageIds(run: RunDetail): string[] {
  const track = run.pipeline_track;
  if (track?.nodes?.length) {
    return detailListOrder(track.nodes).map((n) => n.stage_id);
  }
  return run.stages.map((s) => s.stage_id);
}

function pickStageId(
  run: RunDetail,
  previousStageId: string | null,
  userPicked: boolean,
): string | null {
  const order = orderedStageIds(run);
  const snapshotMap = snapshotById(run);

  if (userPicked && previousStageId && stageExists(run, previousStageId)) {
    return previousStageId;
  }
  if (run.waiting_stage_id && stageExists(run, run.waiting_stage_id)) {
    return run.waiting_stage_id;
  }
  for (const stageId of order) {
    const snap = snapshotMap.get(stageId);
    if (snap?.status === "waiting_for_input") return stageId;
  }
  for (const stageId of order) {
    const snap = snapshotMap.get(stageId);
    if (snap?.status === "running") return stageId;
  }
  for (const stageId of order) {
    const snap = snapshotMap.get(stageId);
    if (snap?.status === "failed") return stageId;
  }
  if (previousStageId && stageExists(run, previousStageId)) return previousStageId;
  return order[0] ?? run.stages[0]?.stage_id ?? null;
}

function snapshotToTrackStage(
  s: StageSnapshot,
  selectedStageId: string | null,
): WorkspaceTrackStage {
  const visual = ringStatus(s.status);
  return {
    id: s.stage_id,
    label: s.stage_id,
    status: visual,
    selected: s.stage_id === selectedStageId,
    meta: visual === "waiting" ? statusCopy(s.status) : s.last_at,
    envelope: s.envelope
      ? {
          summary: s.envelope.summary,
          artifactCount: s.envelope.artifacts.length,
        }
      : null,
  };
}

function pendingTrackStage(id: string, selectedStageId: string | null): WorkspaceTrackStage {
  return {
    id,
    label: id,
    status: "pending",
    selected: id === selectedStageId,
    meta: "pending",
    envelope: null,
  };
}

function trackNodeToWorkspaceStage(
  node: PipelineTrackNode,
  snapshot: StageSnapshot | undefined,
  selectedStageId: string | null,
): WorkspaceTrackStage {
  if (snapshot) return snapshotToTrackStage(snapshot, selectedStageId);
  return pendingTrackStage(node.stage_id, selectedStageId);
}

function toTrackStages(
  stages: StageSnapshot[],
  selectedStageId: string | null,
  plannedStageIds?: string[],
): WorkspaceTrackStage[] {
  if (!plannedStageIds || plannedStageIds.length === 0) {
    return stages.map((s) => snapshotToTrackStage(s, selectedStageId));
  }
  const byId = new Map(stages.map((s) => [s.stage_id, s]));
  const seen = new Set<string>();
  const track: WorkspaceTrackStage[] = [];
  for (const id of plannedStageIds) {
    seen.add(id);
    const live = byId.get(id);
    track.push(
      live ? snapshotToTrackStage(live, selectedStageId) : pendingTrackStage(id, selectedStageId),
    );
  }
  for (const s of stages) {
    if (!seen.has(s.stage_id)) {
      track.push(snapshotToTrackStage(s, selectedStageId));
    }
  }
  return track;
}

function isWaitingAttention(
  run: RunDetail,
  stageId: string,
  status: StageSnapshot["status"],
): boolean {
  if (run.waiting_stage_ids?.includes(stageId)) return true;
  return status === "waiting_for_input";
}

function promptSummary(prompt: PendingPrompt | undefined): string | undefined {
  if (!prompt) return undefined;
  switch (prompt.kind) {
    case "free_text":
    case "confirm":
      return prompt.message;
    case "artifact_backed":
      return prompt.message || prompt.artifacts[0];
    case "multi_question":
      return prompt.questions.length === 1
        ? "1 question"
        : `${prompt.questions.length} questions`;
  }
}

function dagTrackNode(
  node: PipelineTrackNode,
  snapshot: StageSnapshot | undefined,
  run: RunDetail,
  selectedStageId: string | null,
): DagTrackNode {
  const status = snapshot?.status ?? node.status;
  const visual = ringStatus(status);
  return {
    id: node.stage_id,
    label: node.stage_id,
    status: visual,
    stageStatus: status,
    selected: node.stage_id === selectedStageId,
    meta: visual === "waiting" ? statusCopy(status) : snapshot?.last_at,
    envelope: snapshot?.envelope
      ? {
          summary: snapshot.envelope.summary,
          artifactCount: snapshot.envelope.artifacts.length,
        }
      : null,
    isWaitingAttention: isWaitingAttention(run, node.stage_id, status),
  };
}

function buildDetailListRows(
  run: RunDetail,
  nodes: PipelineTrackNode[],
  snapshots: Map<string, StageSnapshot>,
  includeReadiness: boolean,
): TrackDetailRow[] {
  return detailListOrder(nodes).map((node) => {
    const snapshot = snapshots.get(node.stage_id);
    const status = snapshot?.status ?? node.status;
    const readinessLine = includeReadiness
      ? readinessDetail({
          readiness: node.readiness,
          blocked_by: node.blocked_by,
          status,
        })
      : undefined;
    return {
      stageId: node.stage_id,
      status,
      attemptCount: snapshot?.attempt_count ?? node.attempt_count ?? 1,
      readinessLine,
      gateKinds: node.gate_kinds,
      meta: status === "running" ? snapshot?.last_at : undefined,
      promptSummary:
        status === "waiting_for_input"
          ? promptSummary(snapshot?.pending_prompt)
          : undefined,
      isWaitingAttention: isWaitingAttention(run, node.stage_id, status),
    };
  });
}

function buildTrackLayout(
  run: RunDetail,
  selectedStageId: string | null,
  plannedStageIds: string[] | undefined,
): { trackLayout: TrackLayout; detailListRows: TrackDetailRow[]; trackStages: WorkspaceTrackStage[] } {
  const track = run.pipeline_track;
  const snapshots = snapshotById(run);

  if (!track?.nodes?.length) {
    const linearStages = toTrackStages(run.stages, selectedStageId, plannedStageIds);
    return {
      trackLayout: { mode: "linear", linearStages },
      detailListRows: [],
      trackStages: linearStages,
    };
  }

  const nodes = track.nodes;
  const detailListRows = buildDetailListRows(run, nodes, snapshots, true);

  if (isLinearPipelineTrack(track)) {
    const linearStages = detailListOrder(nodes).map((node) =>
      trackNodeToWorkspaceStage(node, snapshots.get(node.stage_id), selectedStageId),
    );
    return {
      trackLayout: { mode: "linear", linearStages },
      detailListRows,
      trackStages: linearStages,
    };
  }

  const grouped = groupNodesByLayer(nodes);
  const layerIndices = grouped.map((layer) => layer[0]!.layer);
  const dagLayers = grouped.map((layer) =>
    layer.map((node) => dagTrackNode(node, snapshots.get(node.stage_id), run, selectedStageId)),
  );
  const trackStages = detailListOrder(nodes).map((node) =>
    trackNodeToWorkspaceStage(node, snapshots.get(node.stage_id), selectedStageId),
  );

  return {
    trackLayout: {
      mode: "dag",
      dagLayers,
      layerIndices,
      trackNodes: nodes,
      edges: track.edges,
    },
    detailListRows,
    trackStages,
  };
}

function composerState(
  kind: RunWorkspace["kind"],
  status: StageSnapshot["status"] | undefined,
  prompt: PendingPrompt | undefined,
): ComposerState {
  if (kind !== "stream" || !status) return { kind: "none" };
  if (status === "waiting_for_input" && prompt) {
    return { kind: "reply", prompt };
  }
  if (status === "succeeded" || status === "failed" || status === "pending") {
    return { kind: "idle", label: "Session closed" };
  }
  return { kind: "none" };
}

function sessionChipKind(
  status: StageSnapshot["status"] | undefined,
): SessionChipKind {
  if (status === "waiting_for_input") return "alive";
  if (status === "succeeded" || status === "failed" || status === "pending") {
    return "closed";
  }
  return null;
}

function runArtifactFiles(run: RunDetail): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  for (const s of run.stages) {
    for (const path of s.artifacts) {
      files.push({ path, meta: s.stage_id });
    }
  }
  return files;
}

function inboundFromStageId(
  run: RunDetail,
  stageId: string,
  plannedStageIds?: string[],
): string | undefined {
  const track = run.pipeline_track;
  if (track?.nodes?.length) {
    return track.edges.find((e) => e.to === stageId)?.from;
  }
  if (plannedStageIds && plannedStageIds.length > 0) {
    const idx = plannedStageIds.indexOf(stageId);
    if (idx > 0) return plannedStageIds[idx - 1];
  }
  const idx = run.stages.findIndex((s) => s.stage_id === stageId);
  if (idx > 0) return run.stages[idx - 1]?.stage_id;
  return undefined;
}

function outboundStageId(
  run: RunDetail,
  fromStageId: string,
  plannedStageIds?: string[],
): string | undefined {
  const track = run.pipeline_track;
  if (track?.nodes?.length) {
    const children = track.edges.filter((e) => e.from === fromStageId);
    if (children.length !== 1) return undefined;
    return children[0]?.to;
  }
  if (plannedStageIds && plannedStageIds.length > 0) {
    const plannedIdx = plannedStageIds.indexOf(fromStageId);
    if (plannedIdx >= 0) return plannedStageIds[plannedIdx + 1];
  }
  const idx = run.stages.findIndex((s) => s.stage_id === fromStageId);
  if (idx < 0) return undefined;
  return run.stages[idx + 1]?.stage_id;
}

function artifactBackedPrompt(
  prompt: PendingPrompt | undefined,
): ArtifactBackedPrompt | undefined {
  return prompt?.kind === "artifact_backed" ? prompt : undefined;
}

function isWaitingArtifact(stage: StageSnapshot | null): boolean {
  return (
    stage?.status === "waiting_for_input" &&
    stage.pending_prompt?.kind === "artifact_backed"
  );
}

export function resolveRunWorkspace(
  view: DetailView,
  run: RunDetail,
  selection: OperatorSelection,
  plannedStageIds?: string[],
): RunWorkspace {
  const selectedStageId = pickStageId(
    run,
    selection.previousStageId,
    selection.userPicked,
  );
  const selectedStage =
    run.stages.find((s) => s.stage_id === selectedStageId) ?? null;
  const catalogOverlay = run.pipeline_track?.nodes?.length
    ? undefined
    : plannedStageIds;
  const inboundId = selectedStageId
    ? inboundFromStageId(run, selectedStageId, catalogOverlay)
    : undefined;
  const inboundStage = inboundId
    ? run.stages.find((s) => s.stage_id === inboundId)
    : undefined;
  const waitingArtifact = isWaitingArtifact(selectedStage);
  const autoReturnToStream =
    view.kind === "artifact" &&
    Boolean(selection.wasWaitingArtifact) &&
    !waitingArtifact;

  let kind: RunWorkspace["kind"];
  if (!selectedStage) {
    kind = "empty";
  } else if (view.kind === "envelope") {
    kind = "envelope";
  } else if (view.kind === "artifact" && !autoReturnToStream) {
    kind = "artifact";
  } else {
    kind = "stream";
  }

  const showDecide = kind === "artifact" && waitingArtifact;
  const decidePrompt = showDecide
    ? artifactBackedPrompt(selectedStage?.pending_prompt)
    : undefined;
  const envelopeStageId = view.kind === "envelope" ? view.stageId : null;
  const envelopeStage = envelopeStageId
    ? (run.stages.find((s) => s.stage_id === envelopeStageId) ?? null)
    : null;
  const envelope: WorkspaceEnvelope | null =
    view.kind === "envelope"
      ? {
          fromStageId: view.stageId,
          toStageId: outboundStageId(run, view.stageId, catalogOverlay),
          envelope: envelopeStage?.envelope ?? null,
        }
      : null;

  const drawerStage = selection.drawerStageId
    ? (run.stages.find((s) => s.stage_id === selection.drawerStageId) ?? null)
    : null;
  const drawerEnvelope = drawerStage?.envelope ?? null;
  const drawer: WorkspaceDrawer | null =
    kind !== "envelope" && selection.drawerStageId && drawerEnvelope
      ? {
          fromStageId: selection.drawerStageId,
          toStageId: outboundStageId(run, selection.drawerStageId, catalogOverlay),
          envelope: drawerEnvelope,
        }
      : null;

  const { trackLayout, detailListRows, trackStages } = buildTrackLayout(
    run,
    selectedStageId,
    catalogOverlay,
  );

  return {
    selectedStageId,
    selectedStage,
    kind,
    composer: composerState(kind, selectedStage?.status, selectedStage?.pending_prompt),
    showDecide,
    decidePrompt,
    artifactReadOnly: !showDecide,
    selectedPath: kind === "artifact" && view.kind === "artifact" ? view.path : undefined,
    trackStages,
    trackLayout,
    detailListRows,
    artifactFiles: runArtifactFiles(run),
    sessionChip: sessionChipKind(selectedStage?.status),
    inboundEnvelope: inboundStage?.envelope ?? null,
    inboundFromStageId: inboundStage?.stage_id,
    inboundToStageId: selectedStage?.stage_id,
    drawer,
    envelope,
    liveStream:
      selectedStage?.status === "running" ||
      selectedStage?.status === "waiting_for_input",
    activeEnvelopeId:
      view.kind === "envelope" ? view.stageId : selection.drawerStageId,
    waitingArtifact,
    syncStreamRoute: autoReturnToStream,
  };
}
