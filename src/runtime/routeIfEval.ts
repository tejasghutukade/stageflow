import type {
  RouteIfLeafPredicate,
  RouteIfOp,
  RouteIfPredicate,
} from "../types/pipeline.js";

const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRouteIfLeaf(predicate: RouteIfPredicate): predicate is RouteIfLeafPredicate {
  return "op" in predicate && predicate.op !== undefined && typeof predicate.field === "string";
}

export type RouteIfEval = "fire" | "miss" | "missing_field";

function readPayloadPath(
  payload: Record<string, unknown> | undefined,
  field: string,
): { ok: true; value: unknown } | { ok: false } {
  if (payload === undefined) return { ok: false };
  const segments = field.split(".");
  let current: unknown = payload;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (!isPlainObject(current) || !hasOwn(current, segment)) {
      return { ok: false };
    }
    current = current[segment];
    if (i < segments.length - 1 && !isPlainObject(current)) {
      return { ok: false };
    }
  }
  return { ok: true, value: current };
}

function compareLeaf(
  op: RouteIfOp,
  actual: unknown,
  expected: unknown,
): RouteIfEval {
  if (op === "eq") return actual === expected ? "fire" : "miss";
  if (op === "ne") return actual !== expected ? "fire" : "miss";
  if (NUMERIC_OPS.has(op)) {
    if (typeof actual !== "number" || !Number.isFinite(actual)) return "miss";
    if (typeof expected !== "number" || !Number.isFinite(expected)) return "miss";
    if (op === "gt") return actual > expected ? "fire" : "miss";
    if (op === "gte") return actual >= expected ? "fire" : "miss";
    if (op === "lt") return actual < expected ? "fire" : "miss";
    if (op === "lte") return actual <= expected ? "fire" : "miss";
  }
  if (op === "in") {
    if (!Array.isArray(expected)) return "miss";
    return expected.includes(actual) ? "fire" : "miss";
  }
  if (op === "not_in") {
    if (!Array.isArray(expected)) return "miss";
    return expected.includes(actual) ? "miss" : "fire";
  }
  return "miss";
}

export function evaluateRouteIf(
  predicate: RouteIfPredicate,
  payload: Record<string, unknown> | undefined,
): RouteIfEval {
  if ("all" in predicate && predicate.all !== undefined) {
    let anyMiss = false;
    for (const child of predicate.all) {
      const result = evaluateRouteIf(child, payload);
      if (result === "missing_field") return "missing_field";
      if (result === "miss") anyMiss = true;
    }
    return anyMiss ? "miss" : "fire";
  }
  if ("any" in predicate && predicate.any !== undefined) {
    let anyFire = false;
    for (const child of predicate.any) {
      const result = evaluateRouteIf(child, payload);
      if (result === "missing_field") return "missing_field";
      if (result === "fire") anyFire = true;
    }
    return anyFire ? "fire" : "miss";
  }
  if ("not" in predicate && predicate.not !== undefined) {
    const result = evaluateRouteIf(predicate.not, payload);
    if (result === "missing_field") return "missing_field";
    return result === "fire" ? "miss" : "fire";
  }

  if (!isRouteIfLeaf(predicate)) return "missing_field";
  const read = readPayloadPath(payload, predicate.field);
  if (!read.ok) return "missing_field";
  return compareLeaf(predicate.op, read.value, predicate.value);
}
