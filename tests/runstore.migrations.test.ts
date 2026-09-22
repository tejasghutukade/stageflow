import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRunStore,
  createRunStoreWithConnection,
} from "../src/runstore/createStore.js";
import { SqliteRunStore } from "../src/runstore/sqlite/SqliteRunStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { A2aStore } from "../src/a2a/store.js";
import {
  applyPendingMigrations,
  CURRENT_SCHEMA_VERSION,
} from "../src/runstore/sqlite/migrations/index.js";

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const PRE_VERSION_TABLES = [
  "feedback_loops",
  "feedback_replay_stage_passes",
  "feedback_replays",
  "fork_generations",
  "run_submissions",
  "runs",
  "stage_events",
  "stage_executions",
  "stages",
  "verification_check_results",
] as const;

function tableInfoByName(db: Database.Database): Map<string, TableInfoRow[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[];
  const out = new Map<string, TableInfoRow[]>();
  for (const { name } of tables) {
    out.set(
      name,
      db.prepare(`PRAGMA table_info(${name})`).all() as TableInfoRow[],
    );
  }
  return out;
}

function columnSignature(rows: TableInfoRow[]): string {
  return [...rows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (r) =>
        `${r.name}:${r.type}:${r.notnull}:${r.dflt_value ?? ""}:${r.pk}`,
    )
    .join("|");
}

describe("sqlite store migrations", () => {
  it("fresh store has user_version 1 and one ledger row", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-fresh-"));
    createRunStore({ rootDir: root, kind: "sqlite" });
    const dbPath = path.join(storeRootFor(root), "state.db");
    const db = new Database(dbPath);
    const userVersion = db.pragma("user_version", { simple: true });
    expect(userVersion).toBe(1);
    const ledger = db
      .prepare(
        `SELECT version, name, applied_at, min_stageflow_version FROM schema_migrations ORDER BY version`,
      )
      .all() as Array<{
      version: number;
      name: string;
      applied_at: string;
      min_stageflow_version: string;
    }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(ledger[0]?.min_stageflow_version).toBe(PACKAGE_VERSION);
    db.close();
  });

  it("stamps a legacy-shaped database without losing rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-legacy-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
INSERT INTO runs (run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at)
  VALUES ('legacy-run', 'docs-only', 'legacy', 'id: legacy\ngoal: g\n', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO stage_executions (run_id, stage_id, attempt, status)
  VALUES ('legacy-run', 'verify', 1, 'failed');
INSERT INTO verification_check_results
  (run_id, stage_id, attempt, check_id, check_type, status)
  VALUES ('legacy-run', 'verify', 1, 'unit-tests', 'command', 'failed');
`);
    legacy.close();

    const freshRoot = await mkdtemp(path.join(tmpdir(), "sf-migrate-fresh-ref-"));
    createRunStore({ rootDir: freshRoot, kind: "sqlite" });
    const freshDb = new Database(path.join(storeRootFor(freshRoot), "state.db"));
    const freshInfo = tableInfoByName(freshDb);

    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    await expect(
      store.getStageExecution("legacy-run", "verify", 1),
    ).resolves.toMatchObject({ verification_outcome: "failed" });

    const stampedDb = new Database(dbPath);
    expect(stampedDb.pragma("user_version", { simple: true })).toBe(1);
    const stampedInfo = tableInfoByName(stampedDb);
    for (const table of PRE_VERSION_TABLES) {
      expect(columnSignature(stampedInfo.get(table) ?? [])).toBe(
        columnSignature(freshInfo.get(table) ?? []),
      );
    }
    stampedDb.close();
    freshDb.close();
  });

  it("rolls back a failed migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-fail-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
    const tablesBefore = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const userVersionBefore = db.pragma("user_version", { simple: true }) as number;
    db.close();

    const brokenDb = new Database(dbPath);
    expect(() =>
      applyPendingMigrations(brokenDb, {
        migrations: [
          {
            version: 1,
            name: "broken",
            minStageflowVersion: PACKAGE_VERSION,
            up: () => {
              brokenDb.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)`);
              throw new Error("mid-migration");
            },
          },
        ],
      }),
    ).toThrow("mid-migration");
    brokenDb.close();

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(userVersionBefore);
    const tablesAfter = (
      after
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tablesAfter).toEqual(tablesBefore);
    const ledgerCount = (
      after
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
        )
        .get() as { name: string } | undefined
    );
    expect(ledgerCount).toBeUndefined();
    after.close();
  });

  it("enables foreign keys on the shared run-store connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-fk-"));
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      kind: "sqlite",
    });
    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    new A2aStore(root, connection);
    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    expect(() =>
      connection
        .prepare(
          `INSERT INTO run_submissions (submission_key, request_hash, run_id) VALUES (?, ?, ?)`,
        )
        .run("bad-key", "hash", "missing-run"),
    ).toThrow();
  });

  it("does not re-run verification outcome backfill after stamp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-backfill-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_outcome TEXT NOT NULL DEFAULT 'not_run',
  PRIMARY KEY (run_id, stage_id, attempt)
);
CREATE TABLE verification_check_results (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (run_id, stage_id, attempt, check_id)
);
INSERT INTO runs VALUES ('r1', 'p', NULL, 'yaml', 'running', 't', 't');
INSERT INTO stage_executions VALUES ('r1', 's', 1, 'failed', 'not_run');
INSERT INTO verification_check_results VALUES ('r1', 's', 1, 'c', 'command', 'failed');
`);
    legacy.close();

    createRunStore({ rootDir: root, kind: "sqlite" });
    const probe = new Database(dbPath);
    probe
      .prepare(
        `UPDATE stage_executions SET verification_outcome = 'not_run' WHERE run_id = 'r1'`,
      )
      .run();
    probe.close();

    createRunStore({ rootDir: root, kind: "sqlite" });
    const after = new Database(dbPath);
    const row = after
      .prepare(
        `SELECT verification_outcome FROM stage_executions WHERE run_id = 'r1' AND stage_id = 's'`,
      )
      .get() as { verification_outcome: string };
    after.close();
    expect(row.verification_outcome).toBe("not_run");
  });
});
