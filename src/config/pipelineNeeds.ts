import type {
  NeedTerminalState,
  PipelineNeedEdge,
  PipelineNeedItem,
  PipelineNeeds,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";

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

export function toNeedEdges(needs: string | PipelineNeedItem[] | undefined): PipelineNeedEdge[] {
  if (needs === undefined) return [];
  if (typeof needs === "string") {
    return needs ? [{ id: needs, on: ["succeeded"] }] : [];
  }
  return needs.map((item) =>
    typeof item === "string"
      ? { id: item, on: ["succeeded"] }
      : { id: item.id, on: item.on && item.on.length > 0 ? item.on : ["succeeded"] },
  );
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
      edges.push({ id: item.id, on: on.length > 0 ? on : ["succeeded"] });
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
