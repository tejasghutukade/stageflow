export type RunStatus =
  | "created"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

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
  | "interrupted"
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

export type RunBindingCompact = {
  kind: "repository" | "checkout" | "unbound";
  repository?: string;
  ref?: string;
  resolved_sha?: string;
};

export type RunBindingDetail = RunBindingCompact & {
  run_branch?: string;
  checkout_root?: string;
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
  binding?: RunBindingCompact;
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
  cancel_reason?: string;
  finished_at?: string;
  slimmed_at?: string;
  disk_bytes?: number;
  disk_measured_at?: string;
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

export type GateHandoff =
  | { kind: "local_window" }
  | { kind: "live_view"; url: string };

export type PendingPrompt = (
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
    }
) & {
  /** Set by the Host for stages with a browser; older gates omit these. */
  handoff?: GateHandoff;
  site?: string;
  profile?: string;
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
    | "interrupted"
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
  | "checkout_changes"
  | "browser_login";

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

export type RunDetail = Omit<RunSummary, "stages" | "binding"> & {
  binding?: RunBindingDetail;
  task_yaml: string;
  stages: StageSnapshot[];
  pipeline_track: PipelineTrackProjection;
  feedback_loops: FeedbackLoopHistory[];
  config_origins?: Array<{
    name: string;
    origin: "catalog" | "inline" | "workspace" | "seeded";
    path?: string;
  }>;
};

export type TaskListing = {
  path: string;
  id: string;
  goal: string;
  project_root?: string;
};

export type TaskDetailFile = {
  path: string;
  id: string;
  goal: string;
  context?: string;
  constraints?: string;
  checkout?: string;
  repository?: string;
  ref?: string;
  run_branch_template?: string;
  git_identity?: { name?: string; email?: string };
  input?: Record<string, unknown>;
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
  project_root?: string;
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

export type ValidationFinding = {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
  category: string;
  pipelineId?: string;
  stageId?: string;
};

export type DraftValidationResult = {
  scope: "full" | "pipeline" | "task";
  ok: boolean;
  summary: { errors: number; warnings: number };
  findings: ValidationFinding[];
};

export type CatalogValidationResult = DraftValidationResult;

export type CatalogFileResult = {
  path: string;
  content: string;
};

export type DraftPackagePayload = {
  pipeline: {
    id: string;
    stages: Array<Record<string, unknown>>;
    agent?: unknown;
    model?: unknown;
    schemas?: unknown;
    requires?: unknown;
  };
  stages?: Array<{ path: string; body: Record<string, unknown> }>;
  task?: { filename: string; body: Record<string, unknown> };
};

export type CreateDraftPackageInput = {
  directory: string;
  draft: DraftPackagePayload;
  pipelineFilename?: string;
  project_root?: string;
  allowInvalid?: boolean;
};

export type CreateDraftPackageResult =
  | {
      ok: true;
      pipeline: PipelineListing;
      pipelinePath: string;
      stagePaths: string[];
      taskPath?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      findings?: ValidationFinding[];
    };

export type OverwriteDraftPackageInput = CreateDraftPackageInput;
export type OverwriteDraftPackageResult = CreateDraftPackageResult;

export type OpenDraftPackageInput = {
  path: string;
  task?: string;
  project_root?: string;
};

export type OpenDraftPackageResult =
  | {
      ok: true;
      draft: DraftPackagePayload;
      destination: { directory: string; pipelineFilename: string };
      pipelinePath: string;
      taskPath?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type AttachTaskInput = {
  task: string;
  project_root?: string;
};

export type AttachTaskResult =
  | {
      ok: true;
      task: { filename: string; body: Record<string, unknown> };
      taskPath: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type WorkshopAutosavePayload = {
  version: 1;
  key: string;
  updatedAt: string;
  draft: DraftPackagePayload;
  messages: Array<{
    id: string;
    role: "assistant" | "user" | "system";
    text: string;
    artifacts?: unknown;
  }>;
  autoApply: boolean;
  sessionModelOverride?: string | null;
  destination?: {
    directory: string;
    pipelineFilename?: string;
  } | null;
  savedPath?: string | null;
  savedTaskPath?: string | null;
  diskFingerprints?: Record<string, string>;
};

export type GetWorkshopAutosaveResult =
  | { ok: true; key: string; autosave: WorkshopAutosavePayload | null }
  | { ok: false; status: number; error: string };

export type PutWorkshopAutosaveResult =
  | { ok: true; autosave: WorkshopAutosavePayload }
  | { ok: false; status: number; error: string };

export type ClearWorkshopAutosaveResult =
  | { ok: true; key: string; cleared: boolean }
  | { ok: false; status: number; error: string };

export type WorkshopDiskChangeInput = {
  pipelinePath: string;
  draft: DraftPackagePayload;
  taskPath?: string | null;
  baseline?: Record<string, string> | null;
  project_root?: string;
};

export type WorkshopDiskChangeResult =
  | {
      ok: true;
      fingerprints: Record<string, string>;
      changed: boolean;
      changedPaths: string[];
    }
  | { ok: false; status: number; error: string };

export type WorkshopChatProposalPayload = {
  id: string;
  summary: string;
  nextDraft: DraftPackagePayload;
  baseDraft: DraftPackagePayload;
  baseFingerprint: string;
  artifacts: Array<{
    path: string;
    kind: "added" | "removed" | "modified";
    before?: string;
    after?: string;
  }>;
  affectedStageIds: string[];
};

export type WorkshopChatWireEvent =
  | { type: "message"; role: "assistant" | "user" | "system"; text: string }
  /** Mutation receipt for Accept/Reject UX (draft already mutated). */
  | {
      type: "proposal";
      proposal: WorkshopChatProposalPayload;
    }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "validation"; result: unknown }
  | { type: "error"; message: string };

export type WorkshopChatTurnPayload = {
  sessionId: string;
  events: WorkshopChatWireEvent[];
  draft: DraftPackagePayload;
  pending: WorkshopChatProposalPayload | null;
  autoApply: boolean;
  model: string;
  buildId?: string | null;
};

export type WorkshopChatTurnInput = {
  sessionId: string;
  message: string;
  draft: DraftPackagePayload;
  autoApply?: boolean;
  model?: string | null;
  stream?: boolean;
};

export type WorkshopChatTurnResult =
  | ({ ok: true } & WorkshopChatTurnPayload)
  | { ok: false; status: number; error: string };

export type WorkshopToolCallUpdate = {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  target?: string;
  errorMessage?: string;
  draft?: DraftPackagePayload;
  buildId?: string;
};

export type WorkshopPointerChangeFrame = {
  type: "pointer-change";
  buildId: string;
  draft: DraftPackagePayload;
};

export type WorkshopChatStreamFrame =
  | { type: "delta"; text: string }
  | ({ type: "activity" } & WorkshopToolCallUpdate)
  | WorkshopPointerChangeFrame
  | { type: "event"; event: WorkshopChatWireEvent }
  | ({ type: "done" } & WorkshopChatTurnPayload);

export type WorkshopSessionMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  createdAt: string;
};

export type WorkshopSessionRecord = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  transcript: WorkshopSessionMessage[];
  piSessionId: string | null;
  activeBuildId?: string;
};

export type WorkshopSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeBuildId?: string;
};

