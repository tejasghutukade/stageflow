import type { ResolvedGrader } from "../types.js";
import { gradeCode } from "./codeGrader.js";
import { gradeConversationCheck } from "./conversationCheckGrader.js";
import { gradeField } from "./fieldGrader.js";
import { gradeReference } from "./referenceGrader.js";
import { gradeSchema } from "./schemaGrader.js";
import { gradeToolCalls } from "./toolCallsGrader.js";
import type { GradeCase, GradeData, GraderContext, Subject } from "./types.js";

export type DeterministicGrader = Extract<
  ResolvedGrader,
  { type: "schema" | "field" | "reference" | "code" | "tool_calls" | "conversation_check" }
>;

export function isDeterministicGrader(grader: ResolvedGrader): grader is DeterministicGrader {
  return (
    grader.type === "schema" ||
    grader.type === "field" ||
    grader.type === "reference" ||
    grader.type === "code" ||
    grader.type === "tool_calls" ||
    grader.type === "conversation_check"
  );
}

export function gradeDeterministic(
  grader: DeterministicGrader,
  subject: Subject,
  testCase: GradeCase,
  context: GraderContext,
): GradeData {
  switch (grader.type) {
    case "schema":
      return gradeSchema(grader, subject, testCase, context);
    case "field":
      return gradeField(grader, subject, testCase, context);
    case "reference":
      return gradeReference(grader, subject, testCase, context);
    case "code":
      return gradeCode(grader, subject, testCase, context);
    case "tool_calls":
      return gradeToolCalls(grader, subject, testCase, context);
    case "conversation_check":
      return gradeConversationCheck(grader, subject, testCase, context);
  }
}

export { gradeCode, gradeConversationCheck, gradeField, gradeReference, gradeSchema, gradeToolCalls };
export { caseGoal, goalRubricText } from "./goal.js";
export { renderTranscript } from "./transcript.js";
export { evaluatePath, resolveValue } from "./path.js";
export type { GraderContext, Subject, GradeCase, GradeData } from "./types.js";
