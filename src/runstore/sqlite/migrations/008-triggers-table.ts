import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

export const MIGRATION_008 = {
  version: 8,
  name: "008_triggers_table",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY NOT NULL,
  definition_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
  },
};
