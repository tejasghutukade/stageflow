import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** One row per artifact id a stage attempt published, including an unchanged republish. */
export const MIGRATION_028 = {
  version: 28,
  name: "028_artifact_attempt_publishes",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS artifact_attempt_publishes (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  artifact_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  unchanged INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_id, attempt, artifact_key)
);
`);
  },
};
