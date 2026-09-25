import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { A2aStore } from "../src/a2a/store.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { resolveAgentPort } from "../src/agent/resolveAgentPort.js";
import {
  createRunStore,
  createRunStoreAfterHostEnsure,
  createRunStoreWithConnection,
  storeNeedsHostMigration,
} from "../src/runstore/createStore.js";
import { storeRootFor, resolveStoreRoot } from "../src/runstore/paths.js";
import {
  applyPendingMigrations,
  CURRENT_SCHEMA_VERSION,
} from "../src/runstore/sqlite/migrations/index.js";
import { StoreSchemaError } from "../src/runstore/sqlite/storeSchemaError.js";

function listUserTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("run store opener modes", () => {
  it("assert mode on user_version 0 refuses without DDL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-v0-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const seed = new Database(dbPath);
    seed.exec(`
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
    const tablesBefore = listUserTables(seed);
    expect(seed.pragma("user_version", { simple: true })).toBe(0);
    seed.close();

    expect(() => createRunStore({ rootDir: root, openerMode: "assert" })).toThrow(
      StoreSchemaError,
    );
    try {
      createRunStore({ rootDir: root, openerMode: "assert" });
    } catch (err) {
      expect(err).toBeInstanceOf(StoreSchemaError);
      expect((err as StoreSchemaError).code).toBe(
        "store_schema_migration_required",
      );
    }

    const after = new Database(dbPath);
    expect(after.pragma("user_version", { simple: true })).toBe(0);
    expect(listUserTables(after)).toEqual(tablesBefore);
    expect(listUserTables(after)).not.toContain("schema_migrations");
    after.close();
  });

  it("assert mode on a missing database file refuses without creating it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-missing-"));
    const dbPath = path.join(resolveStoreRoot(root), "state.db");
    expect(existsSync(dbPath)).toBe(false);

    expect(() => createRunStore({ rootDir: root, openerMode: "assert" })).toThrow(
      StoreSchemaError,
    );
    try {
      createRunStore({ rootDir: root, openerMode: "assert" });
    } catch (err) {
      expect((err as StoreSchemaError).code).toBe(
        "store_schema_migration_required",
      );
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("assert mode on user_version above binary maximum refuses without writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-new-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const futureVersion = CURRENT_SCHEMA_VERSION + 1;
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  min_stageflow_version TEXT NOT NULL
);
INSERT INTO schema_migrations (version, name, applied_at, min_stageflow_version)
  VALUES (${futureVersion}, 'future', '2099-01-01T00:00:00.000Z', '99.0.0');
`);
    db.pragma(`user_version = ${futureVersion}`);
    db.close();

    expect(() => createRunStore({ rootDir: root, openerMode: "assert" })).toThrow(
      StoreSchemaError,
    );
    try {
      createRunStore({ rootDir: root, openerMode: "assert" });
    } catch (err) {
      expect((err as StoreSchemaError).code).toBe("store_schema_too_new");
      const message = (err as Error).message;
      expect(message).toContain(String(futureVersion));
      expect(message).toContain(String(CURRENT_SCHEMA_VERSION));
      expect(message).toContain("99.0.0");
    }

    const probe = new Database(dbPath);
    expect(probe.pragma("user_version", { simple: true })).toBe(futureVersion);
    probe.close();
  });

  it("migrate mode on user_version above binary maximum refuses without writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-migrate-new-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const futureVersion = CURRENT_SCHEMA_VERSION + 1;
    const db = new Database(dbPath);
    db.pragma(`user_version = ${futureVersion}`);
    db.close();

    expect(() =>
      applyPendingMigrations(new Database(dbPath)),
    ).toThrow(StoreSchemaError);
    expect(new Database(dbPath).pragma("user_version", { simple: true })).toBe(
      futureVersion,
    );
  });

  it("read-only opener autostarts host stub then reads without applying DDL itself", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-ro-"));
    const prevHome = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = root;
    resetGlobalStageflowHomeForTests();
    try {
      expect(storeNeedsHostMigration(root)).toBe(true);

      let hostMigrated = false;
      const opened = await createRunStoreAfterHostEnsure(
        { rootDir: root },
        async () => {
          createRunStore({ rootDir: root, openerMode: "migrate" });
          hostMigrated = true;
          return { ok: true, alreadyRunning: false };
        },
      );
      expect(hostMigrated).toBe(true);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const run = await opened.store.createRun({
        pipelineId: "p",
        taskYaml: "id: t\ngoal: g\n",
      });
      expect(run.runId.length).toBeGreaterThan(0);

      const storeRoot = resolveStoreRoot(root);
      const tablesBefore = listUserTables(
        new Database(path.join(storeRoot, "state.db")),
      );

      const second = await createRunStoreAfterHostEnsure(
        { rootDir: root },
        async () => ({ ok: false, reason: "spawn_failed", message: "should not run" }),
      );
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const tablesAfter = listUserTables(
        new Database(path.join(storeRoot, "state.db")),
      );
      expect(tablesAfter).toEqual(tablesBefore);
    } finally {
      if (prevHome === undefined) {
        delete process.env.STAGEFLOW_HOME;
      } else {
        process.env.STAGEFLOW_HOME = prevHome;
      }
      resetGlobalStageflowHomeForTests();
    }
  });

  it("read-only opener returns host failure without applying DDL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-ro-fail-"));
    const dbPath = path.join(resolveStoreRoot(root), "state.db");
    expect(storeNeedsHostMigration(root)).toBe(true);

    const opened = await createRunStoreAfterHostEnsure(
      { rootDir: root },
      async () => ({
        ok: false,
        reason: "timed_out",
        message: "host never became healthy",
      }),
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.message).toContain("host never became healthy");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("host bootstrap shares one connection with A2A without A2A startup SQL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-opener-host-a2a-"));
    const prevHome = process.env.STAGEFLOW_HOME;
    process.env.STAGEFLOW_HOME = root;
    resetGlobalStageflowHomeForTests();
    try {
    const boot = await bootstrapStageflowHost({
      agent: resolveAgentPort({}),
      rootDir: root,
      cwd: root,
    });
    const dbPath = path.join(resolveStoreRoot(root), "state.db");
    const db = new Database(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(listUserTables(db)).toContain("a2a_contexts");
    db.close();

    const { connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "assert",
    });
    expect(() => new A2aStore(root, connection)).not.toThrow();
    boot.a2a?.close();
    } finally {
      if (prevHome === undefined) {
        delete process.env.STAGEFLOW_HOME;
      } else {
        process.env.STAGEFLOW_HOME = prevHome;
      }
      resetGlobalStageflowHomeForTests();
    }
  });
});
