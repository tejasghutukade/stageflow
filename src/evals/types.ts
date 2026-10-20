export type FieldOp =
  | "exists"
  | "not_empty"
  | "equals"
  | "not_equals"
  | "contains"
  | "matches"
  | "gte"
  | "lte"
  | "between"
  | "in"
  | "length_gte"
  | "length_lte";

export type FieldCheck = { path: string; op: FieldOp; value?: unknown };

export type RubricExample =
  | { verdict: "pass" | "fail"; output: string; reason?: string }
  | { score: number; output: string; reason?: string };

export type EvalType = "capability" | "regression";

export type EvalTarget = {
  kind: "stage";
  pipeline?: string;
  stage?: string;
  file?: string;
};

export type EvalTask = { goal?: string; context?: string; constraints?: string };

export type EvalDefaults = {
  repeats?: number;
  judge?: string;
  pass_threshold?: number;
  max_cost_usd?: number;
  concurrency?: number;
  model?: string;
};

export type EvalBudget = { latency_ms?: number; cost_usd?: number };

type GraderCommon = {
  id: string;
  description?: string;
  weight?: number;
  must_pass?: boolean;
};

export type GraderConfig =
  | (GraderCommon & { type: "schema" })
  | (GraderCommon & { type: "field"; checks: FieldCheck[] })
  | (GraderCommon & {
      type: "reference";
      mode: "each_mentioned" | "equals";
      path?: string;
      expected: string;
      pass_at?: number;
    })
  | (GraderCommon & {
      type: "rubric";
      rubric: string;
      scale?: "pass_fail" | "1_to_5";
      pass_at?: number;
      judge?: string;
      examples?: RubricExample[];
    })
  | (GraderCommon & { type: "code"; code: string });

export type EvalFile = {
  version: 1;
  id: string;
  name?: string;
  description?: string;
  type?: EvalType;
  target: EvalTarget;
  dataset: string;
  task?: EvalTask;
  defaults?: EvalDefaults;
  graders: GraderConfig[];
  budget?: EvalBudget;
};

export type TargetRef = {
  kind: "stage";
  pipelinePath?: string;
  stageId?: string;
  file?: string;
};

type ResolvedGraderCommon = {
  id: string;
  weight: number;
  mustPass: boolean;
  hash: string;
  description?: string;
};

export type ResolvedGrader =
  | (ResolvedGraderCommon & { type: "schema" })
  | (ResolvedGraderCommon & { type: "field"; checks: FieldCheck[] })
  | (ResolvedGraderCommon & {
      type: "reference";
      mode: "each_mentioned" | "equals";
      path: string;
      expected: string;
      passAt: number;
    })
  | (ResolvedGraderCommon & {
      type: "rubric";
      rubric: string;
      scale: "pass_fail" | "1_to_5";
      passAt: number;
      judge: string;
      examples: RubricExample[];
    })
  | (ResolvedGraderCommon & { type: "code"; code: string });

export type PlanCase = {
  id: string;
  position: number;
  title?: string;
  goal?: string;
  input: Record<string, unknown>;
  expected?: unknown;
  tags: string[];
  metadata?: unknown;
};

export type EvalPlan = {
  evalRunId: string;
  projectRoot: string;
  evalId: string;
  target: TargetRef;
  targetVersionHash: string;
  outputSchema?: unknown;
  stageModel: string;
  task: { goal?: string; context?: string; constraints?: string };
  cases: PlanCase[];
  graders: ResolvedGrader[];
  repeats: number;
  passThreshold: number;
  concurrency: number;
  maxCostUsd: number;
  modelOverride?: string;
  budget?: { latencyMs?: number; costUsd?: number };
};

export type CaseOutput = {
  kind: "envelope";
  status: "success" | "failure";
  summary: string;
  payload?: Record<string, unknown>;
  artifacts: string[];
};

export type RunCaseRequest = { evalRunId: string; caseId: string; repeatIndex: number };

export type RunCaseFailureCode =
  | "EVAL_STAGE_FAILED"
  | "EVAL_STAGE_NEEDS_INPUT"
  | "EVAL_STAGE_TIMEOUT"
  | "EVAL_BUDGET_EXCEEDED"
  | "EVAL_CANCELLED"
  | "EVAL_ENGINE_ERROR";

export type RunCaseResult =
  | {
      ok: true;
      stageRunId: string;
      output: CaseOutput;
      latencyMs: number;
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
    }
  | {
      ok: false;
      code: RunCaseFailureCode;
      message: string;
      stageRunId?: string;
      latencyMs?: number;
      costUsd?: number;
    };

export type NormalizedGrade = {
  graderId: string;
  graderType: string;
  status: "graded" | "error";
  passed?: boolean;
  score?: number;
  rawValue?: number;
  reason?: string;
  errorCode?: string;
  details?: unknown;
  judgeModel?: string;
  judgeCostUsd?: number;
  judgeTokensIn?: number;
  judgeTokensOut?: number;
};

export type NormalizedResult = {
  caseId: string;
  repeatIndex: number;
  run: RunCaseResult;
  grades: NormalizedGrade[];
};

export interface EngineIo {
  runCase(req: RunCaseRequest): Promise<RunCaseResult>;
  onResult(result: NormalizedResult): void;
  reportJudgeCost(usd: number): void;
  onPhase(caseId: string, repeatIndex: number, phase: "stage_running" | "grading" | "done"): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface EvalEngine {
  readonly name: string;
  version(): Promise<string>;
  run(plan: EvalPlan, io: EngineIo, signal: AbortSignal): Promise<void>;
}
