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
  project_root TEXT
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
`;
