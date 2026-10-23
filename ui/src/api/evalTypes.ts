import type { ValidationFinding } from "./types";

export type EvalListStatus = "running" | "never_run" | "passing" | "saturated" | "regressed" | "failing";

export type EvalRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "budget_stopped";

export type EvalResultStatus =
  | "completed"
  | "stage_failed"
  | "needs_input"
  | "error"
  | "skipped_budget"
  | "cancelled";

export type EvalInterval = { low: number; high: number };

export type EvalTargetKind = "stage" | "agent";

export type EvalConversationMode = "script" | "simulated";
export type EvalConversationTools = "real" | "read_only" | "mocked";
export type EvalConversationApprovals = "deny" | "auto_approve_read" | "record_only";

export type EvalConversation = {
  mode?: EvalConversationMode;
  max_turns?: number;
  turn_timeout_ms?: number;
  tools?: EvalConversationTools;
  approvals?: EvalConversationApprovals;
  read_only_tools?: string[];
  allow_real_tools?: boolean;
};

export type EvalToolClass =
  | "read"
  | "write"
  | "shell"
  | "destructive"
  | "external"
  | "mcp_unknown"
  | "sub_agent"
  | "browser"
  | "operator_only";

export type EvalAgentTool = { id: string; risk: string; class: EvalToolClass };

/** The live agent behind an agent eval. */
export type EvalAgentInfo = {
  id: string;
  name: string;
  model: string | null;
  revision: number;
  enabled: boolean;
  archived: boolean;
  tools: EvalAgentTool[];
  ask_first: string[];
  issues: string[];
};

/** One row of the agent picker (`GET /api/evals/agent-targets`). */
export type EvalAgentTarget = {
  id: string;
  name: string;
  model: string | null;
  revision: number;
  enabled: boolean;
  tools: EvalAgentTool[];
  ask_first: string[];
  evals_count: number;
  issues: string[];
  unavailable_reason: "archived" | "invalid" | null;
};

export type EvalRunHeadline = {
  project_root?: string;
  eval_run_id: string;
  eval_id: string;
  run_number: number;
  status: EvalRunStatus;
  passed: boolean | null;
  pass_rate: number | null;
  pass_rate_ci: EvalInterval | null;
  results_executed: number;
  cost_total: number;
  finished_at: string | null;
  fingerprint: string;
  label: string | null;
};

export type EvalActiveRun = {
  run_number: number;
  eval_run_id: string;
  status: "queued" | "running";
  results_done: number;
  results_total: number;
};

export type EvalListItem = {
  project_root?: string;
  id: string;
  name: string;
  description: string | null;
  type: string;
  path: string;
  target:
    | {
        kind: "stage";
        pipeline_path?: string;
        stage_id?: string;
        file?: string;
        label: string;
      }
    | {
        kind: "agent";
        agent_id: string;
        agent_name: string;
        model: string | null;
        revision: number | null;
        label: string;
      };
  /** Agent evals only. */
  conversation?: { mode: EvalConversationMode; max_turns: number; tools: EvalConversationTools; approvals: EvalConversationApprovals };
  dataset_path: string;
  dataset_cases: number;
  repeats: number;
  grader_count: number;
  rubric_count: number;
  valid: boolean;
  finding_count: number;
  status: EvalListStatus;
  active_run?: EvalActiveRun | null;
  last_run: EvalRunHeadline | null;
  last_run_delta_pts: number | null;
  trend: Array<{ run_number: number; passed: boolean; pass_rate: number | null; pass_threshold: number }>;
};

export type EvalRegressionBanner = {
  eval_id: string;
  previous_pass_rate: number | null;
  last_pass_rate: number | null;
  criteria_dropped: number;
  last_run_number: number;
  previous_run_number: number;
};

export type EvalListResponse = {
  items: EvalListItem[];
  next_cursor: string | null;
  banner: EvalRegressionBanner | null;
  footer: { evals: number; datasets: number; cost_last_7_days: number };
  write_roots?: EvalWriteRoots;
};

export type EvalWriteRoots = { project_root: string; evals_dir: string; datasets_dir: string };

