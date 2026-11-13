import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * One row per function invocation. Diagnostic text is a code, never a body, credential, or request URL.
 */
export const MIGRATION_021 = {
  version: 21,
  name: "021_function_invocations",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE function_invocations (
  id TEXT NOT NULL PRIMARY KEY,
  project_key TEXT NOT NULL,
  function_id TEXT NOT NULL,
  revision INTEGER,
  source_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'verification', 'route', 'tool')),
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

CREATE INDEX function_invocations_function
  ON function_invocations (project_key, function_id, created_at);
`);
  },
};
