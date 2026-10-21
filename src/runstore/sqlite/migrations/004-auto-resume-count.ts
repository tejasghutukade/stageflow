import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

function addAutoResumeCountColumn(db: Database.Database): void {
  try {
    db.exec(
      `ALTER TABLE stage_executions ADD COLUMN auto_resume_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_004 = {
  version: 4,
  name: "004_auto_resume_count",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    addAutoResumeCountColumn(db);
  },
};
