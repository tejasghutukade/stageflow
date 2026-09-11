/**
 * Parsing/normalization for the additive `route` stage field
 * (docs/specs/route-based-pipeline-wiring.md, ticket 01). Mirrors the shape
 * of pipelineNeeds.ts: `parsePipelineRoute` validates raw YAML/JSON input at
 * parse time, `toRouteEdges` normalizes an already-typed `PipelineRoute`
 * (used by the `resolvePipelineDagFromRefs` seam, which may receive
 * un-validated refs built directly in TypeScript/tests).
 *
 * This ticket only handles forward entries (`{ to, on? }`). Loop entries
 * (`{ type: "loop", ... }`) are ticket 03's job — `toRouteEdges` skips them.
 */
import type {
  PipelineRoute,
  PipelineRouteEdge,
  PipelineRouteEntry,
  PipelineRouteForwardEntry,
  RouteTerminalState,
} from "../types/pipeline.js";
import { isNeedTerminalState } from "./pipelineNeeds.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForwardRouteEntry(entry: PipelineRouteEntry): entry is PipelineRouteForwardEntry {
  return !("type" in entry) || entry.type === undefined;
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
 * Parse+validate a raw `route:` field for one stage. Only the forward entry
 * shape (`{ to, on? }`) is accepted; entries are never bare strings (route
 * entries are always structured objects, per the spec).
 */
export function parsePipelineRoute(
  raw: unknown,
  stageId: string,
): { ok: true; value: PipelineRouteForwardEntry[] } | { ok: false; message: string } {
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

  const entries: PipelineRouteForwardEntry[] = [];
  const seenTargets = new Set<string>();

  for (const item of raw) {
    if (!isPlainObject(item)) {
      return {
        ok: false,
        message: `stage "${stageId}": route item must be an object { to, on? }`,
      };
    }

    for (const key of Object.keys(item)) {
      if (key !== "to" && key !== "on") {
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

    seenTargets.add(item.to);
    entries.push({ to: item.to, on: onResult.value });
  }

  return { ok: true, value: entries };
}

/**
 * Normalize an already-typed `route` value (as found on a `PipelineStageRef`,
 * which may be hand-built in TypeScript and not have gone through
 * `parsePipelineRoute`) into forward route edges with `on` always populated.
 * Loop entries (ticket 03) are skipped — they contribute no forward edge.
 */
export function toRouteEdges(route: PipelineRoute | undefined): PipelineRouteEdge[] {
  if (route === undefined) return [];
  const edges: PipelineRouteEdge[] = [];
  for (const item of route) {
    if (!isForwardRouteEntry(item)) continue;
    const on = item.on === undefined ? ["succeeded"] : Array.isArray(item.on) ? item.on : [item.on];
    edges.push({ to: item.to, on: on as RouteTerminalState[] });
  }
  return edges;
}
