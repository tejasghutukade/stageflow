import type {
  PipelineRouteEntry,
  PipelineRouteForwardEntry,
  RouteIfLeafPredicate,
  RouteIfOp,
  RouteIfPredicate,
} from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import type { LoadIssue } from "./loadOutcome.js";

const ALLOWED_LEAF_KEYS = new Set(["field", "op", "value"]);
const ALLOWED_ALL_KEYS = new Set(["all"]);
const ALLOWED_ANY_KEYS = new Set(["any"]);
const ALLOWED_NOT_KEYS = new Set(["not"]);
const ROUTE_IF_OPS = new Set<RouteIfOp>([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
]);
const EQ_NE_TYPES = new Set(["string", "number", "integer", "boolean"]);
const NUMERIC_TYPES = new Set(["number", "integer"]);
const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);
const MEMBERSHIP_OPS = new Set(["in", "not_in"]);
const INDEX_SEGMENT = /^\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRouteIfOp(value: unknown): value is RouteIfOp {
  return typeof value === "string" && ROUTE_IF_OPS.has(value as RouteIfOp);
}

export type ParseRouteIfResult =
  | { ok: true; value: RouteIfPredicate }
  | { ok: false; message: string; code: "pipeline.route_if_invalid" };

function failParse(prefix: string, message: string): ParseRouteIfResult {
  return {
    ok: false,
    message: `${prefix}${message}`,
    code: "pipeline.route_if_invalid",
  };
}

function unknownKeyIssue(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): ParseRouteIfResult | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return failParse(prefix, `: unknown key "${key}"`);
    }
  }
  return undefined;
}

function parseRouteIfLeaf(
  raw: Record<string, unknown>,
  prefix: string,
): ParseRouteIfResult {
  const extra = unknownKeyIssue(raw, ALLOWED_LEAF_KEYS, prefix);
  if (extra) return extra;

  if (typeof raw.field !== "string" || !raw.field) {
    return failParse(prefix, ": field must be a non-empty string");
  }

  if (!isRouteIfOp(raw.op)) {
    return failParse(prefix, `: unknown op "${String(raw.op)}"`);
  }

  if (!hasOwn(raw, "value")) {
    return failParse(prefix, ": value is required");
  }

  if (MEMBERSHIP_OPS.has(raw.op)) {
    if (!Array.isArray(raw.value) || raw.value.length === 0) {
      return failParse(prefix, `: ${raw.op} value must be a non-empty list`);
    }
  }

  return {
    ok: true,
    value: {
      field: raw.field,
      op: raw.op,
      value: raw.value,
    },
  };
}

function parseRouteIfNode(raw: unknown, prefix: string): ParseRouteIfResult {
  if (!isPlainObject(raw)) {
    return failParse(prefix, " must be a predicate object");
  }

  const hasAll = hasOwn(raw, "all");
  const hasAny = hasOwn(raw, "any");
  const hasNot = hasOwn(raw, "not");
  const hasField = hasOwn(raw, "field");
  const hasOp = hasOwn(raw, "op");
  const hasValue = hasOwn(raw, "value");
  const compositionCount = Number(hasAll) + Number(hasAny) + Number(hasNot);
  const hasLeafKeys = hasField || hasOp || hasValue;

  if (compositionCount > 1 || (compositionCount === 1 && hasLeafKeys)) {
    return failParse(
      prefix,
      " must be exactly one of { field, op, value }, { all }, { any }, or { not }",
    );
  }

  if (hasAll) {
    const extra = unknownKeyIssue(raw, ALLOWED_ALL_KEYS, prefix);
    if (extra) return extra;
    return parseRouteIfList(raw.all, prefix, "all");
  }
  if (hasAny) {
    const extra = unknownKeyIssue(raw, ALLOWED_ANY_KEYS, prefix);
    if (extra) return extra;
    return parseRouteIfList(raw.any, prefix, "any");
  }
  if (hasNot) {
    const extra = unknownKeyIssue(raw, ALLOWED_NOT_KEYS, prefix);
    if (extra) return extra;
    if (!isPlainObject(raw.not)) {
      return failParse(prefix, ": not must be a predicate object");
    }
    const inner = parseRouteIfNode(raw.not, prefix);
    if (!inner.ok) return inner;
    return { ok: true, value: { not: inner.value } };
  }

  return parseRouteIfLeaf(raw, prefix);
}

