import type { StageLogLine } from "../agent/activity.js";
import { predecessorEdges } from "../config/pipelineNeeds.js";
import type { AskOperatorPrompt } from "../tools/askOperator.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  FeedbackLoopConfig,
  ResolvedPipelineDag,
} from "../types/pipeline.js";
import type { CompletionCheck } from "../types/completion.js";
import type { StageGateKind } from "../types/stage.js";
import type { StageUsage } from "../types/usage.js";

export type RunStatus = "created" | "running" | "succeeded" | "failed";

export type RunPipelineDagSnapshot = ResolvedPipelineDag & {
  stage_ids: string[];
  gate_kinds?: Record<string, StageGateKind[]>;
  clone_input_schema?: Record<string, unknown>;
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
  feedback_loop?: { target: string };
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
  /** Total $ spent on this stage across every attempt; omitted when no attempt reported usage. */
  cost_usd?: number;
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
  cost_usd?: number;
  usage?: StageUsage;
};

export type StageExecutionPatch = {
  status?: StageSnapshot["status"];
  verification_outcome?: VerificationOutcome;
  started_at?: string;
  finished_at?: string;
  envelope?: StageEnvelope | null;
  cost_usd?: number;
  usage?: StageUsage;
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

/** Durable lifecycle for one source-owned feedback-loop policy in a run. */
export type FeedbackLoopState =
  | "active"
  | "waiting_for_human"
  | "continued"
  | "abandoned"
  | "completed";

/** Durable lifecycle for one accepted send-back through a feedback loop. */
export type FeedbackReplayStatus =
  | "scheduled"
  | "active"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "superseded";

/** Lifecycle for one persistent stage's pass within a feedback replay. */
export type FeedbackReplayStagePassStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "superseded";

/** Active/history state for a dynamic clone cohort created by a fork parent. */
export type ForkGenerationStatus = "active" | "completed" | "superseded";

/** Deferred over-limit send_back awaiting a human feedback-loop decision. */
export type DeferredFeedbackSendBack = {
  target: string;
  feedback_envelope: StageEnvelope;
  source_attempt: number;
};

export type FeedbackLoopRecord = {
  run_id: string;
  loop_id: string;
  source_stage_id: string;
  source_attempt: number;
  policy: FeedbackLoopConfig;
  state: FeedbackLoopState;
  current_replay_id?: string;
  current_replay_number?: number;
  deferred_send_back?: DeferredFeedbackSendBack;
  created_at: string;
  updated_at: string;
};

export type FeedbackReplayRecord = {
  run_id: string;
  replay_id: string;
  loop_id: string;
  source_stage_id: string;
  source_attempt: number;
  target_stage_id: string;
  /** One-based accepted send-back count for this loop. */
  replay_number: number;
  max_replays: number;
  replay_session: FeedbackLoopConfig["replay_session"];
  route_stage_ids: string[];
  feedback_envelope: StageEnvelope;
  status: FeedbackReplayStatus;
  created_at: string;
  updated_at: string;
};

export type FeedbackReplayStagePassRecord = {
  run_id: string;
  replay_id: string;
  stage_id: string;
  /** Execution attempt whose session this pass resumes or newly creates. */
  stage_attempt: number;
  /** Immutable attempt whose Pi session resume targets; never rebound. */
  session_origin_attempt?: number;
  session_mode: FeedbackLoopConfig["replay_session"];
  status: FeedbackReplayStagePassStatus;
  started_at?: string;
  finished_at?: string;
  emitted_envelope?: StageEnvelope;
};

export type ForkGenerationRecord = {
  run_id: string;
  generation_id: string;
  /** Undefined for an initial fan-out that is not part of a replay. */
  replay_id?: string;
  fork_parent_stage_id: string;
  generation_number: number;
  clone_stage_ids: string[];
  status: ForkGenerationStatus;
  created_at: string;
  updated_at: string;
};

export type CreateFeedbackLoopInput = Omit<
  FeedbackLoopRecord,
  "run_id" | "state" | "current_replay_id" | "current_replay_number" | "created_at" | "updated_at"
> & {
  state?: FeedbackLoopState;
};

export type FeedbackLoopPatch = Partial<
  Pick<
    FeedbackLoopRecord,
    | "state"
    | "current_replay_id"
    | "current_replay_number"
    | "policy"
  >
> & {
  /** Set to clear a previously deferred send_back. */
  deferred_send_back?: DeferredFeedbackSendBack | null;
};

export type CreateFeedbackReplayInput = Omit<
  FeedbackReplayRecord,
  "run_id" | "status" | "created_at" | "updated_at"
> & {
  status?: FeedbackReplayStatus;
};

export type FeedbackReplayPatch = Partial<Pick<FeedbackReplayRecord, "status">>;

export type CreateFeedbackReplayStagePassInput = Omit<
  FeedbackReplayStagePassRecord,
  "run_id" | "status" | "started_at" | "finished_at" | "emitted_envelope"
> & {
  status?: FeedbackReplayStagePassStatus;
  started_at?: string;
  finished_at?: string;
  emitted_envelope?: StageEnvelope;
};

export type FeedbackReplayStagePassPatch = Partial<
  Pick<FeedbackReplayStagePassRecord, "status" | "stage_attempt">
> & {
  started_at?: string | null;
  finished_at?: string | null;
  emitted_envelope?: StageEnvelope | null;
};

export type CreateForkGenerationInput = Omit<
  ForkGenerationRecord,
  "run_id" | "status" | "created_at" | "updated_at"
> & {
  status?: ForkGenerationStatus;
};

export type ForkGenerationPatch = Partial<Pick<ForkGenerationRecord, "status">>;

export type CompactStage = {
  id: string;
  status: StageSnapshot["status"];
  attempt_count: number;
  definition_id?: string;
  cost_usd?: number;
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
  waiting_kind?: AskOperatorPrompt["kind"] | "feedback_loop_decision";
  waiting_prompt_id?: string;
  waiting_artifacts?: string[];
  waiting_questions?: string[];
  failed_stage_id?: string;
  failed_reason?: string;
  /** The active loop, when a run is currently replaying or awaiting a decision. */
  active_feedback_loop?: FeedbackLoopRecord;
  /** Sum of every stage's cost_usd; omitted when no stage reported usage. */
  total_cost_usd?: number;
};

export type RunDetail = Omit<RunSummary, "stages"> & {
  task_yaml: string;
  stages: StageSnapshot[];
  pipeline_track: PipelineTrackProjection;
  /** Append-only feedback-loop and replay history, ordered by creation. */
  feedback_loops: FeedbackLoopHistory[];
};

export type FeedbackLoopHistory = {
  loop: FeedbackLoopRecord;
  replays: Array<{
    replay: FeedbackReplayRecord;
    stage_passes: FeedbackReplayStagePassRecord[];
    fork_generations: ForkGenerationRecord[];
  }>;
  /** Fork cohorts not associated with a replay, for example the first pass. */
  fork_generations: ForkGenerationRecord[];
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
  createFeedbackLoop(
    runId: string,
    input: CreateFeedbackLoopInput,
  ): Promise<FeedbackLoopRecord>;
  getFeedbackLoop(runId: string, loopId: string): Promise<FeedbackLoopRecord>;
  listFeedbackLoops(runId: string): Promise<FeedbackLoopRecord[]>;
  /**
   * Patch a feedback loop. When `expectedState` is set, the update is conditional
   * (CAS): returns false if the row exists but state does not match.
   * Throws if the loop is missing.
   */
  updateFeedbackLoop(
    runId: string,
    loopId: string,
    patch: FeedbackLoopPatch,
    options?: { expectedState?: FeedbackLoopState },
  ): Promise<boolean>;
  createFeedbackReplay(
    runId: string,
    input: CreateFeedbackReplayInput,
  ): Promise<FeedbackReplayRecord>;
  getFeedbackReplay(runId: string, replayId: string): Promise<FeedbackReplayRecord>;
  listFeedbackReplays(runId: string, loopId: string): Promise<FeedbackReplayRecord[]>;
  updateFeedbackReplay(
    runId: string,
    replayId: string,
    patch: FeedbackReplayPatch,
  ): Promise<void>;
  createFeedbackReplayStagePass(
    runId: string,
    input: CreateFeedbackReplayStagePassInput,
  ): Promise<FeedbackReplayStagePassRecord>;
  listFeedbackReplayStagePasses(
    runId: string,
    replayId: string,
  ): Promise<FeedbackReplayStagePassRecord[]>;
  updateFeedbackReplayStagePass(
    runId: string,
    replayId: string,
    stageId: string,
    patch: FeedbackReplayStagePassPatch,
  ): Promise<void>;
  createForkGeneration(
    runId: string,
    input: CreateForkGenerationInput,
  ): Promise<ForkGenerationRecord>;
  listForkGenerations(
    runId: string,
    options?: { replayId?: string; forkParentStageId?: string },
  ): Promise<ForkGenerationRecord[]>;
  updateForkGeneration(
    runId: string,
    generationId: string,
    patch: ForkGenerationPatch,
  ): Promise<void>;
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

function definitionIdForStage(
  dag: Pick<RunPipelineDagSnapshot, "nodes">,
  stageId: string,
  snapshotsById: Map<string, StageSnapshot>,
): string {
  const snap = snapshotsById.get(stageId);
  if (snap?.definition_id) return snap.definition_id;
  const node = dag.nodes.find((n) => n.id === stageId);
  return node?.definition_id ?? stageId;
}

function failureAcceptedByJoin(
  dag: Pick<RunPipelineDagSnapshot, "nodes">,
  failedId: string,
  snapshotsById: Map<string, StageSnapshot>,
): boolean {
  const defId = definitionIdForStage(dag, failedId, snapshotsById);
  for (const node of dag.nodes) {
    const edge = predecessorEdges(node).find(
      (item) => item.id === failedId || item.id === defId,
    );
    if (!edge?.on.includes("failed")) continue;
    const join = snapshotsById.get(node.id);
    if (join && join.status !== "skipped") return true;
  }
  return false;
}

export function findUnhandledFailedStage(
  stages: StageSnapshot[],
  dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null,
): StageSnapshot | undefined {
  const byId = new Map(stages.map((s) => [s.stage_id, s]));
  return stages.find((stage) => {
    if (stage.status !== "failed") return false;
    if (!dag) return true;
    return !failureAcceptedByJoin(dag, stage.stage_id, byId);
  });
}

function stageResolvedForSuccess(
  stage: StageSnapshot,
  dag: Pick<RunPipelineDagSnapshot, "nodes"> | null | undefined,
  byId: Map<string, StageSnapshot>,
): boolean {
  if (stage.status === "succeeded" || stage.status === "skipped") return true;
  if (stage.status === "failed" && dag) {
    return failureAcceptedByJoin(dag, stage.stage_id, byId);
  }
  return false;
}

export function deriveStatusFromStages(
  stages: StageSnapshot[],
  dag?: Pick<RunPipelineDagSnapshot, "nodes"> | null,
): RunStatus {
  if (stages.length === 0) return "created";
  if (findUnhandledFailedStage(stages, dag)) return "failed";
  const byId = new Map(stages.map((s) => [s.stage_id, s]));
  if (stages.every((s) => stageResolvedForSuccess(s, dag, byId))) {
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
