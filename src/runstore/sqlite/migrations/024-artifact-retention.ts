import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

const COLUMNS = [
  { name: "status", ddl: "TEXT NOT NULL DEFAULT 'available'" },
  { name: "expired_at", ddl: "TEXT" },
  { name: "expired_reason", ddl: "TEXT" },
] as const;

function addColumn(db: Database.Database, name: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(artifacts)`).all() as { name: string }[];
  if (cols.some((col) => col.name === name)) return;
  db.exec(`ALTER TABLE artifacts ADD COLUMN ${name} ${ddl}`);
}

/** Expiry state for indexed artifacts. Additive: existing rows stay available. */
export const MIGRATION_024 = {
  version: 24,
  name: "024_artifact_retention",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    for (const col of COLUMNS) addColumn(db, col.name, col.ddl);
    db.exec(
      `CREATE INDEX IF NOT EXISTS artifacts_indexed_run_status ON artifacts (origin, status, source_run_id)`,
    );
  },
};
