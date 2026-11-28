import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Session-scoped artifacts created from chat. Existing rows stay project-scoped. */
export const MIGRATION_032 = {
  version: 32,
  name: "032_artifact_scope",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
ALTER TABLE artifacts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
CREATE INDEX artifacts_scope_session ON artifacts (source_session_id) WHERE scope = 'session';
`);
  },
};
