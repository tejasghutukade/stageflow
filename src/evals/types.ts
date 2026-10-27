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

export type StageEvalTarget = {
  kind: "stage";
  pipeline?: string;
  stage?: string;
  file?: string;
};

export type AgentEvalTarget = { kind: "agent"; agent: string };

export type InternalAgentEvalTarget = { kind: "internal_agent"; profile: string };

export type EvalTarget = StageEvalTarget | AgentEvalTarget | InternalAgentEvalTarget;

/** A conversation eval: a project agent or a built-in operator agent. */
export function isConversationTarget(kind: string): boolean {
  return kind === "agent" || kind === "internal_agent";
}

export type ConversationMode = "script" | "simulated";
export type ConversationTools = "real" | "read_only" | "mocked";
export type ConversationApprovals = "deny" | "auto_approve_read" | "record_only";

export type EvalConversation = {
  mode?: ConversationMode;
  max_turns?: number;
  turn_timeout_ms?: number;
  tools?: ConversationTools;
  approvals?: ConversationApprovals;
  read_only_tools?: string[];
  allow_real_tools?: boolean;
};

export type ResolvedConversation = {
  mode: ConversationMode;
  maxTurns: number;
  turnTimeoutMs: number;
  tools: ConversationTools;
  approvals: ConversationApprovals;
  readOnlyTools: string[];
  allowRealTools: boolean;
};

export type EvalTask = { goal?: string; context?: string; constraints?: string };

export type EvalDefaults = {
  repeats?: number;
  judge?: string;
  pass_threshold?: number;
  max_cost_usd?: number;
  concurrency?: number;
  model?: string;
  user_model?: string;
};

export type EvalBudget = { latency_ms?: number; cost_usd?: number };

type GraderCommon = {
  id: string;
  description?: string;
  weight?: number;
  must_pass?: boolean;
};

export type ToolArgCheck = { tool: string; path: string; op: FieldOp; value?: unknown };
export type FinalReplyCheck = { op: FieldOp; value?: unknown };

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
  | (GraderCommon & { type: "code"; code: string })
  | (GraderCommon & {
      type: "tool_calls";
      must_call?: string[];
      must_not_call?: string[];
      must_ask_first?: string[];
      max_calls?: number;
      args?: ToolArgCheck[];
    })
  | (GraderCommon & {
      type: "conversation_check";
      max_turns?: number;
      max_agent_questions_per_turn?: number;
      final_reply?: FinalReplyCheck[];
    })
  | (GraderCommon & { type: "goal_reached"; judge?: string; guidance?: string });

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
  conversation?: EvalConversation;
  graders: GraderConfig[];
  budget?: EvalBudget;
};

export type StageTargetRef = {
  kind: "stage";
  pipelinePath?: string;
  stageId?: string;
  file?: string;
};

export type AgentTargetRef = { kind: "agent"; agentId: string; revision?: number };

export type InternalAgentTargetRef = { kind: "internal_agent"; profileId: string };

export type TargetRef = StageTargetRef | AgentTargetRef | InternalAgentTargetRef;

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
  | (ResolvedGraderCommon & { type: "code"; code: string })
  | (ResolvedGraderCommon & {
      type: "tool_calls";
      mustCall?: string[];
      mustNotCall?: string[];
      mustAskFirst?: string[];
      maxCalls?: number;
      args: ToolArgCheck[];
    })
  | (ResolvedGraderCommon & {
      type: "conversation_check";
      maxTurns?: number;
      maxAgentQuestionsPerTurn?: number;
      finalReply: FinalReplyCheck[];
    })
  | (ResolvedGraderCommon & { type: "goal_reached"; judge: string; guidance?: string });

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
  /** Agent plans only: the revision pinned at plan time and the conversation settings. */
  agent?: { definitionHash: string; definition: Record<string, unknown> };
  conversation?: ResolvedConversation;
  /** Agent plans only: null when no selected case is simulated. */
  userModel?: string | null;
};

export type EnvelopeOutput = {
  kind: "envelope";
  status: "success" | "failure";
  summary: string;
  payload?: Record<string, unknown>;
  artifacts: string[];
};

export type ConversationStopReason =
  | "script_end"
  | "resolved"
  | "abandoned"
  | "max_turns"
  | "no_progress"
  | "empty_message"
  | "error"
  | "timeout";

export type ConversationMessage = { role: "user" | "assistant"; text: string; turn: number };

export type ConversationToolCall = {
  id: string;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  result_summary: string;
  status: "ok" | "error" | "not_run";
  policy_outcome: "ran" | "stubbed" | "mocked" | "would_ask_first" | "denied";
  session_id?: string;
};

export type ConversationUsage = {
  cost_usd: number;
  agent_cost_usd: number;
  simulator_cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  simulator_tokens_in: number;
  simulator_tokens_out: number;
  simulator_estimated: boolean;
  agent_calls: number;
  simulator_calls: number;
};

/** The stored JSON shape (snake_case), which graders, the judge renderer and the console read as is. */
export type ConversationOutput = {
  kind: "conversation";
  status: "success" | "failure";
  summary: string;
  messages: ConversationMessage[];
  tool_calls: ConversationToolCall[];
  final_reply: string;
  turns: number;
  stop_reason: ConversationStopReason;
  usage: ConversationUsage;
  truncated?: Record<string, number>;
  /** Transport only: the bounded rendered transcript for the judge. The manager drops it before storing. */
  transcript?: string;
};

export type CaseOutput = EnvelopeOutput | ConversationOutput;

export type RunCaseRequest = { evalRunId: string; caseId: string; repeatIndex: number };

export type RunCaseFailureCode =
  | "EVAL_STAGE_FAILED"
  | "EVAL_STAGE_NEEDS_INPUT"
  | "EVAL_STAGE_TIMEOUT"
  | "EVAL_BUDGET_EXCEEDED"
  | "EVAL_CANCELLED"
  | "EVAL_ENGINE_ERROR"
  | "EVAL_AGENT_FAILED"
  | "EVAL_AGENT_EMPTY_REPLY"
  | "EVAL_AGENT_TIMEOUT"
  | "EVAL_SIMULATOR_ERROR";

export type RunCaseResult =
  | {
      ok: true;
      /** Root subject id: the stage run id (set by the manager when absent) or the root agent session id. */
      subjectRef?: string;
      stageRunId?: string;
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
      subjectRef?: string;
      stageRunId?: string;
      output?: ConversationOutput;
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
  onPhase(caseId: string, repeatIndex: number, phase: "stage_running" | "agent_running" | "grading" | "done"): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface EvalEngine {
  readonly name: string;
  version(): Promise<string>;
  /** Throws an Error with a `code` when the plan can never run on this engine (checked before a run row exists). */
  validatePlan?(plan: EvalPlan): void;
  run(plan: EvalPlan, io: EngineIo, signal: AbortSignal): Promise<void>;
}