export type EvalListQuery = {
  project_root?: string;
  target_pipeline?: string;
  target_stage?: string;
  target_file?: string;
  target_kind?: EvalTargetKind;
  /** Only the evals that test this agent. */
  agent?: string;
  q?: string;
};

export type EvalDefinition = {
  version: 1;
  id: string;
  name?: string;
  description?: string;
  type?: "capability" | "regression";
  target: { kind: "stage"; pipeline?: string; stage?: string; file?: string } | { kind: "agent"; agent: string };
  dataset: string;
  task?: { goal?: string; context?: string; constraints?: string };
  defaults?: {
    repeats?: number;
    judge?: string;
    user_model?: string;
    pass_threshold?: number;
    max_cost_usd?: number;
    concurrency?: number;
    model?: string;
  };
  /** Agent evals only. */
  conversation?: EvalConversation;
  graders: Array<Record<string, unknown> & { id: string; type: string }>;
  budget?: { latency_ms?: number; cost_usd?: number };
};

export type EvalDetail = {
  id: string;
  path: string;
  file_hash: string;
  definition: EvalDefinition | null;
  yaml: string;
  findings: ValidationFinding[];
  runs_count: number;
  active_run?: EvalActiveRun | null;
  last_run: EvalRunHeadline | null;
  target_model?: string | null;
  judge_default?: string | null;
  /** Agent evals only: the live agent, or null when it cannot be read. */
  agent?: EvalAgentInfo | null;
};

export type EvalValidateInput = {
  project_root?: string;
  definition?: EvalDefinition;
  yaml?: string;
  path?: string;
  dataset_cases?: EvalCaseInput[];
};

export type EvalValidateResult = {
  findings: ValidationFinding[];
  derived_yaml: string;
  definition: EvalDefinition | null;
};

export type EvalCaseInput = {
  id?: string;
  input: Record<string, unknown>;
  title?: string;
  expected?: unknown;
  tags?: string[];
  goal?: string;
  metadata?: Record<string, unknown>;
};

