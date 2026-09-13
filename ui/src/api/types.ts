export type RunStatus = "created" | "running" | "succeeded" | "failed";

export type StageLogEvent = {
  event: string;
  at?: string;
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  argsPreview?: string;
  resultPreview?: string;
  textPreview?: string;
  isError?: boolean;
  role?: string;
  text?: string;
  [key: string]: unknown;
};

export type CompactStage = {
  id: string;
  status: StageSnapshot["status"];
  attempt_count: number;
  cost_usd?: number;
};

export type StageGateKind =
  | "free_text"
  | "confirm"
  | "multi_question"
  | "artifact_backed";

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

export type FeedbackLoopConfig = {
  target: string;
  max_replays: number;
  on_max_replays: "require_continue" | "wait_for_human";
  replay_session: "resume" | "new_session";
};

export type FeedbackLoopState =
  | "active"
  | "waiting_for_human"
  | "continued"
  | "abandoned"
  | "completed";

export type FeedbackReplayStatus =
  | "scheduled"
  | "active"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "superseded";

export type FeedbackReplayStagePassStatus =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "superseded";

export type ForkGenerationStatus = "active" | "completed" | "superseded";

export type DeferredFeedbackSendBack = {
  target: string;
  feedback_envelope: StageEnvelopeView;
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
  replay_number: number;
  max_replays: number;
  replay_session: FeedbackLoopConfig["replay_session"];
  route_stage_ids: string[];
  feedback_envelope: StageEnvelopeView;
  status: FeedbackReplayStatus;
  created_at: string;
  updated_at: string;
};

export type FeedbackReplayStagePassRecord = {
  run_id: string;
  replay_id: string;
  stage_id: string;
  stage_attempt: number;
  session_origin_attempt?: number;
  session_mode: FeedbackLoopConfig["replay_session"];
  status: FeedbackReplayStagePassStatus;
  started_at?: string;
  finished_at?: string;
  emitted_envelope?: StageEnvelopeView;
};

export type ForkGenerationRecord = {
  run_id: string;
  generation_id: string;
  replay_id?: string;
  fork_parent_stage_id: string;
  generation_number: number;
  clone_stage_ids: string[];
  status: ForkGenerationStatus;
  created_at: string;
  updated_at: string;
};

export type FeedbackLoopHistory = {
  loop: FeedbackLoopRecord;
  replays: Array<{
    replay: FeedbackReplayRecord;
    stage_passes: FeedbackReplayStagePassRecord[];
    fork_generations: ForkGenerationRecord[];
  }>;
  fork_generations: ForkGenerationRecord[];
};

export type FeedbackLoopDecisionKind = "extend" | "continue" | "abandon";

export type FeedbackDecisionResult =
  | {
      ok: true;
      effect: "extended" | "continued" | "abandoned";
      loopId: string;
    }
  | { ok: false; error: string; status?: number };

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
  waiting_stage_id?: string;
  waiting_stage_ids?: string[];
  waiting_summary?: string;
  waiting_kind?: PendingPrompt["kind"] | "feedback_loop_decision";
  waiting_prompt_id?: string;
  waiting_artifacts?: string[];
  waiting_questions?: string[];
  failed_stage_id?: string;
  failed_reason?: string;
  active_feedback_loop?: FeedbackLoopRecord;
  total_cost_usd?: number;
};

export type StageEnvelopeView = {
  status: string;
  summary: string;
  artifacts: string[];
  notes?: string;
  payload?: Record<string, unknown>;
  stage_id?: string;
  fork_choice?: string[];
  feedback_loop?:
    | { action: "continue" }
    | { action: "send_back"; target: string };
};

export type Decision = "accept" | "reject";

export type SubQuestionKind = "free_text" | "confirm";

export type MultiQuestionItem = {
  kind: SubQuestionKind;
  message: string;
  id: string;
};

export type PendingPrompt =
  | { kind: "free_text"; message: string; id: string }
  | { kind: "confirm"; message: string; id: string }
  | {
      kind: "multi_question";
      id: string;
      questions: MultiQuestionItem[];
    }
  | {
      kind: "artifact_backed";
      message: string;
      artifacts: string[];
      id: string;
    };

