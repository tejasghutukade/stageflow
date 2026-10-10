import {
  SPATIAL_COL_W,
  SPATIAL_ROW_H,
  type SpatialTrackLayout,
} from "../../track/layoutPipelineTrack";

export const GRAPH_BAND_NODE_W = 120;
export const GRAPH_BAND_COL_STEP = 160;
export const GRAPH_BAND_ROW_STEP = 72;
export const GRAPH_BAND_PAD_X = 40;
export const GRAPH_BAND_PAD_Y = 48;
export const GRAPH_BAND_MIN_HEIGHT = 160;

export type GraphBandNodeBox = {
  stageId: string;
  x: number;
  y: number;
  width: number;
};

export type GraphBandLayout = {
  nodes: GraphBandNodeBox[];
  edges: SpatialTrackLayout["edges"];
  width: number;
  height: number;
};

export function layoutGraphBandTrack(spatial: SpatialTrackLayout): GraphBandLayout {
  if (spatial.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: GRAPH_BAND_MIN_HEIGHT };
  }

  const scaleX = GRAPH_BAND_COL_STEP / SPATIAL_COL_W;
  const scaleY = GRAPH_BAND_ROW_STEP / SPATIAL_ROW_H;

  const nodes: GraphBandNodeBox[] = spatial.nodes.map((node) => ({
    stageId: node.stageId,
    x: GRAPH_BAND_PAD_X + node.x * scaleX,
    y: GRAPH_BAND_PAD_Y + node.y * scaleY,
    width: GRAPH_BAND_NODE_W,
  }));

  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + 64));

  return {
    nodes,
    edges: spatial.edges,
    width: maxX + GRAPH_BAND_PAD_X,
    height: Math.max(GRAPH_BAND_MIN_HEIGHT, maxY + GRAPH_BAND_PAD_Y),
  };
}

export function graphBandEdgeSegment(
  from: GraphBandNodeBox,
  to: GraphBandNodeBox,
): { left: number; top: number; width: number } | null {
  const top = from.y + 24;
  const left = from.x + from.width;
  const width = to.x - left;
  if (width <= 0) return null;
  return { left, top, width };
}
