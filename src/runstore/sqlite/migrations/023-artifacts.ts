import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Artifact index. Additive: dropping these tables leaves runs and envelopes working. */
export const MIGRATION_023 = {
  version: 23,
  name: "023_artifacts",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE artifacts (
  key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_pipeline TEXT,
  owner_stage TEXT,
  owner_agent TEXT,
  project_root_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  source_run_id TEXT,
  source_stage_id TEXT,
  source_attempt INTEGER,
  source_session_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE artifact_versions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  content_hash TEXT,
  manifest_json TEXT,
  library TEXT,
  library_version TEXT,
  source_run_id TEXT,
  source_stage_id TEXT,
  source_attempt INTEGER,
  source_session_id TEXT,
  created_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  relative_path TEXT,
  PRIMARY KEY (key, version),
  FOREIGN KEY (key) REFERENCES artifacts(key) ON DELETE CASCADE
);

CREATE INDEX artifacts_project_updated ON artifacts (project_root_id, updated_at);
CREATE INDEX artifacts_owner_id ON artifacts (owner_kind, owner_pipeline, owner_stage, id);
`);
  },
};