export type FreeTextOrConfirmPayload =
  | { kind: "free_text"; text: string }
  | { kind: "confirm"; decision: Decision; text?: string };

export type StageAnswer =
  | { promptId: string; kind: "free_text"; text: string }
  | {
      promptId: string;
      kind: "confirm";
      decision: Decision;
      text?: string;
    }
  | {
      promptId: string;
      kind: "artifact_backed";
      decision: Decision;
      text?: string;
    }
  | {
      promptId: string;
      kind: "multi_question";
      answers: Record<string, FreeTextOrConfirmPayload>;
    };

export type StageSnapshot = {
  stage_id: string;
  status:
    | "pending"
    | "running"
    | "waiting_for_input"
    | "succeeded"
    | "failed"
    | "skipped";
  events: StageLogEvent[];
  envelope: StageEnvelopeView | null;
  artifacts: string[];
  last_at?: string;
  pending_prompt?: PendingPrompt;
  attempt_count: number;
  cost_usd?: number;
};

export type VerificationCheckStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export type CompletionCheckType =
  | "command"
  | "artifact"
  | "checklist"
  | "payload_schema"
  | "gate"
  | "checkout_changes";

export type VerificationCheckResult = {
  run_id: string;
  stage_id: string;
  attempt: number;
  check_id: string;
  check_type: CompletionCheckType;
  status: VerificationCheckStatus;
  started_at?: string;
  finished_at?: string;
  evidence?: Record<string, unknown>;
};

export type StageVerificationAttempt = {
  attempt: number;
  status: StageSnapshot["status"];
  verification_outcome: "not_run" | "passed" | "failed" | "error";
  started_at?: string;
  finished_at?: string;
  checks: VerificationCheckResult[];
};

export type StageVerificationHistory = {
  run_id: string;
  stage_id: string;
  attempts: StageVerificationAttempt[];
  manual_recovery?: {
    status: "available" | "stopped";
    failed_attempt: number;
  };
};

export type RunDetail = Omit<RunSummary, "stages"> & {
  task_yaml: string;
  stages: StageSnapshot[];
  pipeline_track: PipelineTrackProjection;
  feedback_loops: FeedbackLoopHistory[];
};

export type TaskListing = {
  path: string;
  id: string;
  goal: string;
};

export type PipelineStageListing = {
  id: string;
  gate_kinds?: StageGateKind[];
  uses_path?: string;
  inline?: boolean;
};

export type PipelineListing = {
  path: string;
  id: string;
  stages: PipelineStageListing[];
};

export type ValidStageListing = {
  path: string;
  id: string;
  used_by_pipeline_ids: string[];
  gate_kinds?: StageGateKind[];
};

export type BrokenStageListing = {
  path: string;
  error: string;
  id?: string;
  model?: string;
  gate_kinds?: StageGateKind[];
};

export type StageListing = ValidStageListing | BrokenStageListing;

export type SkillScope = "user" | "project" | "temporary";

export type SkillListing = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: SkillScope;
  source: string;
  disableModelInvocation: boolean;
};

export type SkillDiagnostic = {
  message: string;
  path?: string;
};

export type PackageScope = "user" | "project";

export type ExtensionFileScope = "user" | "project" | "temporary";

export type PackageListing = {
  source: string;
  scope: PackageScope;
  filtered: boolean;
  installedPath?: string;
};

export type ExtensionFileListing = {
  name: string;
  path: string;
  scope: ExtensionFileScope;
  source: string;
  origin: "package" | "top-level";
  baseDir?: string;
  enabled: boolean;
};

export type CreateStageInput = {
  pipeline_directory: string;
  filename: string;
  id: string;
  system_prompt: string;
  model?: string;
  gate_kinds?: StageGateKind[];
};

export type CreatedStageListing = {
  path: string;
  id: string;
  gate_kinds?: StageGateKind[];
};

