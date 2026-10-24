import type { GradeData } from "./types.js";

export function notApplicable(grader: { id: string; type: string }, subjectKind: string): GradeData {
  return {
    graderId: grader.id,
    graderType: grader.type,
    status: "error",
    errorCode: "EVAL_GRADER_NOT_APPLICABLE",
    reason: `${grader.type} grader does not apply to a ${subjectKind} subject`,
  };
}