export type WorkshopBuildRecord = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  draft: DraftPackagePayload;
  projectRoot: string | null;
  relativePath: string | null;
};

export type WorkshopPickerRow = {
  id: string | null;
  name: string;
  projectRoot: string | null;
  relativePath: string | null;
};

export type ListWorkshopPickerResult =
  | { ok: true; rows: WorkshopPickerRow[] }
  | { ok: false; status: number; error: string };

export type GetWorkshopBuildResult =
  | { ok: true; build: WorkshopBuildRecord }
  | { ok: false; status: number; error: string };

export type FocusWorkshopBuildResult =
  | { ok: true; build: WorkshopBuildRecord }
  | { ok: false; status: number; error: string };

export type UpdateWorkshopSessionActiveBuildResult =
  | { ok: true; session: WorkshopSessionRecord }
  | { ok: false; status: number; error: string };

export type ListWorkshopSessionsResult =
  | { ok: true; sessions: WorkshopSessionSummary[] }
  | { ok: false; status: number; error: string };

export type CreateWorkshopSessionResult =
  | { ok: true; session: WorkshopSessionRecord }
  | { ok: false; status: number; error: string };

export type GetWorkshopSessionResult =
  | { ok: true; session: WorkshopSessionRecord }
  | { ok: false; status: number; error: string; code?: string };

