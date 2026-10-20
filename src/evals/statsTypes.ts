export const RESULT_STATUSES = [
  "completed",
  "stage_failed",
  "needs_input",
  "error",
  "skipped_budget",
  "cancelled",
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const EXECUTED_RESULT_STATUSES: readonly ResultStatus[] = [
  "completed",
  "stage_failed",
  "needs_input",
  "error",
];

export type GradeStatus = "graded" | "error";

export type EvalType = "capability" | "regression";

export const EVAL_COMPARE_MISMATCH = "EVAL_COMPARE_MISMATCH";

export interface ResultRecord {
  caseId: string;
  repeatIndex: number;
  status: ResultStatus;
  latencyMs: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  score: number | null;
  passed: 0 | 1;
}

export interface GradeRecord {
  caseId: string;
  repeatIndex: number;
  graderId: string;
  graderType: string;
  status: GradeStatus;
  passed: 0 | 1 | null;
  score: number | null;
  rawValue: number | null;
  judgeCostUsd: number | null;
  judgeTokensIn: number | null;
  judgeTokensOut: number | null;
}

export interface GraderRef {
  id: string;
  type: string;
  hash: string;
}

export interface PreviousRunGraderStat {
  graderId: string;
  hash: string;
  passRate: number | null;
}

export interface PreviousRunLite {
  graders: PreviousRunGraderStat[];
}

export interface RunBudget {
  latencyMs?: number | null;
  costUsd?: number | null;
}

export type BudgetWarning = "latency" | "cost";

export function resultKey(caseId: string, repeatIndex: number): string {
  return `${caseId}:${repeatIndex}`;
}
