import type {
  NeedTerminalState,
  PipelineNeedEdge,
  PipelineNeedItem,
  PipelineNeeds,
  PipelineRoute,
  PipelineRouteForwardEntry,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import { parseRouteIf } from "./routeIf.js";

export const NEED_TERMINAL_STATES: readonly NeedTerminalState[] = [
  "succeeded",
  "failed",
  "skipped",
];

const NEED_TERMINAL_STATE_SET = new Set<string>(NEED_TERMINAL_STATES);

export function isNeedTerminalState(value: unknown): value is NeedTerminalState {
  return typeof value === "string" && NEED_TERMINAL_STATE_SET.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNeedOn(
  raw: unknown,
  stageId: string,
  parentId: string,
): { ok: true; value: NeedTerminalState[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      message: `stage "${stageId}": needs "${parentId}": on must be a non-empty unique subset of succeeded, failed, skipped`,
    };
  }
  const seen = new Set<string>();
  const on: NeedTerminalState[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !NEED_TERMINAL_STATE_SET.has(item) || seen.has(item)) {
      return {
        ok: false,
        message: `stage "${stageId}": needs "${parentId}": on must be a non-empty unique subset of succeeded, failed, skipped`,
      };
    }
    seen.add(item);
    on.push(item as NeedTerminalState);
  }
  return { ok: true, value: on };
}

export function parsePipelineNeeds(
  raw: unknown,
  stageId: string,
): { ok: true; value: PipelineNeeds } | { ok: false; message: string } {
  if (typeof raw === "string") {
    if (!raw) {
      return { ok: false, message: `stage "${stageId}": needs must be a non-empty string` };
    }
    return { ok: true, value: raw };
  }

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message: `stage "${stageId}": needs must be a non-empty string or a non-empty array`,
    };
  }

  if (raw.length < 1) {
    return {
      ok: false,
      message: `stage "${stageId}": needs array must contain at least one item`,
    };
  }

  const edges: PipelineNeedEdge[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item === "string") {
      if (!item) {
        return {
          ok: false,
          message: `stage "${stageId}": needs item must be a stage id or { id, on }`,
        };
      }
      if (seen.has(item)) {
        return {
          ok: false,
          message: `stage "${stageId}": needs contains duplicate id "${item}"`,
        };
      }
      seen.add(item);
      edges.push({ id: item, on: ["succeeded"] });
      continue;
    }

    if (!isPlainObject(item)) {
      return {
        ok: false,
        message: `stage "${stageId}": needs item must be a stage id or { id, on }`,
      };
    }

    for (const key of Object.keys(item)) {
      if (key !== "id" && key !== "on") {
        return {
          ok: false,
          message: `stage "${stageId}": needs item: unknown key "${key}"`,
        };
      }
    }

    if (typeof item.id !== "string" || !item.id) {
      return {
        ok: false,
        message: `stage "${stageId}": needs item must be a stage id or { id, on }`,
      };
    }

    if (seen.has(item.id)) {
      return {
        ok: false,
        message: `stage "${stageId}": needs contains duplicate id "${item.id}"`,
      };
    }

    const onResult = parseNeedOn(item.on, stageId, item.id);
    if (!onResult.ok) return onResult;

    seen.add(item.id);
    edges.push({ id: item.id, on: onResult.value });
  }

  return { ok: true, value: edges };
}

export function toNeedEdges(
  needs: PipelineNeeds | PipelineNeedItem[] | undefined,
): PipelineNeedEdge[] {
  if (needs === undefined) return [];
  if (typeof needs === "string") {
    return needs ? [{ id: needs, on: ["succeeded"] }] : [];
  }
  return needs.map((item) => {
    if (typeof item === "string") {
      return { id: item, on: ["succeeded"] };
    }
    const edge: PipelineNeedEdge = {
      id: item.id,
      on: item.on && item.on.length > 0 ? item.on : ["succeeded"],
    };
    if ("if" in item && item.if !== undefined) {
      edge.if = item.if;
    }
    return edge;
  });
}