function parseRouteIfList(
  raw: unknown,
  prefix: string,
  kind: "all" | "any",
): ParseRouteIfResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return failParse(prefix, `: ${kind} must be a non-empty list`);
  }
  const children: RouteIfPredicate[] = [];
  for (const item of raw) {
    const parsed = parseRouteIfNode(item, prefix);
    if (!parsed.ok) return parsed;
    children.push(parsed.value);
  }
  return { ok: true, value: kind === "all" ? { all: children } : { any: children } };
}

export function parseRouteIf(
  raw: unknown,
  stageId: string,
  targetId: string,
): ParseRouteIfResult {
  return parseRouteIfNode(raw, `stage "${stageId}": route "${targetId}" if`);
}

type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  $ref?: unknown;
};

function asSchemaObject(schema: unknown): JsonSchemaObject | undefined {
  if (!isPlainObject(schema)) return undefined;
  return schema as JsonSchemaObject;
}

function schemaTypeName(schema: JsonSchemaObject | undefined): string | undefined {
  return typeof schema?.type === "string" ? schema.type : undefined;
}

function valueMatchesScalarType(value: unknown, typeName: string): boolean {
  if (typeName === "string") return typeof value === "string";
  if (typeName === "boolean") return typeof value === "boolean";
  if (typeName === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeName === "integer") return typeof value === "number" && Number.isInteger(value);
  return false;
}

function isRouteIfLeaf(predicate: RouteIfPredicate): predicate is RouteIfLeafPredicate {
  return "op" in predicate && predicate.op !== undefined && typeof predicate.field === "string";
}

function routeIfLeafSchemaIssue(
  predicate: RouteIfLeafPredicate,
  payloadSchema: unknown,
  prefix: string,
): string | undefined {
  const segments = predicate.field.split(".");
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    return `${prefix}: field "${predicate.field}" is not a property of io.output.schema`;
  }
  if (segments.some((segment) => INDEX_SEGMENT.test(segment))) {
    return `${prefix}: field "${predicate.field}" array index paths are not allowed`;
  }

  let current: unknown = payloadSchema;
  for (const segment of segments) {
    const schema = asSchemaObject(current);
    if (schema?.$ref !== undefined && schema.properties === undefined) {
      return `${prefix}: field "${predicate.field}" is not a property of io.output.schema`;
    }
    const typeName = schemaTypeName(schema);
    if (typeName === "array" || (schema !== undefined && hasOwn(schema, "items") && typeName !== "object")) {
      return `${prefix}: field "${predicate.field}" array index paths are not allowed`;
    }
    const properties =
      schema && isPlainObject(schema.properties) ? schema.properties : undefined;
    if (!properties || !hasOwn(properties, segment)) {
      return `${prefix}: field "${predicate.field}" is not a property of io.output.schema`;
    }
    const required = Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    if (!required.includes(segment)) {
      return `${prefix}: field "${predicate.field}" must be required on io.output.schema`;
    }
    current = properties[segment];
  }

  const leaf = asSchemaObject(current);
  const fieldType = schemaTypeName(leaf);
  if (fieldType === undefined) {
    return `${prefix}: field "${predicate.field}" is not a property of io.output.schema`;
  }
  if (NUMERIC_OPS.has(predicate.op)) {
    if (!NUMERIC_TYPES.has(fieldType)) {
      return `${prefix}: op ${predicate.op} is only valid for number or integer fields`;
    }
    return undefined;
  }
  if (!EQ_NE_TYPES.has(fieldType)) {
    return `${prefix}: op ${predicate.op} is only valid for string, number, integer, or boolean fields`;
  }
  if (MEMBERSHIP_OPS.has(predicate.op)) {
    if (!Array.isArray(predicate.value) || predicate.value.length === 0) {
      return `${prefix}: ${predicate.op} value must be a non-empty list`;
    }
    if (!predicate.value.every((item) => valueMatchesScalarType(item, fieldType))) {
      return `${prefix}: ${predicate.op} list items must be the same scalar type as field "${predicate.field}"`;
    }
  }
  return undefined;
}

