import type Database from "better-sqlite3";
import path from "node:path";
import { PACKAGE_VERSION } from "../../../package-meta.js";
import { normalizeProjectRoot } from "../../normalizeCatalogPath.js";

export const MIGRATION_007 = {
  version: 7,
  name: "007_projects_registry",
  minStageflowVersion: PACKAGE_VERSION,
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  project_root TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
`);
    const runCols = (
      db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
    ).map((c) => c.name);
    if (!runCols.includes("project_root")) return;

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO projects (project_root, created_at) VALUES (?, ?)`,
    );
    const rows = db
      .prepare(
        `SELECT DISTINCT project_root FROM runs
         WHERE project_root IS NOT NULL AND project_root != ''`,
      )
      .all() as { project_root: string }[];
    for (const row of rows) {
      const raw = row.project_root;
      if (!path.isAbsolute(raw)) continue;
      insert.run(normalizeProjectRoot(raw), now);
    }
  },
};
