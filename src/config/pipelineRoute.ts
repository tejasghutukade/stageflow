/**
 * Parsing/normalization for the additive `route` stage field
 * (docs/specs/route-based-pipeline-wiring.md). Mirrors the shape of
 * pipelineNeeds.ts: `parsePipelineRoute` validates raw YAML/JSON input at
 * parse time, `toRouteEdges`/`toRouteLoopEntries` normalize an already-typed
 * `PipelineRoute` (used by the `resolvePipelineDagFromRefs` seam, which may
 * receive un-validated refs built directly in TypeScript/tests).
 *
 * Ticket 01 handled forward entries (`{ to, on? }`) only. Ticket 03 adds the
 * loop entry shape (`{ type: "loop", to, max_replays, on_max_replays,
 * replay_session }`) — same replay-policy fields `FeedbackLoopConfig`
 * carries today, `target` renamed to `to`. Loop entries never produce a
 * forward edge: `toRouteEdges` skips them, `toRouteLoopEntries` extracts
 * them for the resolver's replay validation/synthesis.
 */
import type {
  PipelineRoute,
  PipelineRouteEdge,
  PipelineRouteEntry,
  PipelineRouteForwardEntry,
  PipelineRouteLoopEntry,
  RouteTerminalState,
} from "../types/pipeline.js";
import { isNeedTerminalState } from "./pipelineNeeds.js";
import { parseRouteIf } from "./routeIf.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForwardRouteEntry(entry: PipelineRouteEntry): entry is PipelineRouteForwardEntry {
  return !("type" in entry) || entry.type === undefined;
}

export function isLoopRouteEntry(entry: PipelineRouteEntry): entry is PipelineRouteLoopEntry {
  return "type" in entry && entry.type === "loop";
}

const ALLOWED_LOOP_ITEM_KEYS = new Set([
  "type",
  "to",
  "max_replays",
  "on_max_replays",
  "replay_session",
]);

function parseRouteLoopEntry(
  item: Record<string, unknown>,
  stageId: string,
): { ok: true; value: PipelineRouteLoopEntry } | ParsePipelineRouteFailure {
  if ("if" in item) {
    return {
      ok: false,
      message: `stage "${stageId}": if is not allowed on a loop route entry`,
      code: "pipeline.route_if_invalid",
    };
  }

  for (const key of Object.keys(item)) {
    if (!ALLOWED_LOOP_ITEM_KEYS.has(key)) {
      return {
        ok: false,
        message: `stage "${stageId}": route item: unknown key "${key}"`,
      };
    }
  }

  if (typeof item.to !== "string" || !item.to) {
    return {
      ok: false,
      message: `stage "${stageId}": route item must have a non-empty "to" stage id`,
    };
  }

  if (!Number.isInteger(item.max_replays) || (item.max_replays as number) < 1) {
    return {
      ok: false,
      message: `stage "${stageId}": route "${item.to}": max_replays must be a positive integer`,
    };
  }

  if (item.on_max_replays !== "require_continue" && item.on_max_replays !== "wait_for_human") {
    return {
      ok: false,
      message: `stage "${stageId}": route "${item.to}": on_max_replays must be "require_continue" or "wait_for_human"`,
    };
  }

  if (item.replay_session !== "resume" && item.replay_session !== "new_session") {
    return {
      ok: false,
      message: `stage "${stageId}": route "${item.to}": replay_session must be "resume" or "new_session"`,
    };
  }

  return {
    ok: true,
    value: {
      type: "loop",
      to: item.to,
      max_replays: item.max_replays as number,
      on_max_replays: item.on_max_replays as PipelineRouteLoopEntry["on_max_replays"],
      replay_session: item.replay_session as PipelineRouteLoopEntry["replay_session"],
    },
  };
}

function parseRouteOn(
  raw: unknown,
  stageId: string,
  targetId: string,
): { ok: true; value: RouteTerminalState[] } | { ok: false; message: string } {
  if (raw === undefined) {
    return { ok: true, value: ["succeeded"] };
  }
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) {
    return {
      ok: false,
      message: `stage "${stageId}": route "${targetId}": on must be a non-empty unique subset of succeeded, failed, skipped`,
    };
  }
  const seen = new Set<string>();
  const on: RouteTerminalState[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !isNeedTerminalState(item) || seen.has(item)) {
      return {
        ok: false,
        message: `stage "${stageId}": route "${targetId}": on must be a non-empty unique subset of succeeded, failed, skipped`,
      };
    }
    seen.add(item);
    on.push(item);
  }
  return { ok: true, value: on };
}

