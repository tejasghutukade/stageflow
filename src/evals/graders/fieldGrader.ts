import { isDeepStrictEqual } from "node:util";
import type { FieldCheck, ResolvedGrader } from "../types.js";
import { evaluatePath } from "./path.js";
import { show, subjectEnvelope, truncate } from "./subject.js";
import type { GradeData, GraderContext, Subject } from "./types.js";

function isEmptyValue(v: unknown): boolean {
  if (v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && v !== null && Object.keys(v).length === 0;
}

function lengthOf(v: unknown): number | undefined {
  return typeof v === "string" || Array.isArray(v) ? v.length : undefined;
}

function opHolds(check: FieldCheck, v: unknown): boolean {
  const arg = check.value;
  switch (check.op) {
    case "exists":
      return v !== null && v !== undefined;
    case "not_empty":
      return v !== null && v !== undefined && !isEmptyValue(v);
    case "equals":
      return isDeepStrictEqual(v, arg);
    case "not_equals":
      return !isDeepStrictEqual(v, arg);
    case "contains":
      if (typeof v === "string") return typeof arg === "string" && v.includes(arg);
      if (Array.isArray(v)) return v.some((el) => isDeepStrictEqual(el, arg));
      return false;
    case "matches": {
      if (typeof v !== "string" || typeof arg !== "string") return false;
      try {
        return new RegExp(arg).test(v);
      } catch {
        return false;
      }
    }
    case "gte":
      return typeof v === "number" && typeof arg === "number" && v >= arg;
    case "lte":
      return typeof v === "number" && typeof arg === "number" && v <= arg;
    case "between":
      return (
        typeof v === "number" &&
        Array.isArray(arg) &&
        typeof arg[0] === "number" &&
        typeof arg[1] === "number" &&
        v >= arg[0] &&
        v <= arg[1]
      );
    case "in":
      return Array.isArray(arg) && arg.some((el) => isDeepStrictEqual(el, v));
    case "length_gte": {
      const n = lengthOf(v);
      return n !== undefined && typeof arg === "number" && n >= arg;
    }
    case "length_lte": {
      const n = lengthOf(v);
      return n !== undefined && typeof arg === "number" && n <= arg;
    }
  }
}

type CheckOutcome = { passed: boolean; found: string };

function runCheck(check: FieldCheck, envelope: Record<string, unknown>): CheckOutcome {
  const r = evaluatePath(envelope, check.path);
  const isLength = check.op === "length_gte" || check.op === "length_lte";
  if (r.emptyWildcard) {
    if (isLength) return { passed: opHolds(check, []), found: "[]" };
    return { passed: false, found: "no match" };
  }
  for (const node of r.nodes) {
    if (!node.found) return { passed: false, found: "missing" };
  }
  for (const node of r.nodes) {
    if (!opHolds(check, node.value)) return { passed: false, found: show(node.value) };
  }
  return {
    passed: true,
    found: r.nodes.length === 1 ? show(r.nodes[0].value) : `${r.nodes.length} nodes`,
  };
}

function describe(check: FieldCheck): string {
  return check.value === undefined
    ? `${check.path} ${check.op}`
    : `${check.path} ${check.op} ${show(check.value)}`;
}

export function gradeField(
  grader: Extract<ResolvedGrader, { type: "field" }>,
  subject: Subject,
  _testCase: unknown,
  _context?: GraderContext,
): GradeData {
  const envelope = subjectEnvelope(subject);
  const checks = grader.checks.map((check) => {
    const outcome = runCheck(check, envelope);
    return {
      path: check.path,
      op: check.op,
      passed: outcome.passed,
      found: truncate(outcome.found),
    };
  });
  const firstFail = checks.findIndex((c) => !c.passed);
  const passed = firstFail === -1;
  return {
    graderId: grader.id,
    graderType: "field",
    status: "graded",
    passed,
    score: passed ? 1 : 0,
    rawValue: passed ? 1 : 0,
    ...(passed
      ? {}
      : {
          reason: truncate(`${describe(grader.checks[firstFail])}: found ${checks[firstFail].found}`),
        }),
    details: { checks },
  };
}
