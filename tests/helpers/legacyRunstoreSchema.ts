import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { storeRootFor } from "../../src/runstore/paths.js";

export const LEGACY_RUNS_DDL = `
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function legacyStagesAndEventsDdl(opts: { foreignKeys: boolean }): string {
  const fk = (suffix: string) => (opts.foreignKeys ? suffix : "");
  return `
CREATE TABLE stages (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT,
  summary TEXT,
  envelope_json TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, stage_id)${fk(",\n  FOREIGN KEY (run_id) REFERENCES runs(run_id)")}
);
CREATE TABLE stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT${fk(",\n  FOREIGN KEY (run_id) REFERENCES runs(run_id)")}
);
`;
}

export const LEGACY_EXECUTIONS_DDL = `
CREATE TABLE stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  envelope_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt)
);
CREATE TABLE verification_check_results (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  evidence_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt, check_id)
);
`;

export async function seedLegacyDb(root: string, ddl: string): Promise<string> {
  const storeRoot = storeRootFor(root);
  await mkdir(storeRoot, { recursive: true });
  const dbPath = path.join(storeRoot, "state.db");
  const db = new Database(dbPath);
  db.exec(ddl);
  db.close();
  return dbPath;
}

export function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  } finally {
    db.close();
  }
}
