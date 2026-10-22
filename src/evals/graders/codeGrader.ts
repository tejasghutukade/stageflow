import vm from "node:vm";
import type { ResolvedGrader } from "../types.js";
import { subjectRoot, truncate } from "./subject.js";
import type { GradeCase, GradeData, GraderContext, Subject } from "./types.js";

export const CODE_GRADER_TIMEOUT_MS = 5_000;

const RUNNER = `(function () {
  function freeze(o) {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) freeze(o[k]);
    }
    return o;
  }
  const args = JSON.parse(__args).map(freeze);
  const fn = new Function("output", "testCase", "context", __body);
  const out = JSON.stringify(fn(args[0], args[1], args[2]));
  return out === undefined ? "undefined" : out;
})()`;

export function gradeCode(
  grader: Extract<ResolvedGrader, { type: "code" }>,
  subject: Subject,
  testCase: GradeCase,
  context: GraderContext,
): GradeData {
  const base = { graderId: grader.id, graderType: "code" } as const;
  const error = (reason: string): GradeData => ({
    ...base,
    status: "error",
    errorCode: "EVAL_GRADER_CODE_ERROR",
    reason: truncate(reason),
  });
  const timeout = context.codeTimeoutMs ?? CODE_GRADER_TIMEOUT_MS;
  let raw: unknown;
  try {
    const sandbox = vm.createContext({
      __args: JSON.stringify([
        subjectRoot(subject),
        testCase,
        { evalId: context.evalId, runId: context.runId, repeat: context.repeat },
      ]),
      __body: grader.code,
    });
    raw = new vm.Script(RUNNER).runInContext(sandbox, { timeout });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(/timed out/i.test(message) ? `code grader timed out after ${timeout} ms` : message);
  }
  let value: unknown;
  try {
    value = raw === "undefined" ? undefined : JSON.parse(String(raw));
  } catch {
    return error("code grader returned a value that is not JSON-serializable");
  }
  if (typeof value === "boolean") {
    return { ...base, status: "graded", passed: value, score: value ? 1 : 0, rawValue: value ? 1 : 0 };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return error(`code grader returned a number outside 0-1: ${value}`);
    }
    return {
      ...base,
      status: "graded",
      passed: value + 1e-9 >= context.passThreshold,
      score: value,
      rawValue: value,
    };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const r = value as { pass?: unknown; score?: unknown; reason?: unknown };
    if (typeof r.pass !== "boolean") return error("code grader result needs a boolean pass");
    if (r.score !== undefined && (typeof r.score !== "number" || !(r.score >= 0 && r.score <= 1))) {
      return error("code grader score must be a number from 0 to 1");
    }
    if (r.reason !== undefined && typeof r.reason !== "string") {
      return error("code grader reason must be a string");
    }
    const score = r.score ?? (r.pass ? 1 : 0);
    return {
      ...base,
      status: "graded",
      passed: r.pass,
      score,
      rawValue: score,
      ...(r.reason !== undefined ? { reason: truncate(r.reason) } : {}),
    };
  }
  return error("code grader must return a boolean, a number 0-1, or { pass, score?, reason? }");
}