export function toPipelineNeeds(edges: PipelineNeedEdge[]): PipelineNeeds {
  const only = edges[0];
  if (
    edges.length === 1 &&
    only !== undefined &&
    only.on.length === 1 &&
    only.on[0] === "succeeded" &&
    only.if === undefined
  ) {
    return only.id;
  }
  return edges;
}

function isForwardRouteEntry(
  entry: PipelineRoute[number],
): entry is PipelineRouteForwardEntry {
  return !("type" in entry) || entry.type === undefined;
}

export function invertRouteToPredecessorEdges(
  sources: ReadonlyArray<{ id: string; route?: PipelineRoute }>,
): Map<string, PipelineNeedEdge[]> {
  const inbound = new Map<string, PipelineNeedEdge[]>();
  for (const source of sources) {
    if (source.route === undefined) continue;
    for (const item of source.route) {
      if (!isForwardRouteEntry(item)) continue;
      const on =
        item.on === undefined
          ? (["succeeded"] as NeedTerminalState[])
          : Array.isArray(item.on)
            ? item.on
            : [item.on];
      const list = inbound.get(item.to) ?? [];
      const edge: PipelineNeedEdge = { id: source.id, on };
      if (item.if !== undefined) edge.if = item.if;
      list.push(edge);
      inbound.set(item.to, list);
    }
  }
  return inbound;
}

export type OutboundRouteInversion = {
  route?: PipelineRouteForwardEntry[];
  entry?: boolean;
};

export function invertPredecessorEdgesToRoute(
  stages: ReadonlyArray<{ id: string; needs?: PipelineNeeds }>,
): Map<string, OutboundRouteInversion> {
  const result = new Map<string, OutboundRouteInversion>();
  if (!stages.some((stage) => stage.needs !== undefined)) {
    return result;
  }

  const outbound = new Map<string, PipelineRouteForwardEntry[]>();
  for (const stage of stages) {
    if (stage.needs === undefined) {
      result.set(stage.id, { entry: true });
      continue;
    }
    for (const parent of toNeedEdges(stage.needs)) {
      const list = outbound.get(parent.id) ?? [];
      const entry: PipelineRouteForwardEntry = { to: stage.id, on: parent.on };
      if (parent.if !== undefined) entry.if = parent.if;
      list.push(entry);
      outbound.set(parent.id, list);
    }
  }

  for (const [id, route] of outbound) {
    result.set(id, { ...(result.get(id) ?? {}), route });
  }

  return result;
}

export function predecessorEdges(
  node: Pick<ResolvedPipelineStageNode, "needs" | "needsEdges">,
): PipelineNeedEdge[] {
  if (node.needsEdges !== undefined) return node.needsEdges;
  if (typeof node.needs === "string" && node.needs) {
    return [{ id: node.needs, on: ["succeeded"] }];
  }
  return [];
}

export function hydrateResolvedNeeds(node: {
  needs?: unknown;
  needsEdges?: unknown;
}): { needs: string | null; needsEdges: PipelineNeedEdge[] } {
  if (Array.isArray(node.needsEdges)) {
    const edges: PipelineNeedEdge[] = [];
    for (const item of node.needsEdges) {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) continue;
      const on = Array.isArray(item.on)
        ? item.on.filter((state): state is NeedTerminalState =>
            typeof state === "string" && NEED_TERMINAL_STATE_SET.has(state),
          )
        : (["succeeded"] as NeedTerminalState[]);
      const edge: PipelineNeedEdge = {
        id: item.id,
        on: on.length > 0 ? on : ["succeeded"],
      };
      if (item.if !== undefined) {
        const parsedIf = parseRouteIf(item.if, item.id, item.id);
        if (parsedIf.ok) edge.if = parsedIf.value;
      }
      edges.push(edge);
    }
    if (typeof node.needs === "string") {
      return { needs: node.needs, needsEdges: edges };
    }
    if (node.needs === null) {
      return { needs: null, needsEdges: edges };
    }
    return {
      needs: edges.length === 1 ? edges[0]!.id : null,
      needsEdges: edges,
    };
  }
  if (typeof node.needs === "string" && node.needs) {
    return { needs: node.needs, needsEdges: toNeedEdges(node.needs) };
  }
  return { needs: null, needsEdges: [] };
}
