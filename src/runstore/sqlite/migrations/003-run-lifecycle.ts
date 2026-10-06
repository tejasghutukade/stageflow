import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

const LIFECYCLE_COLUMNS = [
  { name: "cancel_reason", type: "TEXT" },
  { name: "finished_at", type: "TEXT" },
  { name: "slimmed_at", type: "TEXT" },
  { name: "disk_bytes", type: "INTEGER" },
  { name: "disk_measured_at", type: "TEXT" },
] as const;

function addColumn(
  db: Database.Database,
  name: (typeof LIFECYCLE_COLUMNS)[number]["name"],
  type: (typeof LIFECYCLE_COLUMNS)[number]["type"],
): void {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_003 = {
  version: 3,
  name: "003_run_lifecycle",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    for (const col of LIFECYCLE_COLUMNS) {
      addColumn(db, col.name, col.type);
    }
  },
};
