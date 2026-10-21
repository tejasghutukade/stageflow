import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

const RUN_COLUMNS = [
  { name: "pipeline_source", type: "TEXT" },
  { name: "pipeline_body", type: "TEXT" },
  { name: "caller_id", type: "TEXT" },
  { name: "run_manifest", type: "TEXT" },
  { name: "skip_gates", type: "INTEGER" },
] as const;

function addColumn(
  db: Database.Database,
  name: (typeof RUN_COLUMNS)[number]["name"],
  type: (typeof RUN_COLUMNS)[number]["type"],
): void {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

export const MIGRATION_006 = {
  version: 6,
  name: "006_pipeline_body_and_caller",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    for (const col of RUN_COLUMNS) {
      addColumn(db, col.name, col.type);
    }
  },
};