function routeIfFieldSchemaIssue(
  predicate: RouteIfPredicate,
  payloadSchema: unknown,
  stageId: string,
  targetId: string,
  pipelineId: string,
): string | undefined {
  const prefix = `Pipeline ${pipelineId}: stage "${stageId}": route "${targetId}" if`;
  if ("all" in predicate && predicate.all !== undefined) {
    for (const child of predicate.all) {
      const issue = routeIfFieldSchemaIssue(child, payloadSchema, stageId, targetId, pipelineId);
      if (issue !== undefined) return issue;
    }
    return undefined;
  }
  if ("any" in predicate && predicate.any !== undefined) {
    for (const child of predicate.any) {
      const issue = routeIfFieldSchemaIssue(child, payloadSchema, stageId, targetId, pipelineId);
      if (issue !== undefined) return issue;
    }
    return undefined;
  }
  if ("not" in predicate && predicate.not !== undefined) {
    return routeIfFieldSchemaIssue(predicate.not, payloadSchema, stageId, targetId, pipelineId);
  }
  if (!isRouteIfLeaf(predicate)) return `${prefix}: invalid predicate`;
  return routeIfLeafSchemaIssue(predicate, payloadSchema, prefix);
}

function isForwardRouteEntry(
  entry: PipelineRouteEntry,
): entry is PipelineRouteForwardEntry {
  return !("type" in entry) || entry.type === undefined;
}

export function collectRouteIfIllegalCombos(
  refs: Array<{ id: string; route?: PipelineRouteEntry[]; clonable?: boolean }>,
  pipelineId: string,
): LoadIssue[] {
  const clonableIds = new Set(
    refs.filter((ref) => ref.clonable === true).map((ref) => ref.id),
  );
  const issues: LoadIssue[] = [];
  for (const ref of refs) {
    if (ref.route === undefined) continue;
    const forward = ref.route.filter(isForwardRouteEntry);
    const hasAnyIf = forward.some((entry) => entry.if !== undefined);
    if (!hasAnyIf) continue;
    for (const entry of forward) {
      if (!clonableIds.has(entry.to)) continue;
      issues.push({
        code: "pipeline.route_if_invalid",
        message: `Pipeline ${pipelineId}: stage "${ref.id}": route "${entry.to}" if cannot target a clonable stage`,
        category: "pipeline",
        pipelineId,
        stageId: ref.id,
      });
    }
  }
  return issues;
}

export function collectRouteIfSchemaIssues(
  stages: StageConfig[],
  refs: Array<{ id: string; route?: PipelineRouteEntry[] }>,
  pipelineId: string,
): LoadIssue[] {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const issues: LoadIssue[] = [];
  for (const ref of refs) {
    if (ref.route === undefined) continue;
    const source = stageById.get(ref.id);
    for (const entry of ref.route) {
      if (!("if" in entry) || entry.if === undefined) continue;
      const message = routeIfFieldSchemaIssue(
        entry.if,
        source?.payload_schema,
        ref.id,
        entry.to,
        pipelineId,
      );
      if (message === undefined) continue;
      issues.push({
        code: "pipeline.route_if_invalid",
        message,
        category: "pipeline",
        pipelineId,
        stageId: ref.id,
      });
    }
  }
  return issues;
}

export function collectRouteAllGatedWarnings(
  refs: Array<{ id: string; route?: PipelineRouteEntry[] }>,
  pipelineId: string,
): LoadIssue[] {
  const issues: LoadIssue[] = [];
  for (const ref of refs) {
    if (ref.route === undefined) continue;
    const forward = ref.route.filter(
      (entry): entry is PipelineRouteForwardEntry =>
        !("type" in entry) || entry.type === undefined,
    );
    if (forward.length === 0) continue;
    if (!forward.every((entry) => entry.if !== undefined)) continue;
    issues.push({
      code: "pipeline.route_all_gated",
      message: `Pipeline ${pipelineId}: stage "${ref.id}": every forward route entry has if`,
      category: "pipeline",
      pipelineId,
      stageId: ref.id,
    });
  }
  return issues;
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
