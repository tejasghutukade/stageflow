import type { ValidationFinding } from "./types";

export type EvalListStatus = "never_run" | "passing" | "saturated" | "regressed" | "failing";

export type EvalRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "budget_stopped";

export type EvalResultStatus =
  | "completed"
  | "stage_failed"
  | "needs_input"
  | "error"
  | "skipped_budget"
  | "cancelled";

export type EvalInterval = { low: number; high: number };

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

export type EvalListItem = {
  project_root?: string;
  id: string;
  name: string;
  description: string | null;
  type: string;
  path: string;
  target: {
    kind: "stage";
    pipeline_path?: string;
    stage_id?: string;
    file?: string;
    label: string;
  };
  dataset_path: string;
  dataset_cases: number;
  repeats: number;
  grader_count: number;
  rubric_count: number;
  valid: boolean;
  finding_count: number;
  status: EvalListStatus;
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
  q?: string;
};

export type EvalDefinition = {
  version: 1;
  id: string;
  name?: string;
  description?: string;
  type?: "capability" | "regression";
  target: { kind: "stage"; pipeline?: string; stage?: string; file?: string };
  dataset: string;
  task?: { goal?: string; context?: string; constraints?: string };
  defaults?: {
    repeats?: number;
    judge?: string;
    pass_threshold?: number;
    max_cost_usd?: number;
    concurrency?: number;
    model?: string;
  };
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
  last_run: EvalRunHeadline | null;
  target_model?: string | null;
  judge_default?: string | null;
};

export type EvalValidateInput = {
  project_root?: string;
  definition?: EvalDefinition;
  yaml?: string;
  path?: string;
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
};

export type EvalRunOptions = {
  repeats?: number;
  judge?: string;
  model?: string;
  max_cost_usd?: number;
  case_ids?: string[];
  tags?: string[];
  only_failed_from?: string;
};

export type EvalStartRunInput = EvalRunOptions & {
  project_root?: string;
  label?: string;
  started_via?: "console" | "cli" | "mcp";
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
  };
  live?: Array<{ case_id: string; repeat_index: number; phase: "stage_running" | "grading" | "done" }>;
};

export type EvalRunListQuery = {
  eval_id?: string;
  status?: EvalRunStatus;
  stage_run_id?: string;
  project_root?: string;
  limit?: number;
  cursor?: string;
};

export type EvalRunListItem = EvalRunHeadline & { result?: { case_id: string; repeat_index: number } };

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
  };
  stage_diff: {
    changed_keys: string[];
    system_prompt_diff: Array<{ op: "same" | "add" | "remove"; text: string }> | null;
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

export type EvalDatasetTarget = { pipeline_path?: string; stage_id?: string; file?: string };

export type EvalUploadMapping = Record<string, { column: string; split?: string } | null>;

export type EvalDatasetPreviewInput = {
  project_root?: string;
  format: EvalDatasetFormat;
  content: string;
  delimiter?: string;
  mapping?: EvalUploadMapping;
  target?: EvalDatasetTarget;
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
