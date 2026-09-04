import type {
  PipelineTrackEdge,
  PipelineTrackNode,
  PipelineTrackProjection,
  RunPipelineDagSnapshot,
  RunStatus,
  StageReadiness,
  StageSnapshot,
} from "./port.js";
import {
  instancesOfDefinition,
  linearCompatDagSnapshot,
} from "./pipelineDagSnapshot.js";

export type BuildPipelineTrackInput = {
  dagSnapshot: RunPipelineDagSnapshot | null | undefined;
  stages: StageSnapshot[];
  runStatus: RunStatus;
};

function stageStarted(stage: StageSnapshot): boolean {
  return stage.events.some((e) => e.event === "started" || e.event === "resumed");
}

function runHalted(stages: StageSnapshot[]): boolean {
  return stages.some((s) => s.status === "failed");
}

function predecessorIds(
  dag: RunPipelineDagSnapshot,
  needs: string,
): string[] {
  const preds = instancesOfDefinition(dag, needs);
  return preds.length > 0 ? preds : [needs];
}

function computeLayers(dag: RunPipelineDagSnapshot): Map<string, number> {
  const layers = new Map<string, number>();
  const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));

  function layerFor(id: string): number {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    const node = nodeById.get(id);
    if (!node?.needs) {
      layers.set(id, 0);
      return 0;
    }
    const fromIds = predecessorIds(dag, node.needs);
    const l = Math.max(...fromIds.map(layerFor)) + 1;
    layers.set(id, l);
    return l;
  }

  for (const id of dag.stage_ids) {
    layerFor(id);
  }
  return layers;
}

function deriveReadiness(
  stage: StageSnapshot,
  dag: RunPipelineDagSnapshot,
  snapshotsById: Map<string, StageSnapshot>,
  halted: boolean,
): { readiness: StageReadiness; blocked_by?: string[] } {
  const { status } = stage;
  if (status === "succeeded") return { readiness: "succeeded" };
  if (status === "failed") return { readiness: "failed" };
  if (status === "skipped") return { readiness: "skipped" };
  if (status === "running") return { readiness: "running" };
  if (status === "waiting_for_input") return { readiness: "waiting" };

  if (halted && !stageStarted(stage)) {
    return { readiness: "skipped" };
  }

  const node = dag.nodes.find((n) => n.id === stage.stage_id);
  const need = node?.needs;
  if (need) {
    const fromIds = predecessorIds(dag, need);
    const unresolved = fromIds.filter((id) => {
      const predecessor = snapshotsById.get(id);
      return !predecessor || predecessor.status !== "succeeded";
    });
    if (unresolved.length > 0) {
      return { readiness: "blocked", blocked_by: unresolved };
    }
  }

  return { readiness: "ready" };
}

export function buildPipelineTrack(
  input: BuildPipelineTrackInput,
): PipelineTrackProjection {
  const snapshotsById = new Map(input.stages.map((s) => [s.stage_id, s]));
  const stageIds =
    input.dagSnapshot?.stage_ids ??
    input.stages.map((s) => s.stage_id);
  const dag =
    input.dagSnapshot ?? linearCompatDagSnapshot(stageIds);
  const layers = computeLayers(dag);
  const halted = runHalted(input.stages);

  const nodes: PipelineTrackNode[] = dag.stage_ids.map((stageId) => {
    const stage = snapshotsById.get(stageId);
    if (!stage) {
      throw new Error(
        `buildPipelineTrack: missing overlay snapshot for "${stageId}" — call overlayPlannedStages first`,
      );
    }
    const node = dag.nodes.find((n) => n.id === stageId);
    const { readiness, blocked_by } = deriveReadiness(
      stage,
      dag,
      snapshotsById,
      halted,
    );
    const definitionId = node?.definition_id ?? stage.definition_id ?? stageId;
    const trackNode: PipelineTrackNode = {
      stage_id: stageId,
      status: stage.status,
      readiness,
      layer: layers.get(stageId) ?? 0,
      layer_order: node?.stageIndex ?? dag.stage_ids.indexOf(stageId),
      attempt_count: stage.attempt_count,
      definition_id: definitionId,
    };
    if (blocked_by?.length) trackNode.blocked_by = blocked_by;
    const gateKinds = dag.gate_kinds?.[definitionId] ?? dag.gate_kinds?.[stageId];
    if (gateKinds !== undefined) trackNode.gate_kinds = gateKinds;
    return trackNode;
  });

  const edges: PipelineTrackEdge[] = [];
  for (const node of dag.nodes) {
    if (!node.needs) continue;
    const fromIds = predecessorIds(dag, node.needs);
    for (const fromId of fromIds) {
      const fromStage = snapshotsById.get(fromId);
      const edge: PipelineTrackEdge = { from: fromId, to: node.id };
      if (
        fromStage?.status === "succeeded" &&
        fromStage.envelope?.summary
      ) {
        edge.envelope_summary = fromStage.envelope.summary;
      }
      edges.push(edge);
    }
  }

  return { nodes, edges };
}
