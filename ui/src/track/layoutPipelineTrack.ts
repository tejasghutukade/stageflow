import type {
  PipelineTrackEdge,
  PipelineTrackNode,
  PipelineTrackProjection,
} from "../api";

export function groupNodesByLayer(
  nodes: PipelineTrackNode[],
): PipelineTrackNode[][] {
  const byLayer = new Map<number, PipelineTrackNode[]>();
  for (const node of nodes) {
    const layer = byLayer.get(node.layer) ?? [];
    layer.push(node);
    byLayer.set(node.layer, layer);
  }
  return [...byLayer.keys()]
    .sort((a, b) => a - b)
    .map((layer) =>
      (byLayer.get(layer) ?? []).sort((a, b) => a.layer_order - b.layer_order),
    );
}

export function detailListOrder(nodes: PipelineTrackNode[]): PipelineTrackNode[] {
  return groupNodesByLayer(nodes).flat();
}

function layerByStageId(nodes: PipelineTrackNode[]): Map<string, number> {
  return new Map(nodes.map((n) => [n.stage_id, n.layer]));
}

export function isLinearPipelineTrack(
  projection: PipelineTrackProjection,
): boolean {
  const { nodes, edges } = projection;
  if (nodes.length <= 1) return true;

  const layers = groupNodesByLayer(nodes);
  if (!layers.every((layer) => layer.length === 1)) return false;

  if (edges.length !== nodes.length - 1) return false;

  const ordered = detailListOrder(nodes);
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]!.stage_id;
    const to = ordered[i + 1]!.stage_id;
    if (!edges.some((e) => e.from === from && e.to === to)) return false;
  }
  return true;
}

export const SPATIAL_COL_W = 520;
export const SPATIAL_ROW_H = 340;
export const SPATIAL_NODE_W = 400;
export const SPATIAL_NODE_H = 128;

export type SpatialNodeBox = {
  stageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layerIndex: number;
  indexInLayer: number;
};

export type SpatialEdge = {
  from: string;
  to: string;
};

export type SpatialTrackLayout = {
  nodes: SpatialNodeBox[];
  edges: SpatialEdge[];
};

export type SpatialFallbackIds = {
  liveStageIds?: string[];
  plannedStageIds?: string[];
};

function spatialBox(
  stageId: string,
  layerIndex: number,
  indexInLayer: number,
  yOffset = 0,
): SpatialNodeBox {
  return {
    stageId,
    x: layerIndex * SPATIAL_COL_W,
    y: yOffset + indexInLayer * SPATIAL_ROW_H,
    width: SPATIAL_NODE_W,
    height: SPATIAL_NODE_H,
    layerIndex,
    indexInLayer,
  };
}

export function spatialLayerYOffset(layerCount: number, maxLayerCount: number): number {
  if (maxLayerCount <= 1 || layerCount >= maxLayerCount) return 0;
  return ((maxLayerCount - layerCount) / 2) * SPATIAL_ROW_H;
}

function fallbackStageIds(fallback?: SpatialFallbackIds): string[] {
  const planned = fallback?.plannedStageIds ?? [];
  const live = fallback?.liveStageIds ?? [];
  if (planned.length === 0) return live;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of planned) {
    seen.add(id);
    ids.push(id);
  }
  for (const id of live) {
    if (!seen.has(id)) ids.push(id);
  }
  return ids;
}

export function layoutSpatialTrack(
  projection: PipelineTrackProjection,
  fallback?: SpatialFallbackIds,
): SpatialTrackLayout {
  if (!projection.nodes.length) {
    const ids = fallbackStageIds(fallback);
    return {
      nodes: ids.map((id, index) => spatialBox(id, index, 0)),
      edges: ids.slice(1).map((to, index) => ({ from: ids[index]!, to })),
    };
  }

  const layers = groupNodesByLayer(projection.nodes);
  const maxLayerCount = layers.reduce((max, layer) => Math.max(max, layer.length), 0);
  const nodes = layers.flatMap((layer, layerIndex) => {
    const yOffset = spatialLayerYOffset(layer.length, maxLayerCount);
    return layer.map((node, indexInLayer) =>
      spatialBox(node.stage_id, layerIndex, indexInLayer, yOffset),
    );
  });
  return {
    nodes,
    edges: projection.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}

export function edgesBetweenLayers(
  edges: PipelineTrackEdge[],
  nodes: PipelineTrackNode[],
  fromLayer: number,
  toLayer: number,
): PipelineTrackEdge[] {
  const layers = layerByStageId(nodes);
  return edges.filter((edge) => {
    const from = layers.get(edge.from);
    const to = layers.get(edge.to);
    return from === fromLayer && to === toLayer;
  });
}
