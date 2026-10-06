import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

function addNextRunAtColumn(db: Database.Database): void {
  try {
    db.exec(`ALTER TABLE triggers ADD COLUMN next_run_at TEXT`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_009 = {
  version: 9,
  name: "009_trigger_next_run",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    addNextRunAtColumn(db);
  },
};
