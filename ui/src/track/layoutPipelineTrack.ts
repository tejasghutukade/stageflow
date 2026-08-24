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