export type EvalGrade = {
  grader_id: string;
  grader_type: string;
  status: "graded" | "error";
  passed: boolean | null;
  score: number | null;
  raw_value: number | null;
  reason: string | null;
  details: unknown;
  error_code: string | null;
  judge_model: string | null;
  judge_cost_usd: number | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

export type EvalResultDetail = {
  case_id: string;
  repeat_index: number;
  status: EvalResultStatus;
  error_code: string | null;
  error_message: string | null;
  stage_run_id: string | null;
  /** Agent evals: the eval session id; null for stage results and for Try. */
  subject_ref?: string | null;
  turns?: number | null;
  tool_call_count?: number | null;
  /** Agent runs only; `session_id` equals `subject_ref`. */
  agent?: { id: string; session_id: string | null } | null;
  output: unknown;
  latency_ms: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  score: number | null;
  passed: boolean;
  grades: EvalGrade[];
  budget_warnings: string[];
  review: { label: "pass" | "fail" | null; note: string | null } | null;
  tags: string[];
  /** Failure sorting: the suggestion for this repeat, when one exists. */
  suggestion?: EvalSuggestion | null;
};

export type EvalTryResult = {
  result: EvalResultDetail;
  stage_run_id: string | null;
  cost_usd: number;
};

export type EvalTryInput = {
  project_root?: string;
  eval_id?: string;
  definition?: EvalDefinition;
  case_id?: string;
  case?: EvalCaseInput;
  dataset_cases?: EvalCaseInput[];
  /** Agent evals with `conversation.tools: real`. */
  allow_real_tools?: boolean;
};

export type EvalDraftEstimateInput = {
  project_root?: string;
  definition: EvalDefinition;
  dataset_cases?: EvalCaseInput[];
  repeats?: number;
  user_model?: string;
  tools?: EvalSaferTools;
  approvals?: EvalSaferApprovals;
};

export type EvalSaferTools = "read_only" | "mocked";
export type EvalSaferApprovals = "deny" | "record_only";

export type EvalRunOptions = {
  repeats?: number;
  judge?: string;
  model?: string;
  max_cost_usd?: number;
  case_ids?: string[];
  tags?: string[];
  only_failed_from?: string;
  /** Agent evals: overrides the model that plays the user. */
  user_model?: string;
  /** Agent evals, safer-only: a run may lower the tool policy, never raise it. */
  tools?: EvalSaferTools;
  /** Agent evals, safer-only. */
  approvals?: EvalSaferApprovals;
};

export type EvalStartRunInput = EvalRunOptions & {
  project_root?: string;
  label?: string;
  started_via?: "console" | "cli" | "mcp";
  /** The per-run consent to `conversation.tools: real`; without it a real-tools run fails EVAL_REAL_TOOLS_NOT_CONFIRMED. */
  allow_real_tools?: boolean;
};

export type EvalStartRunResult = { eval_run_id: string; status: "queued"; run_number: number };

export type EvalRunEstimate = {
  results_total: number;
  stage_calls: number;
  judge_calls: number;
  estimate_usd: number | null;
  estimate_seconds: number | null;
  judge_included: boolean;
  based_on_run_number: number | null;
  /** Agent evals only. */
  target_kind?: "agent";
  simulator_calls?: number;
  estimate_basis?: "previous_run" | "assumptions" | null;
};

export type EvalGraderStat = {
  grader_id: string;
  type: string;
  hash: string;
  graded: number;
  passed: number;
  pass_rate: number | null;
  mean_raw: number | null;
  min_raw: number | null;
  max_raw: number | null;
  errors: number;
  delta: number | null;
  grader_changed: boolean;
};

export type EvalStats = {
  cases_counted: number;
  results_executed: number;
  results_passed: number;
  errored: number;
  pass_rate: number | null;
  pass_rate_ci: EvalInterval | null;
  mean_score: number | null;
  score_spread: number | null;
  reliability: number | null;
  pass_any: number | null;
  flaky_cases: string[];
  latency_p50: number | null;
  latency_p95: number | null;
  latency_max: number | null;
  cost_stage: number;
  cost_judge: number;
  cost_total: number;
  cost_per_result: number | null;
  /** Agent runs only; null when no data. */
  mean_turns?: number | null;
  mean_tool_calls?: number | null;
  tokens_in: number;
  tokens_out: number;
  judge_tokens_in: number;
  judge_tokens_out: number;
  by_grader: EvalGraderStat[];
  score_histogram: { bins: number[]; threshold: number };
  failure_types: { by_tag: Record<string, number>; untagged: number };
  failing_cases: Array<{ case_id: string; pass_rate: number; mean_score: number | null; passes: boolean[] }>;
};

export type EvalRunDetail = {
  eval_run_id: string;
  run_number: number;
  eval_id: string;
  eval_path: string;
  status: EvalRunStatus;
  status_reason: string | null;
  passed: boolean | null;
  label: string | null;
  started_via: "console" | "cli" | "mcp";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: {
    results_done: number;
    results_total: number;
    cost_usd: number;
    max_cost_usd: number;
    cases_total: number;
  };
  config: Record<string, any>;
  fingerprint: string;
  components: Record<string, unknown>;
  stats: EvalStats | null;
  current: {
    stage_version_hash: string | null;
    dataset_hash: string | null;
    grader_hashes: Record<string, string> | null;
    /** Agent runs: what the agent is now. */
    agent_revision?: number | null;
    agent_definition_hash?: string | null;
  };
  live?: Array<{ case_id: string; repeat_index: number; phase: "stage_running" | "agent_running" | "grading" | "done" }>;
};

export type EvalRunListQuery = {
  eval_id?: string;
  status?: EvalRunStatus;
  stage_run_id?: string;
  /** The eval session or stage run id; returns the run that owns a result for it. */
  subject_ref?: string;
  project_root?: string;
  limit?: number;
  cursor?: string;
};

export type EvalRunListItem = EvalRunHeadline & {
  created_at?: string;
  started_at?: string | null;
  results_total?: number; result?: { case_id: string; repeat_index: number } };

export type EvalResultRow = {
  case_id: string;
  position: number;
  title: string | null;
  tags: string[];
  repeats: Array<{ repeat_index: number; status: EvalResultStatus; passed: boolean; score: number | null }>;
  pass_fraction: number | null;
  mean_score: number | null;
  failed_graders: string[];
  latency_ms_p50: number | null;
  cost_usd: number;
  failure_tags: string[];
  /** Agent runs: mean per case. */
  turns?: number | null;
  tool_calls?: number | null;
};

export type EvalResultsQuery = {
  status?: "passed" | "failed" | "errored" | "flaky";
  grader?: string;
  q?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
};

export type EvalResultsPage = {
  items: EvalResultRow[];
  next_cursor: string | null;
  counts: { all: number; passed: number; failed: number; errored: number; flaky: number };
};

export type EvalCaseResults = {
  case: EvalCaseInput & { id: string; position?: number };
  repeats: EvalResultDetail[];
};

export type EvalReviewInput = { label?: "pass" | "fail"; note?: string | null; tags?: string[] };

export type EvalReview = { label: "pass" | "fail" | null; note: string | null; tags: string[] };

export type EvalCompareCase = {
  case_id: string;
  change: "improved" | "regressed" | "same";
  p_a: number;
  p_b: number;
  d: number;
  passes_a: boolean[];
  passes_b: boolean[];
  mean_score_a: number | null;
  mean_score_b: number | null;
  graders_changed: string[];
};

export type EvalNumberDelta = { a: number | null; b: number | null; delta: number | null };

export type EvalCompareResult = {
  shared_cases: number;
  cases_a: number;
  cases_b: number;
  mean_difference: number | null;
  ci: EvalInterval | null;
  verdict: "improved" | "regressed" | "no_clear_difference" | "insufficient_data";
  cases: EvalCompareCase[];
  graders: Array<{
    grader_id: string;
    status: "compared" | "changed" | "added" | "removed";
    pass_rate_a: number | null;
    pass_rate_b: number | null;
    delta: number | null;
  }>;
  deltas: {
    cost_per_result: EvalNumberDelta;
    latency_p50: EvalNumberDelta;
    latency_p95: EvalNumberDelta;
    flaky_cases: EvalNumberDelta;
    mean_score: EvalNumberDelta;
    /** Both runs are agent runs. */
    mean_turns?: EvalNumberDelta;
    mean_tool_calls?: EvalNumberDelta;
  };
  stage_diff: {
    changed_keys: string[];
    system_prompt_diff: Array<{ op: "same" | "add" | "remove"; text: string }> | null;
  } | null;
  /** Agent runs. */
  agent_diff?: {
    changed_keys: string[];
    instructions_diff: Array<{ op: "same" | "add" | "remove"; text: string }> | null;
    revision: { a: number | null; b: number | null };
  } | null;
  components: Array<{ key: string; status: "same" | "changed"; a: unknown; b: unknown }>;
  same_config: boolean;
  warnings: Array<{
    code: "dataset_differs" | "graders_differ" | "engine_differs" | "few_shared_cases";
    shared_cases?: number;
    cases_a?: number;
    cases_b?: number;
  }>;
  sd_d: number | null;
  cases_needed_5pts: number | null;
  stats_a: EvalStats;
  stats_b: EvalStats;
};

export type EvalEngineStatus = {
  installed: boolean;
  version: string | null;
  pinned: string;
  node: string;
  node_ok: boolean;
  install_command: string;
};

export type EvalDatasetFormat = "jsonl" | "json" | "csv";

export type EvalDatasetListItem = {
  project_root?: string;
  id: string;
  path: string;
  format: EvalDatasetFormat | null;
  cases: number;
  hash: string;
  editable: boolean;
  used_by: string[];
  findings_count: number;
};

export type EvalDatasetCase = EvalCaseInput & {
  id: string;
  input_check: { valid: boolean; message?: string } | null;
};

export type EvalDatasetDetail = {
  id: string;
  path: string;
  format: EvalDatasetFormat | null;
  hash: string;
  editable: boolean;
  cases_total: number;
  invalid_total: number;
  tagged_total: number;
  matched_total: number;
  tags: Record<string, number>;
  input_fields: Array<{ name: string; required: boolean; type?: string }>;
  cases: EvalDatasetCase[];
  findings: ValidationFinding[];
  used_by: string[];
};

export type EvalDatasetQuery = {
  project_root?: string;
  eval_id?: string;
  offset?: number;
  limit?: number;
  tag?: string;
  q?: string;
  filter?: "all" | "invalid" | "tagged";
};

export type EvalDatasetTarget = { pipeline_path?: string; stage_id?: string; file?: string; agent_id?: string };

export type EvalUploadMapping = Record<string, { column: string; split?: string } | null>;

export type EvalDatasetPreviewInput = {
  project_root?: string;
  format: EvalDatasetFormat;
  content: string;
  delimiter?: string;
  mapping?: EvalUploadMapping;
  target?: EvalDatasetTarget;
  /** Agent targets: the eval whose `conversation.mode` the rows are checked against (default simulated). */
  eval_id?: string;
};

export type EvalDatasetPreview = {
  columns?: string[];
  rows: Array<{ index: number; case: EvalCaseInput & { id: string }; status: "ready" | "skipped"; reason?: string }>;
  findings: ValidationFinding[];
  counts: { ready: number; skipped: number };
};

export type EvalCreateDatasetInput =
  | { project_root?: string; name: string; cases: EvalCaseInput[]; directory?: string }
  | { project_root?: string; name: string; source: "sample"; target: EvalDatasetTarget; directory?: string }
  | {
      project_root?: string;
      name: string;
      source: "runs";
      target: EvalDatasetTarget;
      run_ids: string[];
      directory?: string;
    }
  | {
      project_root?: string;
      name: string;
      source: "sessions";
      target: { agent_id: string };
      session_ids: string[];
      directory?: string;
    }
  | {
      project_root?: string;
      dataset_id: string;
      mode: "append" | "replace";
      cases: EvalCaseInput[];
      base_hash: string;
    };

export type EvalCaseOp =
  | { op: "add"; case: EvalCaseInput }
  | { op: "update"; id: string; case: EvalCaseInput }
  | { op: "delete"; id: string }
  | { op: "set_tags"; id: string; tags: string[] };

export type EvalDatasetCandidate = { run_id: string; finished_at: string; preview: string };

/** `GET /api/datasets/candidates?agent=<id>`: finished, non-eval sessions of that agent. */
export type EvalSessionCandidate = {
  session_id: string;
  updated_at: string;
  preview: string;
  turns: number;
  tools: string[];
};

export type EvalBucket = "agent_wrong" | "grader_wrong" | "case_wrong" | "unclear";
export type EvalSuggestionStatus = "pending" | "accepted" | "dismissed";
export type EvalClassifierName = "jev" | "judge";

export type EvalSuggestion = {
  id: string;
  case_id: string;
  repeat_index: number;
  source: EvalClassifierName;
  bucket: EvalBucket;
  failure_type: string | null;
  confidence: number;
  bucket_probabilities: Record<EvalBucket, number>;
  grader_false_alarms: Array<{ grader_id: string; probability: number }>;
  model: string;
  prompt_version: string;
  status: EvalSuggestionStatus;
  created_at: string;
};

export type EvalSuggestionSummary = {
  by_bucket: Record<EvalBucket, number>;
  by_type: Record<string, number>;
  pending: number;
  accepted: number;
  dismissed: number;
  low_confidence: number;
};

export type EvalSuggestionsResponse = { items: EvalSuggestion[]; summary: EvalSuggestionSummary };

export type EvalSortInput = { classifier?: "auto" | EvalClassifierName; only_unsorted?: boolean; limit?: number };

export type EvalSortResult = {
  batch_id: string;
  classifier: EvalClassifierName;
  model: string;
  sorted: number;
  skipped: number;
  failed: number;
  triage_cost_usd: number;
  suggestions: EvalSuggestion[];
};

export type EvalAcceptInput = { ids?: string[]; min_confidence?: number; bucket?: EvalBucket };

export type EvalClassifierAvailability = { available: boolean; model: string | null; reason?: string };

export type EvalClassifierStatus = {
  classifiers: Record<EvalClassifierName, EvalClassifierAvailability>;
  default: EvalClassifierName | null;
};
