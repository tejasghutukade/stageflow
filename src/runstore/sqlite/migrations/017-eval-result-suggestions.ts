import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Suggested bucket and failure type per failed eval result, produced on request by a classifier
 * (`jev` or `judge`). A suggestion becomes a tag only when the author accepts it. Additive.
 */
export const MIGRATION_017 = {
  version: 17,
  name: "017_eval_result_suggestions",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE eval_result_suggestions (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('jev','judge')),
  bucket TEXT NOT NULL CHECK (bucket IN ('agent_wrong','grader_wrong','case_wrong','unclear')),
  failure_type TEXT,
  confidence REAL NOT NULL,
  probabilities_json TEXT NOT NULL,
  grader_false_alarms_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','dismissed')),
  batch_id TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  state_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (eval_run_id, case_id, repeat_index, source),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);
CREATE INDEX eval_result_suggestions_run ON eval_result_suggestions (eval_run_id, status);
`);
  },
};
