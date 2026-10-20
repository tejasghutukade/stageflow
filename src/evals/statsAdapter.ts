import type { EvalResultRow, EvalResultWithGrades } from "./storeTypes.js";
import type { GradeRecord, ResultRecord } from "./statsTypes.js";

export function toResultRecord(row: EvalResultRow): ResultRecord {
  return {
    caseId: row.caseId,
    repeatIndex: row.repeatIndex,
    status: row.status,
    latencyMs: row.latencyMs,
    costUsd: row.costUsd,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    score: row.score,
    passed: row.passed ? 1 : 0,
  };
}

export function toGradeRecords(row: EvalResultWithGrades): GradeRecord[] {
  return row.grades.map((g) => ({
    caseId: g.caseId,
    repeatIndex: g.repeatIndex,
    graderId: g.graderId,
    graderType: g.graderType,
    status: g.status,
    passed: g.passed === null ? null : g.passed ? 1 : 0,
    score: g.score,
    rawValue: g.rawValue,
    judgeCostUsd: g.judgeCostUsd,
    judgeTokensIn: g.judgeTokensIn,
    judgeTokensOut: g.judgeTokensOut,
  }));
}
