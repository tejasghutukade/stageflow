import { payloadInstanceMismatch } from "../../envelope/payloadSchema.js";
import type { ResolvedGrader } from "../types.js";
import { notApplicable } from "./notApplicable.js";
import { isConversation, truncate } from "./subject.js";
import type { GradeData, GraderContext, Subject } from "./types.js";

export function gradeSchema(
  grader: Extract<ResolvedGrader, { type: "schema" }>,
  subject: Subject,
  _testCase: unknown,
  context: GraderContext,
): GradeData {
  if (isConversation(subject)) return notApplicable(grader, "conversation");
  const base = { graderId: grader.id, graderType: "schema" } as const;
  const fail = (reason: string): GradeData => ({
    ...base,
    status: "graded",
    passed: false,
    score: 0,
    rawValue: 0,
    reason: truncate(reason, 500),
  });
  if (subject.status !== "success") {
    return fail(`envelope status is ${subject.status}, expected success`);
  }
  let mismatch: string | undefined;
  try {
    mismatch = payloadInstanceMismatch(subject.payload ?? {}, context.outputSchema);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (mismatch !== undefined) return fail(mismatch);
  return { ...base, status: "graded", passed: true, score: 1, rawValue: 1 };
}