export type CreateStageResult =
  | { ok: true; stage: CreatedStageListing }
  | { ok: false; status: number; error: string };

export type CreatePipelineStageRef = {
  id: string;
  needs?: string;
  uses?: string;
  inline?: {
    system_prompt: string;
    model?: string;
    gate_kinds?: StageGateKind[];
  };
};

export type CreatePipelineInput = {
  directory: string;
  id: string;
  stages: CreatePipelineStageRef[];
};

export type CreatePipelineResult =
  | { ok: true; pipeline: PipelineListing }
  | { ok: false; status: number; error: string };

export type CapacityHealth = {
  ok: true;
  activeRunIds: string[];
  activeCount: number;
  maxConcurrent: number;
  slotsAvailable: number;
};

export type CredentialSource = "pi_home" | "sf_owned";

export type ProviderSummary = {
  id: string;
  name: string;
  supportsApiKey: boolean;
  supportsOauth: boolean;
  oauthLabel?: string;
};

export type ProviderAuthStatus = {
  providerId: string;
  configured: boolean;
  authKind?: "api_key" | "oauth" | "none";
  source?: string;
};

export type ProvidersListResult = {
  authShell: "pi";
  via: "pi";
  providers: ProviderSummary[];
};

export type PiHomeDetectResult = {
  piHomeUsable: boolean;
  credentialSource?: CredentialSource;
  provisional: boolean;
  source: CredentialSource;
};

export type CredentialBindingView = {
  source: CredentialSource;
  provisional: boolean;
};

export type SettingsSnapshot = {
  maxConcurrent: number;
  credentialSource?: CredentialSource;
  binding: CredentialBindingView;
};

export type ProviderAuthMutationResult =
  | { ok: true; provider: ProviderAuthStatus }
  | { ok: false; status: number; error: string };

export type LoginSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type LoginSessionPendingPrompt = {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly {
    id: string;
    label: string;
    description?: string;
  }[];
};

export type LoginSessionEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export type LoginSessionProjection = {
  id: string;
  providerId: string;
  authType: "oauth";
  status: LoginSessionStatus;
  events: LoginSessionEvent[];
  pendingPrompt?: LoginSessionPendingPrompt;
  error?: { message: string };
  warning?: { message: string };
  provider?: ProviderAuthStatus;
};

export type LoginSessionMutationResult =
  | { ok: true; session: LoginSessionProjection }
  | { ok: false; status: number; error: string };

export type StartRunResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      error: string;
      code?: "busy_capacity" | "busy_checkout" | string;
      activeRunIds?: string[];
      conflictingRunId?: string;
    };

export type RetryStageResult =
  | { ok: true; runId: string; stageId: string; attemptIndex: number }
  | {
      ok: false;
      error: string;
      code?:
        | "stage_not_failed"
        | "hitl_not_retriable"
        | "run_not_retryable"
        | "retry_in_progress"
        | "busy_capacity"
        | "busy_checkout"
        | string;
      activeCount?: number;
      maxConcurrent?: number;
      activeRunIds?: string[];
      conflictingRunId?: string;
      conflictingCheckout?: string;
    };

export type ProjectMcpCatalogTransport = "stdio" | "http";

export type ProjectMcpCatalogEntry = {
  name: string;
  transport: ProjectMcpCatalogTransport;
};

export type ProjectMcpCatalogListStatus = "ok" | "missing_catalog" | "invalid_config";

export type ProjectMcpCatalogList = {
  status: ProjectMcpCatalogListStatus;
  servers: ProjectMcpCatalogEntry[];
};

export type ProjectMcpProbeStatus =
  | "connected"
  | "needs_auth"
  | "connect_failed"
  | "unresolved_var"
  | "invalid_config"
  | "missing_catalog"
  | "cancelled";

export type ProjectMcpProbeResult = {
  name: string;
  status: ProjectMcpProbeStatus;
  error?: string;
};

export type ProjectMcpRowStatus =
  | "not-yet-probed"
  | "probing"
  | ProjectMcpProbeStatus;
