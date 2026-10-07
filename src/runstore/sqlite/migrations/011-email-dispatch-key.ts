import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

export const MIGRATION_011 = {
  version: 11,
  name: "011_email_dispatch_key",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    const columns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    if (!columns.some(column => column.name === "dispatch_key")) db.exec("ALTER TABLE runs ADD COLUMN dispatch_key TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_key ON runs(dispatch_key)");
  },
};
