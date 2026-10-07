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
import { MIGRATION_001 } from "../src/runstore/sqlite/migrations/001-baseline.js";
import { MIGRATION_002 } from "../src/runstore/sqlite/migrations/002-repository-binding.js";
import { MIGRATION_003 } from "../src/runstore/sqlite/migrations/003-run-lifecycle.js";
import { MIGRATION_004 } from "../src/runstore/sqlite/migrations/004-auto-resume-count.js";
import { MIGRATION_005 } from "../src/runstore/sqlite/migrations/005-config-origins.js";
import { MIGRATION_006 } from "../src/runstore/sqlite/migrations/006-pipeline-body-and-caller.js";
import { MIGRATION_007 } from "../src/runstore/sqlite/migrations/007-projects-registry.js";
import { MIGRATION_008 } from "../src/runstore/sqlite/migrations/008-triggers-table.js";
import { MIGRATION_009 } from "../src/runstore/sqlite/migrations/009-trigger-next-run.js";
import {
  columnNames,
  legacyStagesAndEventsDdl,
  LEGACY_EXECUTIONS_DDL,
  LEGACY_RUNS_DDL,
  seedLegacyDb,
} from "./helpers/legacyRunstoreSchema.js";

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const BINDING_COLUMNS = [
  "repository",
  "ref",
  "resolved_sha",
  "run_branch",
  "git_author_name",
  "git_author_email",
] as const;

const LIFECYCLE_COLUMNS = [
  "cancel_reason",
  "finished_at",
  "slimmed_at",
  "disk_bytes",
  "disk_measured_at",
] as const;

const PIPELINE_BODY_COLUMNS = [
  "pipeline_source",
  "pipeline_body",
  "caller_id",
  "run_manifest",
  "skip_gates",
] as const;

async function seedSchemaV1WithoutBinding(root: string): Promise<string> {
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
  applyPendingMigrations(db, { migrations: [MIGRATION_001] });
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const name of BINDING_COLUMNS) {
    expect(cols.has(name)).toBe(false);
  }
  db.close();
  return dbPath;
}

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

function expectNullPipelineBodyColumns(db: Database.Database): void {
  expect(
    db
      .prepare(
        `SELECT pipeline_source, pipeline_body, caller_id, run_manifest, skip_gates
         FROM runs WHERE run_id = 'keep-me'`,
      )
      .get(),
  ).toEqual({
    pipeline_source: null,
    pipeline_body: null,
    caller_id: null,
    run_manifest: null,
    skip_gates: null,
  });
}

