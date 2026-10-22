import { isDeepStrictEqual } from "node:util";
import type { ResolvedGrader } from "../types.js";
import { resolveValue } from "./path.js";
import { show, subjectRoot, truncate } from "./subject.js";
import type { GradeCase, GradeData, GraderContext, Subject } from "./types.js";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

export function gradeReference(
  grader: Extract<ResolvedGrader, { type: "reference" }>,
  subject: Subject,
  testCase: GradeCase,
  _context?: GraderContext,
): GradeData {
  const base = { graderId: grader.id, graderType: "reference" } as const;
  const missing = (reason: string): GradeData => ({
    ...base,
    status: "error",
    errorCode: "EVAL_CASE_MISSING_EXPECTED",
    reason,
  });
  const expectedRef = resolveValue(testCase, grader.expected);
  if (!expectedRef.found || expectedRef.value === undefined || expectedRef.value === null) {
    return missing(`case has no value at ${grader.expected}`);
  }
  const actual = resolveValue(subjectRoot(subject), grader.path);

  if (grader.mode === "equals") {
    const passed = actual.found && isDeepStrictEqual(actual.value, expectedRef.value);
    return {
      ...base,
      status: "graded",
      passed,
      score: passed ? 1 : 0,
      rawValue: passed ? 1 : 0,
      ...(passed
        ? {}
        : {
            reason: truncate(
              `${grader.path} is ${actual.found ? show(actual.value) : "missing"}, expected ${show(expectedRef.value)}`,
            ),
          }),
    };
  }

  const expected = expectedRef.value;
  if (!Array.isArray(expected) || !expected.every((e) => typeof e === "string")) {
    return missing(`${grader.expected} must be an array of strings`);
  }
  const text = actual.found ? norm(toText(actual.value)) : "";
  const items = (expected as string[]).map((t) => ({ text: t, found: text.includes(norm(t)) }));
  const foundCount = items.filter((i) => i.found).length;
  const score = items.length === 0 ? 1 : foundCount / items.length;
  const passed = score + 1e-9 >= grader.passAt;
  const firstMissing = items.find((i) => !i.found);
  return {
    ...base,
    status: "graded",
    passed,
    score,
    rawValue: score,
    ...(firstMissing
      ? { reason: truncate(`found ${foundCount} of ${items.length}; missing ${show(firstMissing.text)}`) }
      : {}),
    details: { items },
  };
}
