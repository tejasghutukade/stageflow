import type {
  DraftPackagePayload,
  PipelineStageListing,
  PipelineTrackEdge,
  PipelineTrackNode,
  PipelineTrackProjection,
} from "../../api";
import type { DagTrackNode } from "../../components/PipelineDagTrack";
import type { TrackStage } from "../../components/PipelineTrack";
import { gateLabel } from "../../pages/PipelinesPage";
import { stageMayAsk } from "../../catalogJoin";
import {
  groupNodesByLayer,
  isLinearPipelineTrack,
} from "../../track/layoutPipelineTrack";
import { stageIdFromRef } from "./draftMutators";

function needsTargets(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  return ids;
}

export function projectionFromDraft(
  draft: DraftPackagePayload,
): PipelineTrackProjection {
  const stages = draft.pipeline.stages;
  const ids = stages.map((stage, index) => stageIdFromRef(stage, index));
  const edges: PipelineTrackEdge[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const to = ids[i]!;
    const preds = needsTargets(stage.needs);
    if (preds.length > 0) {
      for (const from of preds) edges.push({ from, to });
    } else if (i > 0) {
      edges.push({ from: ids[i - 1]!, to });
    }
  }

  const layerMemo = new Map<string, number>();
  function layerFor(id: string): number {
    const cached = layerMemo.get(id);
    if (cached !== undefined) return cached;
    const inbound = edges.filter((e) => e.to === id).map((e) => e.from);
    const layer =
      inbound.length === 0
        ? 0
        : Math.max(...inbound.map((from) => layerFor(from))) + 1;
    layerMemo.set(id, layer);
    return layer;
  }
  for (const id of ids) layerFor(id);

  const nodes: PipelineTrackNode[] = ids.map((stageId, index) => {
    const order = edges.filter((e) => e.to === stageId).length;
    return {
      stage_id: stageId,
      status: "pending",
      readiness: "ready",
      layer: layerMemo.get(stageId) ?? index,
      layer_order: order,
    };
  });

  return { nodes, edges };
}

function gateMeta(
  stageId: string,
  listingStages: PipelineStageListing[] | undefined,
): string {
  const listing = listingStages?.find((s) => s.id === stageId);
  return gateLabel(listing?.gate_kinds);
}

export function buildEditorDag(
  draft: DraftPackagePayload,
  listingStages?: PipelineStageListing[],
  selectedStageId?: string | null,
): {
  mode: "linear" | "dag";
  linearStages?: TrackStage[];
  dagLayers?: DagTrackNode[][];
  layerIndices?: number[];
  trackNodes?: PipelineTrackNode[];
  edges?: PipelineTrackEdge[];
} {
  const projection = projectionFromDraft(draft);
  if (isLinearPipelineTrack(projection)) {
    const linearStages: TrackStage[] = projection.nodes.map((node) => {
      const kinds = listingStages?.find((s) => s.id === node.stage_id)?.gate_kinds;
      return {
        id: node.stage_id,
        label: node.stage_id,
        status: stageMayAsk(kinds) ? "waiting" : "pending",
        meta: gateMeta(node.stage_id, listingStages),
        selected: node.stage_id === selectedStageId,
      };
    });
    return { mode: "linear", linearStages };
  }

  const layers = groupNodesByLayer(projection.nodes);
  const layerIndices = layers.map((layer) => layer[0]?.layer ?? 0);
  const dagLayers: DagTrackNode[][] = layers.map((layer) =>
    layer.map((node) => {
      const kinds = listingStages?.find((s) => s.id === node.stage_id)?.gate_kinds;
      return {
        id: node.stage_id,
        label: node.stage_id,
        status: stageMayAsk(kinds) ? "waiting" : "pending",
        stageStatus: "pending",
        selected: node.stage_id === selectedStageId,
        meta: gateMeta(node.stage_id, listingStages),
      };
    }),
  );
  return {
    mode: "dag",
    dagLayers,
    layerIndices,
    trackNodes: projection.nodes,
    edges: projection.edges,
  };
}
