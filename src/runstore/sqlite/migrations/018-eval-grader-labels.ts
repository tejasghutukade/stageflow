import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Human verdicts per judged grader on one result, and stored judge calibrations.
 * Labels cascade with their result; calibrations belong to the eval, not a run. Additive.
 */
export const MIGRATION_018 = {
  version: 18,
  name: "018_eval_grader_labels",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE eval_grader_labels (
  eval_run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  grader_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('pass','fail')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, repeat_index, grader_id),
  FOREIGN KEY (eval_run_id, case_id, repeat_index) REFERENCES eval_results (eval_run_id, case_id, repeat_index) ON DELETE CASCADE
);

CREATE TABLE eval_calibrations (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  eval_id TEXT NOT NULL,
  grader_id TEXT NOT NULL,
  grader_hash TEXT NOT NULL,
  judge TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  split TEXT NOT NULL CHECK (split IN ('all','dev','held_out')),
  candidate INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL,
  disagreements_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX eval_calibrations_grader ON eval_calibrations (project_root, eval_id, grader_id, created_at);
`);
  },
};
