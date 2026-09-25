import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, openSync, writeSync, closeSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { resolveStoreRoot, storeRootFor } from "../src/runstore/paths.js";
import {
  applyStorePragmas,
  assertStoreQuickCheck,
  maybeCheckpointResidualWal,
  readSqliteSynchronous,
} from "../src/runstore/sqlite/applyStorePragmas.js";
import { StoreOpenError } from "../src/runstore/sqlite/storeOpenError.js";
import { bootstrapStageflowHost } from "../src/server/bootstrap.js";
import { resolveAgentPort } from "../src/agent/resolveAgentPort.js";
import { withIsolatedHome } from "./helpers/projectContext.js";
import { globalStageflowHome } from "../src/project/globalHome.js";

describe("applyStorePragmas", () => {
  it("sets synchronous FULL and wal_autocheckpoint by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-pragma-"));
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    expect(connection.pragma("synchronous", { simple: true })).toBe(2);
    expect(connection.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
    await store.close();
  });

  it("honours STAGEFLOW_SQLITE_SYNCHRONOUS=NORMAL on every open", async () => {
    const prev = process.env.STAGEFLOW_SQLITE_SYNCHRONOUS;
    process.env.STAGEFLOW_SQLITE_SYNCHRONOUS = "NORMAL";
    try {
      expect(readSqliteSynchronous()).toBe("NORMAL");
      const root = await mkdtemp(path.join(tmpdir(), "sf-pragma-norm-"));
      const { store, connection } = createRunStoreWithConnection({
        rootDir: root,
        openerMode: "migrate",
      });
      expect(connection.pragma("synchronous", { simple: true })).toBe(1);
      await store.close();
    } finally {
      if (prev === undefined) delete process.env.STAGEFLOW_SQLITE_SYNCHRONOUS;
      else process.env.STAGEFLOW_SQLITE_SYNCHRONOUS = prev;
    }
  });

  it("applyStorePragmas covers a raw Database open path", () => {
    const db = new Database(":memory:");
    applyStorePragmas(db, {});
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    db.close();
  });
});

describe("assertStoreQuickCheck", () => {
  it("passes on a healthy store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-qc-ok-"));
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    expect(() => assertStoreQuickCheck(connection)).not.toThrow();
    await store.close();
  });

  it("refuses a corrupt database with store_integrity_failed naming restore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-qc-bad-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const dbPath = path.join(storeRoot, "state.db");
    const seed = new Database(dbPath);
    applyStorePragmas(seed);
    seed.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);",
    );
    seed.close();

    const fd = openSync(dbPath, "r+");
    try {
      writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 100);
    } finally {
      closeSync(fd);
    }

    const db = new Database(dbPath);
    expect(() => assertStoreQuickCheck(db)).toThrow(StoreOpenError);
    try {
      assertStoreQuickCheck(db);
    } catch (err) {
      expect(err).toBeInstanceOf(StoreOpenError);
      expect((err as StoreOpenError).code).toBe("store_integrity_failed");
      expect((err as StoreOpenError).message).toMatch(/sf restore/);
    }
    db.close();
  });
});

describe("Host boot integrity", () => {
  it("refuses bootstrap when quick_check fails", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      const { store } = createRunStoreWithConnection({
        rootDir: home,
        openerMode: "migrate",
      });
      const dbPath = path.join(resolveStoreRoot(home), "state.db");
      await store.close();

      const fd = openSync(dbPath, "r+");
      try {
        writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 100);
      } finally {
        closeSync(fd);
      }

      await expect(
        bootstrapStageflowHost({
          agent: resolveAgentPort(),
          skipHostConfig: true,
          cwd: home,
        }),
      ).rejects.toMatchObject({ code: "store_integrity_failed" });
    });
  });

  it("does not invoke integrity_check on the boot path", async () => {
    await withIsolatedHome(async () => {
      const home = globalStageflowHome();
      createRunStoreWithConnection({
        rootDir: home,
        openerMode: "migrate",
      });

      const boot = await bootstrapStageflowHost({
        agent: resolveAgentPort(),
        skipHostConfig: true,
        cwd: home,
      });
      const conn = (boot.store as { connection?: Database.Database } | undefined)
        ?.connection;
      expect(conn).toBeDefined();

      const seen: string[] = [];
      const original = conn!.pragma.bind(conn);
      conn!.pragma = ((source: string, options?: { simple?: boolean }) => {
        seen.push(String(source));
        return original(source, options);
      }) as typeof conn.pragma;

      assertStoreQuickCheck(conn!);
      expect(seen.some((s) => /integrity_check/i.test(s))).toBe(false);
      expect(seen.some((s) => /quick_check/i.test(s))).toBe(true);

      await boot.store!.close();
      boot.stopGcInterval();
    });
  });
});

describe("maybeCheckpointResidualWal", () => {
  it("checkpoints a large residual WAL when alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-wal-alone-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });

    connection.exec(
      "CREATE TABLE IF NOT EXISTS wal_pad (id INTEGER, blob BLOB)",
    );
    const blob = Buffer.alloc(256 * 1024, 0xab);
    const insert = connection.prepare(
      "INSERT INTO wal_pad (id, blob) VALUES (?, ?)",
    );
    for (let i = 0; i < 40; i += 1) {
      insert.run(i, blob);
    }

    const walPath = path.join(storeRoot, "state.db-wal");
    expect(existsSync(walPath)).toBe(true);
    const events: string[] = [];
    const result = maybeCheckpointResidualWal(storeRoot, connection, {
      thresholdBytes: 1024,
      log: (event) => events.push(event),
    });
    expect(result.attempted).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.busy).toBe(false);
    expect(events).toContain("store.crash_wal.checkpoint_done");

    await store.close();
  });

  it("logs incomplete when a concurrent holder keeps the WAL busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-wal-busy-"));
    const storeRoot = storeRootFor(root);
    await mkdir(storeRoot, { recursive: true });
    const first = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    first.connection.exec(
      "CREATE TABLE IF NOT EXISTS wal_pad (id INTEGER, blob BLOB)",
    );
    const blob = Buffer.alloc(256 * 1024, 0xcd);
    const insert = first.connection.prepare(
      "INSERT INTO wal_pad (id, blob) VALUES (?, ?)",
    );
    for (let i = 0; i < 40; i += 1) {
      insert.run(i, blob);
    }

    const originalPragma = first.connection.pragma.bind(first.connection);
    first.connection.pragma = ((source: string, options?: { simple?: boolean }) => {
      if (String(source).includes("wal_checkpoint")) {
        return [{ busy: 1, log: 10, checkpointed: 0 }];
      }
      return originalPragma(source, options);
    }) as typeof first.connection.pragma;

    const events: Array<{ event: string; fields?: Record<string, unknown> }> =
      [];
    const result = maybeCheckpointResidualWal(storeRoot, first.connection, {
      thresholdBytes: 1024,
      log: (event, fields) => events.push({ event, fields }),
    });

    expect(result.attempted).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.busy).toBe(true);
    expect(
      events.some((e) => e.event === "store.crash_wal.checkpoint_busy"),
    ).toBe(true);

    await first.store.close();
  });
});
