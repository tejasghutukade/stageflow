import type {
  DraftPackagePayload,
  PipelineTrackEdge,
  PipelineTrackNode,
  PipelineTrackProjection,
} from "../../api";
import type { DagTrackNode } from "../../components/PipelineDagTrack";
import { buildEditorLiveGraph } from "./editorLiveGraph";

export function projectionFromDraft(draft: DraftPackagePayload): PipelineTrackProjection {
  const graph = buildEditorLiveGraph(draft);
  const primary = new Set(
    graph.layers.flatMap((layer) => layer.filter((node) => !node.loop).map((node) => node.key)),
  );
  const nodes: PipelineTrackNode[] = [];
  graph.layers.forEach((layer, layerIndex) => {
    layer.forEach((node, order) => {
      if (node.loop) return;
      nodes.push({
        stage_id: node.stageId,
        status: "pending",
        readiness: "ready",
        layer: layerIndex,
        layer_order: order,
      });
    });
  });
  const edges: PipelineTrackEdge[] = graph.edges.filter(
    (edge) => primary.has(edge.from) && primary.has(edge.to),
  );
  return { nodes, edges };
}

export function buildEditorDag(
  draft: DraftPackagePayload,
  selectedStageId?: string | null,
): {
  summary: string;
  stageCount: number;
  lanes: number;
  dagLayers: DagTrackNode[][];
  layerIndices: number[];
  trackNodes: PipelineTrackNode[];
  edges: PipelineTrackEdge[];
} {
  const graph = buildEditorLiveGraph(draft);
  const dagLayers: DagTrackNode[][] = graph.layers.map((layer) =>
    layer.map((node) => ({
      id: node.key,
      label: node.stageId,
      status: "pending",
      stageStatus: "pending",
      selected: node.stageId === selectedStageId,
      meta: node.loop ? "loop" : undefined,
      chips: node.chips,
      selectId: node.stageId,
    })),
  );
  const trackNodes: PipelineTrackNode[] = graph.layers.flatMap((layer, layerIndex) =>
    layer.map((node, order) => ({
      stage_id: node.key,
      status: "pending" as const,
      readiness: "ready" as const,
      layer: layerIndex,
      layer_order: order,
    })),
  );
  return {
    summary: graph.summary,
    stageCount: graph.stageCount,
    lanes: graph.lanes,
    dagLayers,
    layerIndices: graph.layers.map((_, index) => index),
    trackNodes,
    edges: graph.edges,
  };
}
