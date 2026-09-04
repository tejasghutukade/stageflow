import type { StageLogLine } from "../agent/activity.js";
import type { AskOperatorPrompt } from "../tools/askOperator.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  ResolvedPipelineDag,
} from "../types/pipeline.js";
import type { CompletionCheck } from "../types/completion.js";
import type { StageGateKind } from "../types/stage.js";

export type RunStatus = "created" | "running" | "succeeded" | "failed";

export type RunPipelineDagSnapshot = ResolvedPipelineDag & {
  stage_ids: string[];
  gate_kinds?: Record<string, StageGateKind[]>;
};

export type StageReadiness =
  | "blocked"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type PipelineTrackNode = {
  stage_id: string;
  status: StageSnapshot["status"];
  readiness: StageReadiness;
  layer: number;
  layer_order: number;
  blocked_by?: string[];
  gate_kinds?: StageGateKind[];
  attempt_count?: number;
  definition_id?: string;
};

export type PipelineTrackEdge = {
  from: string;
  to: string;
  envelope_summary?: string;
};

export type PipelineTrackProjection = {
  nodes: PipelineTrackNode[];
  edges: PipelineTrackEdge[];
};

export type RunMeta = {
  run_id: string;
  pipeline_id: string;
  created_at: string;
  status?: RunStatus;
  task_id?: string;
  updated_at?: string;
  checkout_root?: string;
  git_sha?: string;
  ci_pr_url?: string;
  ci_job_url?: string;
  pipeline_dag?: RunPipelineDagSnapshot;
  pipeline_path?: string;
  task_path?: string;
  project_root?: string;
};

export type CreatedRun = {
  runId: string;
  /** Opaque agent workspace path (artifacts live under this tree). */
  workspaceDir: string;
};

/** Persisted stage log line (activity or lifecycle) with optional timestamp. */
export type StageLogEvent = StageLogLine & {
  at?: string;
};

export type StageSnapshot = {
  stage_id: string;
  definition_id?: string;
  status:
    | "pending"
    | "running"
    | "waiting_for_input"
    | "succeeded"
    | "failed"
    | "skipped";
  events: StageLogEvent[];
  envelope: StageEnvelope | null;
  artifacts: string[];
  last_at?: string;
  pending_prompt?: AskOperatorPrompt;
  attempt_count: number;
};

export type StageExecution = {
  run_id: string;
  stage_id: string;
  attempt: number;
  status: StageSnapshot["status"];
  verification_outcome: VerificationOutcome;
  started_at?: string;
  finished_at?: string;
  envelope: StageEnvelope | null;
};

export type StageExecutionPatch = {
  status?: StageSnapshot["status"];
  verification_outcome?: VerificationOutcome;
  started_at?: string;
  finished_at?: string;
  envelope?: StageEnvelope | null;
};

/** The durable disposition of completion verification for one stage attempt. */
export type VerificationOutcome = "not_run" | "passed" | "failed" | "error";

/** The lifecycle state of one independently-run completion check. */
export type VerificationCheckStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

/**
 * Durable evidence for one check in one stage execution attempt.
 *
 * `evidence` is intentionally JSON-shaped: each checker owns its evidence
 * schema (for example, command output metadata or an artifact digest), while
 * the run store preserves it without privileging a particular checker.
 */
export type VerificationCheckResult = {
  run_id: string;
  stage_id: string;
  attempt: number;
  check_id: string;
  check_type: CompletionCheck["type"];
  status: VerificationCheckStatus;
  started_at?: string;
  finished_at?: string;
  evidence?: Record<string, unknown>;
};

/** Input for creating or updating a verification-check lifecycle record. */
export type VerificationCheckResultPatch = {
  check_id: string;
  check_type: CompletionCheck["type"];
  status: VerificationCheckStatus;
  started_at?: string;
  finished_at?: string;
  evidence?: Record<string, unknown>;
};

export type CompactStage = {
  id: string;
  status: StageSnapshot["status"];
  attempt_count: number;
  definition_id?: string;
};

export type RunSummary = {
  run_id: string;
  pipeline_id: string;
  task_id?: string;
  pipeline_path?: string;
  task_path?: string;
  project_root?: string;
  status: RunStatus;
  created_at: string;
  updated_at?: string;
  stages: CompactStage[];
  /** Present when a stage is waiting_for_input (first such stage). */
  waiting_stage_id?: string;
  /** All stages waiting_for_input in declaration order; omitted when none. */
  waiting_stage_ids?: string[];
  /** Short prompt text for Today triage; omitted when not waiting. */
  waiting_summary?: string;
  waiting_kind?: AskOperatorPrompt["kind"];
  waiting_prompt_id?: string;
  waiting_artifacts?: string[];
  waiting_questions?: string[];
  failed_stage_id?: string;
  failed_reason?: string;
};