describe("sqlite store migrations", () => {
  it("fresh store has user_version matching CURRENT_SCHEMA_VERSION and ledger rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-fresh-"));
    createRunStore({ rootDir: root, kind: "sqlite" });
    const dbPath = path.join(storeRootFor(root), "state.db");
    const db = new Database(dbPath);
    const userVersion = db.pragma("user_version", { simple: true });
    expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
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
    expect(ledger).toHaveLength(CURRENT_SCHEMA_VERSION);
    expect(ledger.map((r) => r.version)).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1),
    );
    for (const row of ledger) {
      expect(row.name).toMatch(/^\d{3}_[a-z0-9_]+$/);
      expect(row.applied_at).toBeTruthy();
    }
    for (const row of ledger.filter((r) => r.version >= 5)) {
      expect(row.min_stageflow_version).toBe(PACKAGE_VERSION);
    }
    const cols = (
      db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
    ).map((c) => c.name);
    for (const name of [
      "repository",
      "ref",
      "resolved_sha",
      "run_branch",
      "git_author_name",
      "git_author_email",
      "config_origins_json",
      ...LIFECYCLE_COLUMNS,
      ...PIPELINE_BODY_COLUMNS,
    ]) {
      expect(cols).toContain(name);
    }
    const projects = (
      db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(projects).toEqual(
      expect.arrayContaining(["project_root", "created_at"]),
    );
    const triggers = (
      db.prepare(`PRAGMA table_info(triggers)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(triggers).toEqual(
      expect.arrayContaining([
        "id",
        "definition_ref",
        "enabled",
        "last_fired_at",
        "last_run_id",
        "next_run_at",
        "created_at",
        "updated_at",
      ]),
    );
    const adapterState = (
      db.prepare(`PRAGMA table_info(trigger_adapter_state)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(adapterState).toEqual(
      expect.arrayContaining(["trigger_id", "key", "value", "updated_at"]),
    );
    const skipGates = (
      db.prepare(`PRAGMA table_info(runs)`).all() as TableInfoRow[]
    ).find((c) => c.name === "skip_gates");
    expect(skipGates?.type.toUpperCase()).toBe("INTEGER");
    const diskBytes = (
      db.prepare(`PRAGMA table_info(runs)`).all() as TableInfoRow[]
    ).find((c) => c.name === "disk_bytes");
    expect(diskBytes?.type.toUpperCase()).toBe("INTEGER");
    const autoResume = (
      db.prepare(`PRAGMA table_info(stage_executions)`).all() as TableInfoRow[]
    ).find((c) => c.name === "auto_resume_count");
    expect(autoResume?.type.toUpperCase()).toBe("INTEGER");
    expect(autoResume?.notnull).toBe(1);
    expect(autoResume?.dflt_value).toBe("0");
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
    expect(stampedDb.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const stampedInfo = tableInfoByName(stampedDb);
    for (const table of PRE_VERSION_TABLES) {
      expect(columnSignature(stampedInfo.get(table) ?? [])).toBe(
        columnSignature(freshInfo.get(table) ?? []),
      );
    }
    stampedDb.close();
    freshDb.close();
  });

  it.each([
    {
      name: "stage_events.attempt",
      foreignKeys: true,
      table: "stage_events",
      columns: ["attempt"],
    },
    {
      name: "runs.checkout_root and CI identity columns",
      foreignKeys: true,
      table: "runs",
      columns: ["checkout_root", "git_sha", "ci_pr_url", "ci_job_url"],
    },
    {
      name: "verification_check_results table",
      foreignKeys: false,
      table: "verification_check_results",
      columns: ["check_id", "evidence_json"],
    },
  ])("adds $name via ALTER on a legacy DB", async ({ foreignKeys, table, columns }) => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-legacy-alter-"));
    const dbPath = await seedLegacyDb(
      root,
      LEGACY_RUNS_DDL + legacyStagesAndEventsDdl({ foreignKeys }),
    );
    expect(columnNames(dbPath, table)).not.toEqual(expect.arrayContaining(columns));

    createRunStore({ rootDir: root, kind: "sqlite" });

    expect(columnNames(dbPath, table)).toEqual(expect.arrayContaining(columns));
  });

  it("round-trips checkout_root and CI identity on a migrated legacy DB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-legacy-roundtrip-"));
    await seedLegacyDb(
      root,
      LEGACY_RUNS_DDL + legacyStagesAndEventsDdl({ foreignKeys: true }),
    );
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
      checkoutRoot: checkout,
      gitSha: "cafe1234",
      ciPrUrl: "https://github.com/acme/repo/pull/7",
      ciJobUrl: "https://github.com/acme/repo/actions/runs/11",
    });
    const meta = await store.readRunMeta(run.runId);
    expect(meta.checkout_root).toBe(checkout);
    expect(meta.git_sha).toBe("cafe1234");
    expect(meta.ci_pr_url).toBe("https://github.com/acme/repo/pull/7");
    expect(meta.ci_job_url).toBe("https://github.com/acme/repo/actions/runs/11");
  });

  it("adds and backfills verification dispositions on existing attempts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sqlite-verification-outcome-"));
    const dbPath = await seedLegacyDb(
      root,
      LEGACY_RUNS_DDL +
        LEGACY_EXECUTIONS_DDL +
        `
INSERT INTO stage_executions (run_id, stage_id, attempt, status)
  VALUES ('legacy-run', 'verify', 1, 'failed');
INSERT INTO verification_check_results
  (run_id, stage_id, attempt, check_id, check_type, status)
  VALUES ('legacy-run', 'verify', 1, 'unit-tests', 'command', 'failed');
`,
    );

    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    await expect(
      store.getStageExecution("legacy-run", "verify", 1),
    ).resolves.toMatchObject({ verification_outcome: "failed" });
    expect(columnNames(dbPath, "stage_executions")).toContain("verification_outcome");
  });

  it("migrates a pre-locator runs table idempotently across store opens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-locators-migrate-"));
    const dbPath = path.join(root, "state.db");
    const db = new Database(dbPath);
    db.exec(
      LEGACY_RUNS_DDL +
        `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
VALUES ('legacy-1', 'docs-only', 'id: t\ngoal: g\n', 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');`,
    );
    db.close();

    for (let open = 0; open < 2; open += 1) {
      const store = new SqliteRunStore(root);
      await store.ready();
      const meta = await store.readRunMeta("legacy-1");
      expect(meta.pipeline_path).toBeUndefined();
    }

    expect(columnNames(dbPath, "runs")).toEqual(
      expect.arrayContaining([
        "pipeline_path",
        "task_path",
        "project_root",
        "pipeline_body",
      ]),
    );
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

  it("migrates a v1 database to current and adds binding plus lifecycle plus auto_resume plus config_origins columns", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-v1-v4-"));
    const dbPath = await seedSchemaV1WithoutBinding(root);

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const db = new Database(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const ledgerCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_migrations`).get() as {
        n: number;
      }
    ).n;
    expect(ledgerCount).toBe(CURRENT_SCHEMA_VERSION);
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const name of BINDING_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    for (const name of LIFECYCLE_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    expect(cols.has("config_origins_json")).toBe(true);
    for (const name of PIPELINE_BODY_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    const execCols = new Set(
      (
        db.prepare(`PRAGMA table_info(stage_executions)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    expect(execCols.has("auto_resume_count")).toBe(true);
    const row = db
      .prepare(`SELECT run_id FROM runs LIMIT 1`)
      .get() as { run_id: string } | undefined;
    expect(row).toBeUndefined();
    db.close();
  });

  it("migrates a v3 database to current without losing rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-v3-v4-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  min_stageflow_version TEXT NOT NULL
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  task_id TEXT,
  task_yaml TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  repository TEXT,
  ref TEXT,
  resolved_sha TEXT,
  run_branch TEXT,
  git_author_name TEXT,
  git_author_email TEXT,
  cancel_reason TEXT,
  finished_at TEXT,
  slimmed_at TEXT,
  disk_bytes INTEGER,
  disk_measured_at TEXT
);
CREATE TABLE stage_executions (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  verification_outcome TEXT NOT NULL DEFAULT 'not_run',
  started_at TEXT,
  finished_at TEXT,
  envelope_json TEXT,
  cost_usd REAL,
  usage_json TEXT,
  PRIMARY KEY (run_id, stage_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
`);
    const appliedAt = "2026-01-01T00:00:00.000Z";
    for (const row of [
      { version: 1, name: "001_baseline" },
      { version: 2, name: "002_repository_binding" },
      { version: 3, name: "003_run_lifecycle" },
    ]) {
      db.prepare(
        `INSERT INTO schema_migrations (version, name, applied_at, min_stageflow_version)
         VALUES (@version, @name, @applied_at, @min_stageflow_version)`,
      ).run({
        ...row,
        applied_at: appliedAt,
        min_stageflow_version: PACKAGE_VERSION,
      });
    }
    db.pragma("user_version = 3");
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at)
       VALUES ('keep-me', 'docs-only', 't', 'id: t\ngoal: g\n', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO stage_executions (run_id, stage_id, attempt, status, verification_outcome)
       VALUES ('keep-me', 'build', 1, 'interrupted', 'not_run')`,
    ).run();
    const beforeCols = new Set(
      (
        db.prepare(`PRAGMA table_info(stage_executions)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    expect(beforeCols.has("auto_resume_count")).toBe(false);
    db.close();

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const kept = after
      .prepare(
        `SELECT run_id, status, auto_resume_count FROM stage_executions WHERE run_id = 'keep-me'`,
      )
      .get() as {
      run_id: string;
      status: string;
      auto_resume_count: number;
    };
    expect(kept).toEqual({
      run_id: "keep-me",
      status: "interrupted",
      auto_resume_count: 0,
    });
    const cols = new Set(
      (after.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has("config_origins_json")).toBe(true);
    for (const name of PIPELINE_BODY_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    expectNullPipelineBodyColumns(after);
    after.close();
  });

  it("migrates a v2 database to current without losing rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-v2-current-"));
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
  updated_at TEXT NOT NULL,
  repository TEXT,
  ref TEXT,
  resolved_sha TEXT,
  run_branch TEXT,
  git_author_name TEXT,
  git_author_email TEXT
);
`);
    applyPendingMigrations(db, {
      migrations: [MIGRATION_001, MIGRATION_002],
    });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_id, task_yaml, status, created_at, updated_at)
       VALUES ('keep-me', 'docs-only', 't', 'id: t\ngoal: g\n', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    for (const name of LIFECYCLE_COLUMNS) {
      const cols = new Set(
        (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      expect(cols.has(name)).toBe(false);
    }
    db.close();

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const kept = after
      .prepare(`SELECT run_id, status FROM runs WHERE run_id = 'keep-me'`)
      .get() as { run_id: string; status: string };
    expect(kept).toEqual({ run_id: "keep-me", status: "running" });
    const cols = new Set(
      (
        after.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
      ).map((c) => c.name),
    );
    for (const name of LIFECYCLE_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    for (const name of PIPELINE_BODY_COLUMNS) {
      expect(cols.has(name)).toBe(true);
    }
    const execCols = new Set(
      (
        after.prepare(`PRAGMA table_info(stage_executions)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    expect(execCols.has("auto_resume_count")).toBe(true);
    expectNullPipelineBodyColumns(after);
    after.close();
  });

  it("assert opener on a v1 database requires host migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-migrate-v1-assert-"));
    const dbPath = await seedSchemaV1WithoutBinding(root);

    expect(() =>
      createRunStore({ rootDir: root, kind: "sqlite", openerMode: "assert" }),
    ).toThrow(
      expect.objectContaining({ code: "store_schema_migration_required" }),
    );

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(1);
    const cols = new Set(
      (
        after.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
      ).map((c) => c.name),
    );
    for (const name of BINDING_COLUMNS) {
      expect(cols.has(name)).toBe(false);
    }
    after.close();
  });

  const PRE_MIGRATIONS = [
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    MIGRATION_004,
    MIGRATION_005,
    MIGRATION_006,
    MIGRATION_007,
    MIGRATION_008,
    MIGRATION_009,
  ];

  async function seedAtVersion(
    version: number,
    prefix: string,
  ): Promise<{ root: string; dbPath: string; db: Database.Database }> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const db = new Database(dbPath);
    applyPendingMigrations(db, { migrations: PRE_MIGRATIONS.slice(0, version) });
    expect(db.pragma("user_version", { simple: true })).toBe(version);
    return { root, dbPath, db };
  }

  function tableExists(db: Database.Database, name: string): boolean {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) !== undefined
    );
  }

  it("migrates a v7 database to current and adds the triggers table", async () => {
    const { root, dbPath, db } = await seedAtVersion(7, "sf-migrate-v7-v8-");
    expect(tableExists(db, "triggers")).toBe(false);
    db.close();

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const cols = (
      after.prepare(`PRAGMA table_info(triggers)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "definition_ref",
        "enabled",
        "last_fired_at",
        "last_run_id",
        "created_at",
        "updated_at",
      ]),
    );
    expect(after.prepare(`SELECT * FROM triggers`).all()).toEqual([]);
    after.close();
  });

  it("migrates a v8 database to current and adds the next_run_at column", async () => {
    const { root, dbPath, db } = await seedAtVersion(8, "sf-migrate-v8-v9-");
    db.prepare(
      `INSERT INTO triggers (id, definition_ref, enabled, created_at, updated_at)
       VALUES ('t1', 'triggers/t1.trigger.yaml', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const before = (
      db.prepare(`PRAGMA table_info(triggers)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(before).not.toContain("next_run_at");
    db.close();

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const cols = after.prepare(`PRAGMA table_info(triggers)`).all() as TableInfoRow[];
    const nextRunAt = cols.find((c) => c.name === "next_run_at");
    expect(nextRunAt).toBeDefined();
    expect(nextRunAt?.notnull).toBe(0);
    const row = after
      .prepare(`SELECT next_run_at FROM triggers WHERE id = 't1'`)
      .get() as { next_run_at: string | null };
    expect(row.next_run_at).toBeNull();
    after.close();
  });

  it("migrates a v9 database to current and adds the trigger_adapter_state table", async () => {
    const { root, dbPath, db } = await seedAtVersion(9, "sf-migrate-v9-v10-");
    expect(tableExists(db, "trigger_adapter_state")).toBe(false);
    db.close();

    createRunStore({ rootDir: root, kind: "sqlite", openerMode: "migrate" });

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const info = after
      .prepare(`PRAGMA table_info(trigger_adapter_state)`)
      .all() as TableInfoRow[];
    expect(info.map((c) => c.name)).toEqual(
      expect.arrayContaining(["trigger_id", "key", "value", "updated_at"]),
    );
    expect(
      info
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["key", "trigger_id"]);
    expect(after.prepare(`SELECT * FROM trigger_adapter_state`).all()).toEqual([]);
    after.close();
  });
});
