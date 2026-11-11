import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/**
 * Function definitions, append-only revisions, and the revision a run or session pinned.
 */
export const MIGRATION_020 = {
  version: 20,
  name: "020_functions",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE function_definitions (
  project_key TEXT NOT NULL,
  function_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT,
  issues_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, function_id)
);

CREATE TABLE function_revisions (
  project_key TEXT NOT NULL,
  function_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  yaml_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('console', 'file', 'api')),
  author TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_key, function_id, revision)
);

CREATE TABLE function_pins (
  project_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('run', 'session')),
  scope_id TEXT NOT NULL,
  function_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (project_key, scope, scope_id, function_id)
);
`);
  },
};
