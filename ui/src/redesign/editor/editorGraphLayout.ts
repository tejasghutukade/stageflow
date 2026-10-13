import type { DraftPackagePayload } from "../../api";
import { getStageForm, resolvedStageModel } from "../workshop/inspector/stageFields";
import { needsTargets, stageRefFor } from "../workshop/stageMutators";
import { editorGraphSummary } from "./editorLiveGraph";
import type { EditorLiveGraph } from "./editorLiveGraph";
import type { StageStats } from "./editorStageStats";

export type { StageStats };

export const STAGE_CARD_WIDTH = 218;
export const STAGE_CARD_GAP = 16;
export const CONNECTOR_HEIGHT = 28;
export const STRAIGHT_CONNECTOR_HEIGHT = 22;
export const CONNECTOR_STUB = 14;
export const RAIL_PAD = 16;
export const RAIL_SPACING = 10;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatDurationShort(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
}

export function formatStageStats(stats: StageStats | null | undefined): string {
  if (!stats || stats.runs <= 0) return "no runs yet";
  const parts: string[] = [];
  if (isFiniteNumber(stats.avgMs)) parts.push(`avg ${formatDurationShort(stats.avgMs)}`);
  if (isFiniteNumber(stats.avgCostUsd)) parts.push(`$${stats.avgCostUsd.toFixed(2)}`);
  if (isFiniteNumber(stats.passRate)) parts.push(`${Math.round(stats.passRate * 100)}% pass`);
  if (parts.length === 0) return `${stats.runs} ${stats.runs === 1 ? "run" : "runs"}`;
  return parts.join(" · ");
}

export function editorGraphToolbarSummary(
  stageCount: number,
  lanes: number,
  p50Ms: number | null | undefined,
): string {
  const base = editorGraphSummary(stageCount, lanes);
  return isFiniteNumber(p50Ms) ? `${base} · p50 ${formatDurationShort(p50Ms)}` : base;
}

export type EditorStageCardModel = {
  model: string | null;
  gateKinds: string[];
  needs: string[];
};

export function editorStageCardModel(
  draft: DraftPackagePayload,
  stageId: string,
  defaultModel: string | null,
): EditorStageCardModel {
  const form = getStageForm(draft, stageId);
  return {
    model: form ? resolvedStageModel(draft, form, defaultModel) : null,
    gateKinds: form?.gateKinds ?? [],
    needs: needsTargets(stageRefFor(draft, stageId)?.needs),
  };
}

export function stageRowWidth(count: number): number {
  return count <= 0 ? 0 : count * STAGE_CARD_WIDTH + (count - 1) * STAGE_CARD_GAP;
}

export function stageRowCenters(count: number, rowsWidth: number): number[] {
  const offset = (rowsWidth - stageRowWidth(count)) / 2;
  return Array.from(
    { length: Math.max(0, count) },
    (_, index) => offset + index * (STAGE_CARD_WIDTH + STAGE_CARD_GAP) + STAGE_CARD_WIDTH / 2,
  );
}

export type ConnectorEdge = { from: number; to: number; highlighted?: boolean };

export type ConnectorRail = {
  x: number;
  kind: "start" | "pass" | "end";
  node?: number;
  highlighted?: boolean;
};

export type ConnectorSegment = {
  axis: "x" | "y";
  left: number;
  top: number;
  length: number;
  highlighted: boolean;
};

export type ConnectorGeometry = {
  width: number;
  height: number;
  segments: ConnectorSegment[];
};

type Endpoint = { x: number };
type Link = { top: number; bottom: number; highlighted: boolean };

