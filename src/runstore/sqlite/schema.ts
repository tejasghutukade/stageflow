import type Database from "better-sqlite3";

export const A2A_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS a2a_contexts (
  context_id TEXT PRIMARY KEY,
  caller_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  task_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  publication_revision TEXT NOT NULL,
  submission_key TEXT NOT NULL UNIQUE,
  run_id TEXT,
  state TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS a2a_tasks_context ON a2a_tasks(context_id);
CREATE INDEX IF NOT EXISTS a2a_tasks_caller ON a2a_tasks(caller_id);

CREATE TABLE IF NOT EXISTS a2a_messages (
  caller_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (caller_id, message_id)
);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT,
  size INTEGER NOT NULL,
  content_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS a2a_artifacts_task ON a2a_artifacts(task_id);
`;

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  min_stageflow_version TEXT NOT NULL
);
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  checkout_root TEXT,
  pipeline_dag_json TEXT,
  git_sha TEXT,
  ci_pr_url TEXT,
  ci_job_url TEXT,
  pipeline_path TEXT,
  task_path TEXT,
  project_root TEXT,
  repository TEXT,
  ref TEXT,
  resolved_sha TEXT,
  run_branch TEXT,
  git_author_name TEXT,
  git_author_email TEXT,
  cancel_reason TEXT,
  finished_at TEXT,
  slimmed_at TEXT,
  disk_bytes INTEGER,
  disk_measured_at TEXT,
  config_origins_json TEXT
);

CREATE TABLE IF NOT EXISTS run_submissions (
  submission_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS stages (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  envelope_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, stage_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_status_created
  ON runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_pipeline_created
  ON runs (pipeline_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stage_events_run_stage_at
  ON stage_events (run_id, stage_id, at);

CREATE TABLE IF NOT EXISTS stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_outcome TEXT NOT NULL DEFAULT 'not_run',
  started_at TEXT,
  finished_at TEXT,
  envelope_json TEXT,
  cost_usd REAL,
  usage_json TEXT,
  auto_resume_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stage_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_stage_executions_run_stage
  ON stage_executions (run_id, stage_id, attempt);

CREATE TABLE IF NOT EXISTS verification_check_results (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  evidence_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt, check_id),
  FOREIGN KEY (run_id, stage_id, attempt)
    REFERENCES stage_executions(run_id, stage_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_verification_check_results_execution
  ON verification_check_results (run_id, stage_id, attempt, check_id);

CREATE TABLE IF NOT EXISTS feedback_loops (
  run_id TEXT NOT NULL,
  loop_id TEXT NOT NULL,
  source_stage_id TEXT NOT NULL,
  source_attempt INTEGER NOT NULL,
  policy_json TEXT NOT NULL,
  state TEXT NOT NULL,
  current_replay_id TEXT,
  current_replay_number INTEGER,
  deferred_send_back_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, loop_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_loops_run_state
  ON feedback_loops (run_id, state, created_at);

CREATE TABLE IF NOT EXISTS feedback_replays (
  run_id TEXT NOT NULL,
  replay_id TEXT NOT NULL,
  loop_id TEXT NOT NULL,
  source_stage_id TEXT NOT NULL,
  source_attempt INTEGER NOT NULL,
  target_stage_id TEXT NOT NULL,
  replay_number INTEGER NOT NULL,
  max_replays INTEGER NOT NULL,
  replay_session TEXT NOT NULL,
  route_stage_ids_json TEXT NOT NULL,
  feedback_envelope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, replay_id),
  FOREIGN KEY (run_id, loop_id) REFERENCES feedback_loops(run_id, loop_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_replays_loop_number
  ON feedback_replays (run_id, loop_id, replay_number);
CREATE INDEX IF NOT EXISTS idx_feedback_replays_run_loop
  ON feedback_replays (run_id, loop_id, created_at);

CREATE TABLE IF NOT EXISTS feedback_replay_stage_passes (
  run_id TEXT NOT NULL,
  replay_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_attempt INTEGER NOT NULL,
  session_origin_attempt INTEGER,
  session_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  emitted_envelope_json TEXT,
  PRIMARY KEY (run_id, replay_id, stage_id),
  FOREIGN KEY (run_id, replay_id) REFERENCES feedback_replays(run_id, replay_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_replay_stage_passes_replay
  ON feedback_replay_stage_passes (run_id, replay_id, stage_id);

CREATE TABLE IF NOT EXISTS fork_generations (
  run_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  replay_id TEXT,
  fork_parent_stage_id TEXT NOT NULL,
  generation_number INTEGER NOT NULL,
  clone_stage_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, generation_id),
  FOREIGN KEY (run_id, replay_id) REFERENCES feedback_replays(run_id, replay_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fork_generations_parent_number
  ON fork_generations (run_id, fork_parent_stage_id, generation_number);
CREATE INDEX IF NOT EXISTS idx_fork_generations_run_replay
  ON fork_generations (run_id, replay_id, created_at);
`;

export function ensureCheckoutRootColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "checkout_root")) {
    db.exec(`ALTER TABLE runs ADD COLUMN checkout_root TEXT`);
  }
}

export function ensureCiIdentityColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  for (const name of ["git_sha", "ci_pr_url", "ci_job_url"] as const) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
    }
  }
}

