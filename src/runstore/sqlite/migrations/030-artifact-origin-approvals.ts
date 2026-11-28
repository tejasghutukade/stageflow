import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

/** Operator approvals of a live HTML artifact's declared CSP origins. */
export const MIGRATION_030 = {
  version: 30,
  name: "030_artifact_origin_approvals",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE artifact_origin_approvals (
  artifact_key TEXT NOT NULL,
  origins_hash TEXT NOT NULL,
  origins_json TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (approved_by IN ('console', 'cli', 'api')),
  PRIMARY KEY (artifact_key, origins_hash)
);
`);
  },
};
