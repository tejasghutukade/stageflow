import type {
  EvalBudgetWarning,
  EvalGradeStatus,
  EvalResultStatus,
  EvalReviewLabel,
  EvalRunStatus,
  EvalStartedVia,
  EvalTargetKind,
} from "./constants.js";

export type EvalTargetRef = {
  pipeline_path?: string;
  stage_id?: string;
  file?: string;
  agent_id?: string;
  revision?: number | string;
};

export type EvalJson = Record<string, unknown>;

export type EvalRunRow = {
  evalRunId: string;
  projectRoot: string;
  evalId: string;
  runNumber: number;
  evalPath: string;
  evalHash: string;
  targetKind: EvalTargetKind;
  targetRef: EvalTargetRef;
  targetVersionHash: string;
  datasetPath: string;
  datasetHash: string;
  config: EvalJson;
  configFingerprint: string;
  configComponents: EvalJson;
  status: EvalRunStatus;
  statusReason: string | null;
  passed: boolean | null;
  repeats: number;
  passThreshold: number;
  maxCostUsd: number;
  casesTotal: number;
  resultsTotal: number;
  resultsDone: number;
  costUsd: number;
  engineName: string;
  engineVersion: string;
  stageflowVersion: string;
  label: string | null;
  startedVia: EvalStartedVia;
  callerId: string | null;
  summary: EvalJson | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CreateEvalRunInput = {
  projectRoot: string;
  evalId: string;
  evalPath: string;
  evalHash: string;
  targetKind: EvalTargetKind;
  targetRef: EvalTargetRef;
  targetVersionHash: string;
  datasetPath: string;
  datasetHash: string;
  config: EvalJson;
  configFingerprint: string;
  configComponents: EvalJson;
  status?: EvalRunStatus;
  repeats: number;
  passThreshold: number;
  maxCostUsd: number;
  casesTotal: number;
  resultsTotal: number;
  engineName: string;
  engineVersion: string;
  stageflowVersion: string;
  label?: string;
  startedVia: EvalStartedVia;
  callerId?: string;
};

export type EvalRunProgress = {
  resultsDone?: number;
  costUsd?: number;
  status?: EvalRunStatus;
  statusReason?: string | null;
  startedAt?: string;
};

export type FinishEvalRunInput = {
  status: Extract<EvalRunStatus, "completed" | "failed" | "cancelled" | "budget_stopped">;
  statusReason?: string | null;
  passed: boolean;
  summary: EvalJson;
  finishedAt: string;
};

export type ListEvalRunsQuery = {
  projectRoot?: string;
  evalId?: string;
  status?: EvalRunStatus;
  limit: number;
  cursor?: string;
};

export type EvalRunPage = { items: EvalRunRow[]; nextCursor: string | null };

export type EvalCaseRow = {
  evalRunId: string;
  caseId: string;
  position: number;
  case: EvalJson;
};

export type EvalCaseInput = Omit<EvalCaseRow, "evalRunId">;

export type EvalGradeRow = {
  evalRunId: string;
  caseId: string;
  repeatIndex: number;
  graderId: string;
  graderType: string;
  status: EvalGradeStatus;
  passed: boolean | null;
  score: number | null;
  rawValue: number | null;
  reason: string | null;
  details: EvalJson | null;
  errorCode: string | null;
  judgeModel: string | null;
  judgeCostUsd: number | null;
  judgeTokensIn: number | null;
  judgeTokensOut: number | null;
};

export type EvalGradeInput = {
  graderId: string;
  graderType: string;
  status: EvalGradeStatus;
  passed?: boolean | null;
  score?: number | null;
  rawValue?: number | null;
  reason?: string | null;
  details?: EvalJson | null;
  errorCode?: string | null;
  judgeModel?: string | null;
  judgeCostUsd?: number | null;
  judgeTokensIn?: number | null;
  judgeTokensOut?: number | null;
};

export type EvalResultRow = {
  evalRunId: string;
  caseId: string;
  repeatIndex: number;
  status: EvalResultStatus;
  errorCode: string | null;
  errorMessage: string | null;
  stageRunId: string | null;
  output: EvalJson | null;
  latencyMs: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  score: number | null;
  passed: boolean;
  hasGraderErrors: boolean;
  budgetWarnings: EvalBudgetWarning[] | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type EvalResultWithGrades = EvalResultRow & { grades: EvalGradeRow[] };

export type EvalResultInput = {
  evalRunId: string;
  caseId: string;
  repeatIndex: number;
  status: EvalResultStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  stageRunId?: string | null;
  output?: EvalJson | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  score?: number | null;
  passed?: boolean;
  hasGraderErrors?: boolean;
  budgetWarnings?: EvalBudgetWarning[] | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  grades?: EvalGradeInput[];
};

export type EvalReviewPatch = {
  label?: EvalReviewLabel;
  note?: string | null;
  tags?: string[];
};

export type EvalReviewRow = {
  evalRunId: string;
  caseId: string;
  repeatIndex: number;
  label: EvalReviewLabel | null;
  note: string | null;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type EvalGraderVersionInput = { graderId: string; graderHash: string };
