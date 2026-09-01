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
  dismissedWaitKey?: string | null;
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

export type ArtifactFile = { path: string; label?: string; meta?: string };

const ENVELOPE_ASIDE_PREFIX = "stageflow:envelope:";

export function envelopeAsidePath(stageId: string): string {
  return `${ENVELOPE_ASIDE_PREFIX}${stageId}`;
}

export function parseEnvelopeAsidePath(path: string): string | null {
  if (!path.startsWith(ENVELOPE_ASIDE_PREFIX)) return null;
  const stageId = path.slice(ENVELOPE_ASIDE_PREFIX.length);
  return stageId.length > 0 ? stageId : null;
}

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

export function stageIdKnown(
  run: RunDetail,
  stageId: string,
  plannedStageIds?: string[],
): boolean {
  if (stageExists(run, stageId)) return true;
  if (run.pipeline_track?.nodes?.some((n) => n.stage_id === stageId)) return true;
  return Boolean(plannedStageIds?.includes(stageId));
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

export function activeWaitKey(run: RunDetail): string | null {
  const stageId = run.waiting_stage_id;
  if (!stageId) return null;
  const snap = run.stages.find((s) => s.stage_id === stageId);
  const promptId = snap?.pending_prompt?.id;
  if (promptId) return `${stageId}:${promptId}`;
  if (run.waiting_prompt_id) return run.waiting_prompt_id;
  return stageExists(run, stageId) ? `${stageId}:` : null;
}

function pickStageId(run: RunDetail, selection: OperatorSelection): string | null {
  if (
    selection.userPicked &&
    selection.previousStageId &&
    stageExists(run, selection.previousStageId)
  ) {
    return selection.previousStageId;
  }
  const waitKey = activeWaitKey(run);
  if (
    waitKey &&
    waitKey !== selection.dismissedWaitKey &&
    run.waiting_stage_id &&
    stageExists(run, run.waiting_stage_id)
  ) {
    return run.waiting_stage_id;
  }
  return null;
}

function stageOwnsArtifactPath(stage: StageSnapshot, path: string): boolean {
  if (stage.artifacts.includes(path)) return true;
  return Boolean(stage.envelope?.artifacts.includes(path));
}

function artifactOwnerStageId(run: RunDetail, path: string): string | null {
  const snapshots = snapshotById(run);
  for (const stageId of orderedStageIds(run)) {
    const snap = snapshots.get(stageId);
    if (snap && stageOwnsArtifactPath(snap, path)) return stageId;
  }
  return null;
}

export function formatCloneLabel(
  stageId: string,
  definitionId?: string,
  ordinal?: number,
): string {
  if (definitionId === undefined || definitionId === "") return stageId;
  if (stageId === definitionId) return definitionId;
  if (ordinal === undefined) return stageId;
  return `${definitionId} · ${ordinal}`;
}

function definitionOrdinal(
  nodes: PipelineTrackNode[],
  stageId: string,
  definitionId: string | undefined,
): number | undefined {
  if (definitionId === undefined) return undefined;
  const peers = detailListOrder(nodes).filter(
    (n) => (n.definition_id ?? n.stage_id) === definitionId,
  );
  const index = peers.findIndex((n) => n.stage_id === stageId);
  if (index < 0) return undefined;
  return index + 1;
}

function nodeCloneLabel(nodes: PipelineTrackNode[], node: PipelineTrackNode): string {
  return formatCloneLabel(
    node.stage_id,
    node.definition_id,
    definitionOrdinal(nodes, node.stage_id, node.definition_id),
  );
}

export function stageCloneLabel(run: RunDetail, stageId: string): string {
  const nodes = run.pipeline_track?.nodes ?? [];
  const node = nodes.find((n) => n.stage_id === stageId);
  if (!node) return formatCloneLabel(stageId);
  return nodeCloneLabel(nodes, node);
}

function snapshotToTrackStage(
  s: StageSnapshot,
  selectedStageId: string | null,
  label?: string,
): WorkspaceTrackStage {
  const visual = ringStatus(s.status);
  return {
    id: s.stage_id,
    label: label ?? s.stage_id,
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

function pendingTrackStage(
  id: string,
  selectedStageId: string | null,
  label?: string,
): WorkspaceTrackStage {
  return {
    id,
    label: label ?? id,
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
  nodes: PipelineTrackNode[],
): WorkspaceTrackStage {
  const label = nodeCloneLabel(nodes, node);
  if (snapshot) return snapshotToTrackStage(snapshot, selectedStageId, label);
  return pendingTrackStage(node.stage_id, selectedStageId, label);
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
  nodes: PipelineTrackNode[],
): DagTrackNode {
  const status = snapshot?.status ?? node.status;
  const visual = ringStatus(status);
  return {
    id: node.stage_id,
    label: nodeCloneLabel(nodes, node),
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
      label: nodeCloneLabel(nodes, node),
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
      trackNodeToWorkspaceStage(node, snapshots.get(node.stage_id), selectedStageId, nodes),
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
    layer.map((node) => dagTrackNode(node, snapshots.get(node.stage_id), run, selectedStageId, nodes)),
  );
  const trackStages = detailListOrder(nodes).map((node) =>
    trackNodeToWorkspaceStage(node, snapshots.get(node.stage_id), selectedStageId, nodes),
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
  if (kind !== "stream") return { kind: "none" };
  if (status === "waiting_for_input" && prompt) {
    return { kind: "reply", prompt };
  }
  if (
    !status ||
    status === "succeeded" ||
    status === "failed" ||
    status === "pending" ||
    status === "skipped"
  ) {
    return { kind: "idle", label: "Session closed" };
  }
  return { kind: "none" };
}

function sessionChipKind(
  status: StageSnapshot["status"] | undefined,
): SessionChipKind {
  if (status === "waiting_for_input") return "alive";
  if (status === "succeeded" || status === "failed" || status === "pending" || status === "skipped") {
    return "closed";
  }
  return null;
}

function runArtifactFiles(run: RunDetail): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  for (const s of run.stages) {
    for (const path of s.artifacts) {
      files.push({ path, meta: stageCloneLabel(run, s.stage_id) });
    }
  }
  return files;
}

function asideArtifactFiles(
  run: RunDetail,
  selectedStage: StageSnapshot | null,
): ArtifactFile[] {
  const files = runArtifactFiles(run);
  if (!selectedStage?.envelope) return files;
  return [
    {
      path: envelopeAsidePath(selectedStage.stage_id),
      label: "Handoff envelope",
      meta: stageCloneLabel(run, selectedStage.stage_id),
    },
    ...files,
  ];
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

export function runDetailShouldPoll(
  run: Pick<RunDetail, "status" | "waiting_stage_id" | "stages"> | null,
  action: { retrying: boolean; abandoning: boolean },
): boolean {
  if (action.retrying || action.abandoning) return true;
  if (!run) return false;
  if (run.status === "created" || run.status === "running") return true;
  if (run.waiting_stage_id) return true;
  return run.stages.some(
    (s) => s.status === "running" || s.status === "waiting_for_input",
  );
}

export function resolveRunWorkspace(
  view: DetailView,
  run: RunDetail,
  selection: OperatorSelection,
  plannedStageIds?: string[],
): RunWorkspace {
  const pickedStageId = pickStageId(run, selection);
  const streamStageId =
    view.kind === "stream" && view.stageId && stageIdKnown(run, view.stageId, plannedStageIds)
      ? view.stageId
      : pickedStageId;
  const selectedStageId =
    view.kind === "envelope"
      ? view.stageId
      : view.kind === "artifact"
        ? artifactOwnerStageId(run, view.path)
        : streamStageId;
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
  if (view.kind === "envelope") {
    kind = "envelope";
  } else if (view.kind === "artifact" && !autoReturnToStream) {
    kind = "artifact";
  } else if (selectedStageId) {
    kind = "stream";
  } else {
    kind = "empty";
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
    selectedPath:
      kind === "artifact" && view.kind === "artifact"
        ? view.path
        : kind === "envelope" && view.kind === "envelope"
          ? envelopeAsidePath(view.stageId)
          : undefined,
    trackStages,
    trackLayout,
    detailListRows,
    artifactFiles: asideArtifactFiles(run, selectedStage),
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