/**
 * Parse+validate a raw `route:` field for one stage. Each item is either a
 * forward entry (`{ to, on? }`) or a loop entry (`{ type: "loop", to,
 * max_replays, on_max_replays, replay_session }`); entries are never bare
 * strings (route entries are always structured objects, per the spec).
 */
export type ParsePipelineRouteFailure = {
  ok: false;
  message: string;
  code?: "pipeline.route_if_invalid";
};

export function parsePipelineRoute(
  raw: unknown,
  stageId: string,
): { ok: true; value: PipelineRouteEntry[] } | ParsePipelineRouteFailure {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      message: `stage "${stageId}": route must be a non-empty array`,
    };
  }
  if (raw.length < 1) {
    return {
      ok: false,
      message: `stage "${stageId}": route array must contain at least one item`,
    };
  }

  const entries: PipelineRouteEntry[] = [];
  const seenTargets = new Set<string>();

  for (const item of raw) {
    if (!isPlainObject(item)) {
      return {
        ok: false,
        message: `stage "${stageId}": route item must be an object { to, on? }`,
      };
    }

    if (item.type !== undefined && item.type !== "loop") {
      return {
        ok: false,
        message: `stage "${stageId}": route item: type must be "loop" if present, got "${String(item.type)}"`,
      };
    }

    if (item.type === "loop") {
      const loopResult = parseRouteLoopEntry(item, stageId);
      if (!loopResult.ok) return loopResult;

      if (seenTargets.has(loopResult.value.to)) {
        return {
          ok: false,
          message: `stage "${stageId}": route contains duplicate target "${loopResult.value.to}"`,
        };
      }
      seenTargets.add(loopResult.value.to);
      entries.push(loopResult.value);
      continue;
    }

    for (const key of Object.keys(item)) {
      if (key !== "to" && key !== "on" && key !== "if") {
        return {
          ok: false,
          message: `stage "${stageId}": route item: unknown key "${key}"`,
        };
      }
    }

    if (typeof item.to !== "string" || !item.to) {
      return {
        ok: false,
        message: `stage "${stageId}": route item must have a non-empty "to" stage id`,
      };
    }

    if (seenTargets.has(item.to)) {
      return {
        ok: false,
        message: `stage "${stageId}": route contains duplicate target "${item.to}"`,
      };
    }

    const onResult = parseRouteOn(item.on, stageId, item.to);
    if (!onResult.ok) return onResult;

    let routeIf: PipelineRouteForwardEntry["if"];
    if (item.if !== undefined) {
      const ifResult = parseRouteIf(item.if, stageId, item.to);
      if (!ifResult.ok) return ifResult;
      if (onResult.value.length !== 1 || onResult.value[0] !== "succeeded") {
        return {
          ok: false,
          message: `stage "${stageId}": route "${item.to}": if is only allowed with on succeeded`,
          code: "pipeline.route_if_invalid",
        };
      }
      routeIf = ifResult.value;
    }

    seenTargets.add(item.to);
    entries.push({
      to: item.to,
      on: onResult.value,
      ...(routeIf !== undefined ? { if: routeIf } : {}),
    });
  }

  return { ok: true, value: entries };
}

/**
 * Normalize an already-typed `route` value (as found on a `PipelineStageRef`,
 * which may be hand-built in TypeScript and not have gone through
 * `parsePipelineRoute`) into forward route edges with `on` always populated.
 * Loop entries are skipped — they contribute no forward edge.
 */
export function toRouteEdges(route: PipelineRoute | undefined): PipelineRouteEdge[] {
  if (route === undefined) return [];
  const edges: PipelineRouteEdge[] = [];
  for (const item of route) {
    if (!isForwardRouteEntry(item)) continue;
    const on = item.on === undefined ? ["succeeded"] : Array.isArray(item.on) ? item.on : [item.on];
    edges.push({
      to: item.to,
      on: on as RouteTerminalState[],
      ...(item.if !== undefined ? { if: item.if } : {}),
    });
  }
  return edges;
}

/**
 * Extract the loop entries from an already-typed `route` value (mirrors
 * `toRouteEdges`, the forward-entry counterpart). Used by the resolver to
 * validate replay policy and synthesize the legacy `feedback_loop` shape on
 * the resolved DAG node.
 */
export function toRouteLoopEntries(route: PipelineRoute | undefined): PipelineRouteLoopEntry[] {
  if (route === undefined) return [];
  return route.filter(isLoopRouteEntry);
}