export function ensurePipelineDagColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "pipeline_dag_json")) {
    db.exec(`ALTER TABLE runs ADD COLUMN pipeline_dag_json TEXT`);
  }
}

export function ensureRunLocatorColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  for (const name of ["pipeline_path", "task_path", "project_root"] as const) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
    }
  }
}

export function ensureStageExecutionsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_outcome TEXT NOT NULL DEFAULT 'not_run',
  started_at TEXT,
  finished_at TEXT,
  envelope_json TEXT,
  auto_resume_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stage_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX IF NOT EXISTS idx_stage_executions_run_stage
  ON stage_executions (run_id, stage_id, attempt);
`);
}

export function ensureStageExecutionAutoResumeCountColumn(
  db: Database.Database,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(stage_executions)`)
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "auto_resume_count")) {
    db.exec(
      `ALTER TABLE stage_executions ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
}

export function ensureStageExecutionVerificationOutcomeColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(stage_executions)`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "verification_outcome")) {
    db.exec(
      `ALTER TABLE stage_executions ADD COLUMN verification_outcome TEXT NOT NULL DEFAULT 'not_run'`,
    );
  }
}

export function ensureStageExecutionCostColumns(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(stage_executions)`)
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("cost_usd")) {
    db.exec(`ALTER TABLE stage_executions ADD COLUMN cost_usd REAL`);
  }
  if (!names.has("usage_json")) {
    db.exec(`ALTER TABLE stage_executions ADD COLUMN usage_json TEXT`);
  }
}

export function backfillVerificationOutcomes(db: Database.Database): void {
  db.exec(`
UPDATE stage_executions
SET verification_outcome = CASE
  WHEN status = 'succeeded'
    AND EXISTS (
      SELECT 1 FROM verification_check_results AS check_result
      WHERE check_result.run_id = stage_executions.run_id
        AND check_result.stage_id = stage_executions.stage_id
        AND check_result.attempt = stage_executions.attempt
    )
    AND NOT EXISTS (
      SELECT 1 FROM verification_check_results AS check_result
      WHERE check_result.run_id = stage_executions.run_id
        AND check_result.stage_id = stage_executions.stage_id
        AND check_result.attempt = stage_executions.attempt
        AND check_result.status != 'passed'
    )
    THEN 'passed'
  WHEN status = 'failed'
    AND EXISTS (
      SELECT 1 FROM verification_check_results AS check_result
      WHERE check_result.run_id = stage_executions.run_id
        AND check_result.stage_id = stage_executions.stage_id
        AND check_result.attempt = stage_executions.attempt
    )
    THEN 'failed'
  ELSE verification_outcome
END
WHERE verification_outcome = 'not_run';
`);
}

export function ensureStageEventsAttemptColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(stage_events)`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "attempt")) {
    db.exec(`ALTER TABLE stage_events ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`);
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_stage_events_run_stage_attempt_at
  ON stage_events (run_id, stage_id, attempt, at);
`);
  }
}

export function ensureVerificationCheckResultsTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS verification_check_results (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  evidence_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt, check_id),
  FOREIGN KEY (run_id, stage_id, attempt)
    REFERENCES stage_executions(run_id, stage_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_verification_check_results_execution
  ON verification_check_results (run_id, stage_id, attempt, check_id);
`);
}

export function ensureFeedbackReplayStagePassEnvelopeColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(feedback_replay_stage_passes)`)
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "emitted_envelope_json")) {
    db.exec(
      `ALTER TABLE feedback_replay_stage_passes ADD COLUMN emitted_envelope_json TEXT`,
    );
  }
}

export function ensureFeedbackReplayStagePassSessionOriginColumn(
  db: Database.Database,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(feedback_replay_stage_passes)`)
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "session_origin_attempt")) {
    db.exec(
      `ALTER TABLE feedback_replay_stage_passes ADD COLUMN session_origin_attempt INTEGER`,
    );
  }
}

export function ensureFeedbackLoopDeferredSendBackColumn(db: Database.Database): void {
  const cols = db
    .prepare(`PRAGMA table_info(feedback_loops)`)
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === "deferred_send_back_json")) {
    db.exec(
      `ALTER TABLE feedback_loops ADD COLUMN deferred_send_back_json TEXT`,
    );
  }
}

export function ensureConfigOriginsColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "config_origins_json")) {
    db.exec(`ALTER TABLE runs ADD COLUMN config_origins_json TEXT`);
  }
}

export function applyBaselineSchema(db: Database.Database): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);
  db.exec(SCHEMA_SQL);
  ensureCheckoutRootColumn(db);
  ensureCiIdentityColumns(db);
  ensurePipelineDagColumn(db);
  ensureRunLocatorColumns(db);
  ensureStageExecutionsTable(db);
  ensureStageExecutionVerificationOutcomeColumn(db);
  ensureStageExecutionCostColumns(db);
  ensureStageExecutionAutoResumeCountColumn(db);
  ensureStageEventsAttemptColumn(db);
  ensureVerificationCheckResultsTable(db);
  ensureFeedbackReplayStagePassEnvelopeColumn(db);
  ensureFeedbackReplayStagePassSessionOriginColumn(db);
  ensureFeedbackLoopDeferredSendBackColumn(db);
  ensureConfigOriginsColumn(db);
  db.exec(A2A_SCHEMA_SQL);
  backfillVerificationOutcomes(db);
}