export type WorkshopSessionMutationResult =
  | {
      ok: true;
      sessionId: string;
      draft: DraftPackagePayload;
      pending: WorkshopChatProposalPayload | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      reason?: "none" | "id_mismatch" | "conflict";
      notice?: string;
      draft?: DraftPackagePayload;
      pending?: WorkshopChatProposalPayload | null;
      sessionId?: string;
    };

export type CapacityHealth = {
  ok: true;
  activeRunIds: string[];
  activeCount: number;
  maxConcurrent: number;
  slotsAvailable: number;
  activeStageProcesses?: number;
  maxActiveStageProcesses?: number | null;
  disk?: {
    runs_bytes: number;
    worktrees_bytes: number;
    repos_bytes: number;
    state_db_bytes: number;
    a2a_artifacts_bytes: number;
    free_bytes: number;
  };
};

export type CredentialSource = "sf_owned";

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

export type ProvidersDetectResult = {
  credentialSource?: CredentialSource;
  provisional: boolean;
  source: CredentialSource;
  authConfigured?: boolean;
  cursorSdkReady?: boolean;
  cursorApiKeyConfigured?: boolean;
};

export type CredentialBindingView = {
  source: CredentialSource;
  provisional: boolean;
};

export type SettingsSnapshot = {
  maxConcurrent: number;
  credentialSource?: CredentialSource;
  binding: CredentialBindingView;
  workshopModel?: string;
  /** Model selected when Workshop opens. From stageflow.yaml `model`. */
  defaultModel?: string;
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

export type TriggerSchedule = {
  cron: string;
  timezone?: string;
};

export type EmailTriggerRule = {
  triggerId: string;
  version: number;
  activeAfter: string;
  enabled: boolean;
  accountId: string;
  folder: string;
  from?: string;
  subjectContains?: string;
  pipeline: string;
  task: { id: string; goal: string; context?: string; constraints?: string };
  includeBody: boolean;
  bodyLimit: number;
};

export type ConnectionListing = {
  id: string;
  channel: "Email";
  displayName: string;
  address: string;
  enabled: boolean;
  folders: string[];
};

export type TriggerEvent = {
  source: string;
  match?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

export type TriggerAdapterStatus = {
  adapter: string;
  state: string;
  detail?: string;
  last_poll_at?: string;
  last_seen_at?: string;
  last_error?: string;
};

export type TriggerListItem = {
  id: string;
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
  enabled: boolean;
  definition_ref: string;
  last_fired_at?: string;
  last_run_id?: string;
  next_run_at?: string;
  adapter_status?: TriggerAdapterStatus;
};

export type SkillUsageEntry = {
  stage_ids: string[];
  pipeline_ids: string[];
};

export type SkillUsageIndex = {
  usages: Record<string, SkillUsageEntry>;
};

export type CreateTriggerInput = {
  directory: string;
  id: string;
  pipeline: string;
  task?: string;
  kind: "manual" | "schedule" | "event";
  schedule?: TriggerSchedule;
  event?: TriggerEvent;
  enabled?: boolean;
};

export type CreateTriggerResult =
  | { ok: true; trigger: TriggerListItem }
  | { ok: false; status: number; error: string };