export type RunDetail = Omit<RunSummary, "stages"> & {
  task_yaml: string;
  stages: StageSnapshot[];
  pipeline_track: PipelineTrackProjection;
};

export type CreateRunInput = {
  pipelineId: string;
  taskYaml: string;
  taskId?: string;
  checkoutRoot?: string;
  gitSha?: string;
  ciPrUrl?: string;
  ciJobUrl?: string;
  pipelineDag?: RunPipelineDagSnapshot;
  pipelinePath?: string;
  taskPath?: string;
  projectRoot?: string;
};

export type ListRunsFilter = {
  status?: RunStatus;
  /** ISO timestamp; keep runs with created_at >= since */
  since?: string;
  /** Match pipeline_id or pipeline_path */
  pipeline?: string;
};

/**
 * Persistence port for pipeline run state.
 * Call sites should prefer CreatedRun.workspaceDir from createRun over
 * getWorkspaceDir; the latter returns the opaque run workspace root when a
 * run id is all you have (catalog / rehydrate).
 */
export interface RunStore {
  createRun(input: CreateRunInput): Promise<CreatedRun>;
  updateRunStatus(runId: string, status: RunStatus): Promise<void>;
  readRunMeta(runId: string): Promise<RunMeta>;
  readTaskYaml(runId: string): Promise<string>;
  /** Opaque run workspace root for agents and artifact tools. */
  getWorkspaceDir(runId: string): string;
  ensureStageWorkspace(runId: string, stageId: string): Promise<void>;
  ensureAttemptWorkspace(
    runId: string,
    stageId: string,
    attempt: number,
  ): Promise<void>;
  createStageExecution(runId: string, stageId: string): Promise<StageExecution>;
  listStageExecutions(runId: string, stageId: string): Promise<StageExecution[]>;
  getLatestStageExecution(
    runId: string,
    stageId: string,
  ): Promise<StageExecution | null>;
  countStageAttempts(runId: string, stageId: string): Promise<number>;
  getStageExecution(
    runId: string,
    stageId: string,
    attempt: number,
  ): Promise<StageExecution>;
  updateStageExecution(
    runId: string,
    stageId: string,
    attempt: number,
    patch: StageExecutionPatch,
  ): Promise<void>;
  /** Create or update evidence for one check in a stage execution attempt. */
  upsertVerificationCheckResult(
    runId: string,
    stageId: string,
    result: VerificationCheckResultPatch,
    options?: { attempt?: number },
  ): Promise<void>;
  /**
   * List verification evidence in write order. Without an attempt, returns all
   * attempts for the stage; callers may pass an attempt to inspect one retry.
   */
  listVerificationCheckResults(
    runId: string,
    stageId: string,
    attempt?: number,
  ): Promise<VerificationCheckResult[]>;
  writeEnvelope(
    runId: string,
    stageId: string,
    envelope: StageEnvelope,
    options?: { attempt?: number },
  ): Promise<void>;
  readEnvelope(runId: string, stageId: string): Promise<StageEnvelope>;
  appendStageEvent(
    runId: string,
    stageId: string,
    event: StageLogLine,
    options?: { attempt?: number },
  ): Promise<void>;
  listStageEvents(
    runId: string,
    stageId: string,
    attempt?: number,
  ): Promise<StageLogEvent[]>;
  listRuns(filter?: ListRunsFilter): Promise<RunSummary[]>;
  readRun(runId: string): Promise<RunDetail>;
  updatePipelineDag(runId: string, dag: RunPipelineDagSnapshot): Promise<void>;
}

export function stageStatusFromEvents(
  events: StageLogEvent[],
): StageSnapshot["status"] {
  let status: StageSnapshot["status"] = "pending";
  for (const ev of events) {
    if (ev.event === "started" || ev.event === "resumed") status = "running";
    if (ev.event === "waiting_for_input") status = "waiting_for_input";
    if (ev.event === "succeeded") status = "succeeded";
    if (ev.event === "failed") status = "failed";
    if (ev.event === "skipped") status = "skipped";
  }
  return status;
}

export function deriveStatusFromStages(stages: StageSnapshot[]): RunStatus {
  if (stages.length === 0) return "created";
  if (stages.some((s) => s.status === "failed")) return "failed";
  if (stages.every((s) => s.status === "succeeded" || s.status === "skipped")) {
    return "succeeded";
  }
  if (
    stages.some(
      (s) =>
        s.status === "running" ||
        s.status === "waiting_for_input" ||
        s.status === "succeeded",
    )
  ) {
    return "running";
  }
  return "created";
}
