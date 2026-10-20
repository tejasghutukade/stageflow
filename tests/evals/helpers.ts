import type { GradeRecord, ResultRecord, ResultStatus } from "../../src/evals/statsTypes.js";

export function mkResults(
  caseId: string,
  passes: boolean[],
  extra: Partial<ResultRecord> = {},
): ResultRecord[] {
  return passes.map((p, i) => ({
    caseId,
    repeatIndex: i,
    status: "completed" as ResultStatus,
    latencyMs: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    score: p ? 1 : 0,
    passed: p ? 1 : 0,
    ...extra,
  }));
}

export function mkGrade(
  caseId: string,
  repeatIndex: number,
  graderId: string,
  passed: boolean,
  extra: Partial<GradeRecord> = {},
): GradeRecord {
  return {
    caseId,
    repeatIndex,
    graderId,
    graderType: "schema",
    status: "graded",
    passed: passed ? 1 : 0,
    score: passed ? 1 : 0,
    rawValue: passed ? 1 : 0,
    judgeCostUsd: null,
    judgeTokensIn: null,
    judgeTokensOut: null,
    ...extra,
  };
}
