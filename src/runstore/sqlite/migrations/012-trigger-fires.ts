import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

export const MIGRATION_012 = {
  version: 12,
  name: "012_trigger_fires",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS trigger_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  fired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trigger_fires_trigger_fired
  ON trigger_fires (trigger_id, fired_at DESC);
`);
  },
};