function linkComponents(links: Link[]): Link[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id) ?? id;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  for (const link of links) {
    const a = find(`t${link.top}`);
    const b = find(`b${link.bottom}`);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const root = find(`t${link.top}`);
    const list = groups.get(root) ?? [];
    list.push(link);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function mergeOverlapping(
  groups: Link[][],
  span: (group: Link[]) => { min: number; max: number },
  isStraight: (group: Link[]) => boolean,
): Link[][] {
  const result = groups.map((group) => [...group]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length && !merged; i += 1) {
      for (let j = i + 1; j < result.length && !merged; j += 1) {
        if (isStraight(result[i]!) || isStraight(result[j]!)) continue;
        const a = span(result[i]!);
        const b = span(result[j]!);
        if (a.min < b.max && b.min < a.max) {
          result[i] = [...result[i]!, ...result[j]!];
          result.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return result;
}

function crossbarSegments(
  xs: number[],
  spans: { min: number; max: number; highlighted: boolean }[],
  top: number,
): ConnectorSegment[] {
  const points = [...new Set(xs)].sort((a, b) => a - b);
  const pieces: { start: number; end: number; highlighted: boolean }[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const highlighted = spans.some((span) => span.highlighted && span.min <= start && span.max >= end);
    const last = pieces[pieces.length - 1];
    if (last && last.highlighted === highlighted) last.end = end;
    else pieces.push({ start, end, highlighted });
  }
  return pieces.map((piece, index) => ({
    axis: "x",
    left: piece.start,
    top,
    length: piece.end - piece.start + (index === pieces.length - 1 ? 1 : 0),
    highlighted: piece.highlighted,
  }));
}

export function connectorGeometry(
  parentCount: number,
  childCount: number,
  edges: ConnectorEdge[],
  options: { rowsWidth?: number; width?: number; rails?: ConnectorRail[] } = {},
): ConnectorGeometry {
  const rowsWidth = options.rowsWidth ?? Math.max(stageRowWidth(parentCount), stageRowWidth(childCount));
  const width = Math.max(options.width ?? rowsWidth, rowsWidth);
  const rails = options.rails ?? [];
  const parentX = stageRowCenters(parentCount, rowsWidth);
  const childX = stageRowCenters(childCount, rowsWidth);

  const tops: Endpoint[] = parentX.map((x) => ({ x }));
  const bottoms: Endpoint[] = childX.map((x) => ({ x }));
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.from < 0 || edge.from >= parentCount || edge.to < 0 || edge.to >= childCount) continue;
    const id = `${edge.from}>${edge.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    links.push({ top: edge.from, bottom: edge.to, highlighted: Boolean(edge.highlighted) });
  }
  const passRails: ConnectorRail[] = [];
  for (const rail of rails) {
    const highlighted = Boolean(rail.highlighted);
    if (rail.kind === "pass") {
      passRails.push(rail);
    } else if (rail.kind === "start") {
      if (rail.node === undefined || rail.node < 0 || rail.node >= parentCount) continue;
      bottoms.push({ x: rail.x });
      links.push({ top: rail.node, bottom: bottoms.length - 1, highlighted });
    } else {
      if (rail.node === undefined || rail.node < 0 || rail.node >= childCount) continue;
      tops.push({ x: rail.x });
      links.push({ top: tops.length - 1, bottom: rail.node, highlighted });
    }
  }

  const isStraight = (group: Link[]) =>
    group.length === 1 && tops[group[0]!.top]!.x === bottoms[group[0]!.bottom]!.x;
  const components = mergeOverlapping(
    linkComponents(links),
    (group) => {
      const xs = group.flatMap((link) => [tops[link.top]!.x, bottoms[link.bottom]!.x]);
      return { min: Math.min(...xs), max: Math.max(...xs) };
    },
    isStraight,
  );
  const straight =
    rails.every((rail) => rail.kind === "pass") && components.every(isStraight);
  const height = straight ? STRAIGHT_CONNECTOR_HEIGHT : CONNECTOR_HEIGHT;
  const mid = CONNECTOR_STUB;
  const segments: ConnectorSegment[] = [];

  for (const rail of passRails) {
    segments.push({ axis: "y", left: rail.x, top: 0, length: height, highlighted: Boolean(rail.highlighted) });
  }

  for (const group of components) {
    if (isStraight(group)) {
      const link = group[0]!;
      segments.push({
        axis: "y",
        left: tops[link.top]!.x,
        top: 0,
        length: height,
        highlighted: link.highlighted,
      });
      continue;
    }
    const topIds = [...new Set(group.map((link) => link.top))];
    const bottomIds = [...new Set(group.map((link) => link.bottom))];
    for (const id of topIds) {
      const touching = group.filter((link) => link.top === id);
      segments.push({
        axis: "y",
        left: tops[id]!.x,
        top: 0,
        length: mid,
        highlighted: touching.every((link) => link.highlighted),
      });
    }
    const xs = [...topIds.map((id) => tops[id]!.x), ...bottomIds.map((id) => bottoms[id]!.x)];
    const spans = group.map((link) => {
      const a = tops[link.top]!.x;
      const b = bottoms[link.bottom]!.x;
      return { min: Math.min(a, b), max: Math.max(a, b), highlighted: link.highlighted };
    });
    segments.push(...crossbarSegments(xs, spans, mid));
    for (const id of bottomIds) {
      const touching = group.filter((link) => link.bottom === id);
      segments.push({
        axis: "y",
        left: bottoms[id]!.x,
        top: mid,
        length: height - mid,
        highlighted: touching.every((link) => link.highlighted),
      });
    }
  }

  segments.sort((a, b) => Number(a.highlighted) - Number(b.highlighted));
  return { width, height, segments };
}

export type EditorGraphCardNode = { key: string; stageId: string; loops: string[] };

export type EditorGraphRail = { x: number; highlighted: boolean };

export type EditorGraphRow = { nodes: EditorGraphCardNode[]; rails: EditorGraphRail[] };

export type EditorGraphLayout = {
  stageCount: number;
  lanes: number;
  rowsWidth: number;
  width: number;
  railCount: number;
  rows: EditorGraphRow[];
  connectors: ConnectorGeometry[];
};

export function railX(rowsWidth: number, lane: number): number {
  return rowsWidth + RAIL_PAD + lane * RAIL_SPACING;
}

export function buildEditorGraphLayout(
  graph: Pick<EditorLiveGraph, "stageCount" | "layers" | "edges">,
  selectedStageId: string | null,
): EditorGraphLayout {
  const loopTarget = new Map<string, string>();
  for (const layer of graph.layers) {
    for (const node of layer) if (node.loop) loopTarget.set(node.key, node.stageId);
  }
  const loops = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const target = loopTarget.get(edge.to);
    if (target === undefined) continue;
    const list = loops.get(edge.from) ?? [];
    if (!list.includes(target)) list.push(target);
    loops.set(edge.from, list);
  }

  const cardRows = graph.layers
    .map((layer) =>
      layer
        .filter((node) => !node.loop)
        .map((node): EditorGraphCardNode => ({
          key: node.key,
          stageId: node.stageId,
          loops: loops.get(node.stageId) ?? [],
        })),
    )
    .filter((row) => row.length > 0);

  const position = new Map<string, { row: number; index: number }>();
  cardRows.forEach((row, rowIndex) => {
    row.forEach((node, index) => position.set(node.key, { row: rowIndex, index }));
  });

  type PlacedEdge = {
    from: { row: number; index: number };
    to: { row: number; index: number };
    highlighted: boolean;
  };
  const direct: PlacedEdge[] = [];
  const skip: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to || to.row <= from.row) continue;
    const highlighted =
      selectedStageId !== null && (edge.from === selectedStageId || edge.to === selectedStageId);
    (to.row === from.row + 1 ? direct : skip).push({ from, to, highlighted });
  }

  skip.sort((a, b) => a.from.row - b.from.row || a.to.row - b.to.row || a.from.index - b.from.index);
  const laneEnds: number[] = [];
  const skipLanes = skip.map((edge) => {
    const lastConnector = edge.to.row - 1;
    const lane = laneEnds.findIndex((end) => end < edge.from.row);
    if (lane >= 0) {
      laneEnds[lane] = lastConnector;
      return lane;
    }
    laneEnds.push(lastConnector);
    return laneEnds.length - 1;
  });

  const rowsWidth = cardRows.reduce((max, row) => Math.max(max, stageRowWidth(row.length)), 0);
  const railCount = laneEnds.length;
  const width = railCount > 0 ? railX(rowsWidth, railCount - 1) + 1 : rowsWidth;

  const rows: EditorGraphRow[] = cardRows.map((nodes, rowIndex) => ({
    nodes,
    rails: skip.flatMap((edge, index) =>
      edge.from.row < rowIndex && edge.to.row > rowIndex
        ? [{ x: railX(rowsWidth, skipLanes[index]!), highlighted: edge.highlighted }]
        : [],
    ),
  }));

  const connectors: ConnectorGeometry[] = [];
  for (let k = 0; k < cardRows.length - 1; k += 1) {
    const edges: ConnectorEdge[] = direct
      .filter((edge) => edge.from.row === k)
      .map((edge) => ({ from: edge.from.index, to: edge.to.index, highlighted: edge.highlighted }));
    const rails: ConnectorRail[] = [];
    skip.forEach((edge, index) => {
      const x = railX(rowsWidth, skipLanes[index]!);
      if (edge.from.row === k) {
        rails.push({ x, kind: "start", node: edge.from.index, highlighted: edge.highlighted });
      } else if (edge.to.row === k + 1) {
        rails.push({ x, kind: "end", node: edge.to.index, highlighted: edge.highlighted });
      } else if (edge.from.row < k && edge.to.row > k + 1) {
        rails.push({ x, kind: "pass", highlighted: edge.highlighted });
      }
    });
    connectors.push(
      connectorGeometry(cardRows[k]!.length, cardRows[k + 1]!.length, edges, { rowsWidth, width, rails }),
    );
  }

  return {
    stageCount: graph.stageCount,
    lanes: cardRows.reduce((max, row) => Math.max(max, row.length), 0),
    rowsWidth,
    width,
    railCount,
    rows,
    connectors,
  };
}
