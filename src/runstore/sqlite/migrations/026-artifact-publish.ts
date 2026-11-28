import type Database from "better-sqlite3";
import { PACKAGE_VERSION } from "../../../package-meta.js";

function addColumn(db: Database.Database, table: string, name: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((col) => col.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

export const MIGRATION_026 = {
  version: 26,
  name: "026_artifact_publish",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    addColumn(db, "artifacts", "source", "TEXT");
    addColumn(db, "artifact_versions", "pinned", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "artifact_versions", "relative_path", "TEXT");
    addColumn(db, "artifact_versions", "storage", "TEXT");
    db.exec(
      `CREATE INDEX IF NOT EXISTS artifact_versions_key_pinned ON artifact_versions (key, pinned)`,
    );
  },
};
