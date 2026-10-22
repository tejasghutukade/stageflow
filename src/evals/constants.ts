export const EVAL_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "budget_stopped",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export const EVAL_RESULT_STATUSES = [
  "completed",
  "stage_failed",
  "needs_input",
  "error",
  "skipped_budget",
  "cancelled",
] as const;
export type EvalResultStatus = (typeof EVAL_RESULT_STATUSES)[number];

export const EVAL_EXECUTED_RESULT_STATUSES = [
  "completed",
  "stage_failed",
  "needs_input",
  "error",
] as const satisfies readonly EvalResultStatus[];

export const EVAL_GRADE_STATUSES = ["graded", "error"] as const;
export type EvalGradeStatus = (typeof EVAL_GRADE_STATUSES)[number];

export const EVAL_TARGET_KINDS = ["stage", "agent"] as const;
export type EvalTargetKind = (typeof EVAL_TARGET_KINDS)[number];

export const EVAL_STARTED_VIA = ["console", "cli", "mcp"] as const;
export type EvalStartedVia = (typeof EVAL_STARTED_VIA)[number];

export const EVAL_REVIEW_LABELS = ["pass", "fail"] as const;
export type EvalReviewLabel = (typeof EVAL_REVIEW_LABELS)[number];

export const EVAL_BUDGET_WARNINGS = ["latency", "cost"] as const;
export type EvalBudgetWarning = (typeof EVAL_BUDGET_WARNINGS)[number];

export const EVAL_RESULT_ERROR_CODES = [
  "EVAL_STAGE_FAILED",
  "EVAL_STAGE_NEEDS_INPUT",
  "EVAL_STAGE_TIMEOUT",
  "EVAL_ENGINE_ERROR",
  "EVAL_BUDGET_EXCEEDED",
  "EVAL_CANCELLED",
  "EVAL_JUDGE_ERROR",
  "EVAL_GRADER_CODE_ERROR",
  "EVAL_CASE_MISSING_EXPECTED",
] as const;

export const EVAL_REQUEST_ERROR_CODES = [
  "EVAL_INVALID",
  "EVAL_RUN_ACTIVE",
  "EVAL_ENGINE_UNAVAILABLE",
  "EVAL_NODE_TOO_OLD",
  "FILE_CHANGED",
  "EVAL_NOT_FOUND",
  "DATASET_NOT_FOUND",
  "EVAL_RUN_NOT_FOUND",
  "EVAL_TAGS_ON_PASSED_RESULT",
] as const;

export const EVAL_ERROR_CODES = [
  ...EVAL_RESULT_ERROR_CODES,
  ...EVAL_REQUEST_ERROR_CODES,
] as const;
export type EvalErrorCode = (typeof EVAL_ERROR_CODES)[number];

export const EVAL_LIMITS = {
  maxCasesPerDataset: 5_000,
  maxCaseBytes: 1_000_000,
  maxUploadBytes: 50_000_000,
  maxResultsPerRun: 5_000,
  repeats: { min: 1, max: 10 },
  concurrency: { min: 1, max: 8 },
  labelMaxChars: 80,
  failureTypeNameMaxChars: 60,
  reviewNoteMaxChars: 500,
} as const;

export const EVAL_RUN_ID_PREFIX = "er_";

export const RUBRIC_PROMPT_VERSION = 1;
export const CONFIG_SNAPSHOT_VERSION = 1;
export const SIMULATOR_PROMPT_VERSION = 1;
