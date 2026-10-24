import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Eval runs, their cases, results, grades and the author's reviews, plus `runs.origin` so stage runs
 * started by an eval can be hidden from normal run views. `eval_run_counters` keeps `run_number`
 * from being reused after an eval run is deleted.
 */
export const MIGRATION_015 = {
  version: 15,
  name: "015_evals",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
ALTER TABLE runs ADD COLUMN origin TEXT;
CREATE INDEX runs_origin ON runs (origin);

CREATE TABLE eval_runs (
  eval_run_id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  eval_path TEXT NOT NULL,
  eval_hash TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('stage','agent')),
  target_ref_json TEXT NOT NULL,
  target_version_hash TEXT NOT NULL,
  dataset_path TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  config_components_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','budget_stopped')),
  status_reason TEXT,
  passed INTEGER,
  repeats INTEGER NOT NULL,
  pass_threshold REAL NOT NULL,
  max_cost_usd REAL NOT NULL,
  cases_total INTEGER NOT NULL,
  results_total INTEGER NOT NULL,
  results_done INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  engine_name TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  stageflow_version TEXT NOT NULL,
  label TEXT,
  started_via TEXT NOT NULL CHECK (started_via IN ('console','cli','mcp')),
  caller_id TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX eval_runs_number ON eval_runs (project_root, eval_id, run_number);
CREATE INDEX eval_runs_eval ON eval_runs (project_root, eval_id, created_at DESC);
CREATE INDEX eval_runs_status ON eval_runs (status);

CREATE TABLE eval_run_counters (
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  last_number INTEGER NOT NULL,
  PRIMARY KEY (project_root, eval_id)
);

CREATE TABLE eval_cases (
  eval_run_id TEXT NOT NULL REFERENCES eval_runs (eval_run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  case_json TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id)
);

CREATE TABLE eval_results (
  eval_run_id TEXT NOT NULL REFERENCES eval_runs (eval_run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','stage_failed','needs_input','error','skipped_budget','cancelled')),
  error_code TEXT,
  error_message TEXT,
  stage_run_id TEXT,
  output_json TEXT,
  latency_ms INTEGER,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  score REAL,
  passed INTEGER NOT NULL DEFAULT 0,
  has_grader_errors INTEGER NOT NULL DEFAULT 0,
  budget_warnings_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (eval_run_id, case_id, repeat_index),
  FOREIGN KEY (eval_run_id, case_id) REFERENCES eval_cases (eval_run_id, case_id) ON DELETE CASCADE
);
CREATE INDEX eval_results_stage_run ON eval_results (stage_run_id);

CREATE TABLE eval_grades (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  grader_id TEXT NOT NULL,
  grader_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('graded','error')),
  passed INTEGER,
  score REAL,
  raw_value REAL,
  reason TEXT,
  details_json TEXT,
  error_code TEXT,
  judge_model TEXT,
  judge_cost_usd REAL,
  judge_tokens_in INTEGER,
  judge_tokens_out INTEGER,
  PRIMARY KEY (eval_run_id, case_id, repeat_index, grader_id),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);

CREATE TABLE eval_grader_versions (
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  grader_id TEXT NOT NULL,
  grader_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_root, eval_id, grader_id, grader_hash)
);

CREATE TABLE eval_failure_types (
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_root, eval_id, name COLLATE NOCASE)
);

CREATE TABLE eval_result_reviews (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('pass','fail')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, repeat_index),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);

CREATE TABLE eval_result_tags (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, repeat_index, tag COLLATE NOCASE),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);
`);
  },
};
