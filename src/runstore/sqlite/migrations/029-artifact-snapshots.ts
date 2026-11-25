import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Live artifact snapshots and the additive function invocation kind `artifact`. */
export const MIGRATION_029 = {
  version: 29,
  name: "029_artifact_snapshots",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
ALTER TABLE artifacts ADD COLUMN live_status TEXT;
ALTER TABLE artifacts ADD COLUMN last_refreshed_at TEXT;
ALTER TABLE artifacts ADD COLUMN last_error_code TEXT;

CREATE TABLE IF NOT EXISTS artifact_snapshots (
  artifact_key TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  value_json TEXT,
  fetched_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  PRIMARY KEY (artifact_key, binding_id, args_hash)
);

CREATE TABLE function_invocations_v29 (
  id TEXT NOT NULL PRIMARY KEY,
  project_key TEXT NOT NULL,
  function_id TEXT NOT NULL,
  revision INTEGER,
  source_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'verification', 'route', 'tool', 'artifact')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'uncertain')),
  duration_ms INTEGER NOT NULL,
  code TEXT,
  attachment_id TEXT,
  run_id TEXT,
  stage_id TEXT,
  attempt INTEGER,
  session_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO function_invocations_v29 (
  id, project_key, function_id, revision, source_hash, kind, status, duration_ms, code,
  attachment_id, run_id, stage_id, attempt, session_id, created_at
)
SELECT
  id, project_key, function_id, revision, source_hash, kind, status, duration_ms, code,
  attachment_id, run_id, stage_id, attempt, session_id, created_at
FROM function_invocations;

DROP TABLE function_invocations;
ALTER TABLE function_invocations_v29 RENAME TO function_invocations;

CREATE INDEX function_invocations_function
  ON function_invocations (project_key, function_id, created_at);
`);
  },
};
