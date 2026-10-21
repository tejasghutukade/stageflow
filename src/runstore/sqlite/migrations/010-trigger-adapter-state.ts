import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

export const MIGRATION_010 = {
  version: 10,
  name: "010_trigger_adapter_state",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS trigger_adapter_state (
  trigger_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, key)
);
`);
  },
};
