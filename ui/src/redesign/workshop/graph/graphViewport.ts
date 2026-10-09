export const GRAPH_ZOOM_MIN = 0.5;
export const GRAPH_ZOOM_MAX = 2;
export const GRAPH_ZOOM_STEP = 0.1;
export const GRAPH_CANVAS_PAD_TOP = 42;
export const GRAPH_CANVAS_PAD_BOTTOM = 10;
export const GRAPH_CANVAS_PAD_X = 12;

export type GraphView = { zoom: number; panX: number; panY: number };

export const DEFAULT_GRAPH_VIEW: GraphView = { zoom: 1, panX: 0, panY: 0 };

function clampZoom(zoom: number): number {
  return Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, zoom));
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const tenths = Math.round(zoom / GRAPH_ZOOM_STEP);
  return clampZoom((tenths + direction) * GRAPH_ZOOM_STEP);
}

export function fitGraphView(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): GraphView {
  if (content.width <= 0 || content.height <= 0) return DEFAULT_GRAPH_VIEW;
  const availableWidth = Math.max(1, viewport.width - GRAPH_CANVAS_PAD_X * 2);
  const availableHeight = Math.max(
    1,
    viewport.height - GRAPH_CANVAS_PAD_TOP - GRAPH_CANVAS_PAD_BOTTOM,
  );
  const ratio = Math.min(availableWidth / content.width, availableHeight / content.height);
  const zoom = clampZoom(Math.floor(ratio / GRAPH_ZOOM_STEP + 1e-9) * GRAPH_ZOOM_STEP);
  const panY = Math.max(0, Math.round((availableHeight - content.height * zoom) / 2));
  return { zoom: Number(zoom.toFixed(1)), panX: 0, panY };
}
