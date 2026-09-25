import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createBackup } from "../src/runstore/backup.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import {
  applyPendingRestoreAtBoot,
  applyRestoreArchive,
  RestoreError,
  restoreAppliedPath,
  restoreFailedPath,
  stageRestoreForBoot,
  withExclusiveStoreLock,
} from "../src/runstore/restore.js";
import { CURRENT_SCHEMA_VERSION } from "../src/runstore/sqlite/migrations/index.js";

describe("restore", () => {
  it("refuses when host live probe returns up", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-live-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    const backup = await createBackup({
      store,
      homeDir: home,
      dbOnly: true,
      outPath: path.join(home, "backups", "x.db"),
    });
    await store.close();

    await expect(
      applyRestoreArchive({
        archivePath: backup.path,
        homeDir: home,
        probe: async () => "up",
      }),
    ).rejects.toMatchObject({ code: "restore_host_live" });
  });

  it("moves previous store aside and restores without sidecars", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-ok-"));
    const first = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    first.connection.exec(
      "CREATE TABLE IF NOT EXISTS restore_probe (id INTEGER PRIMARY KEY, v TEXT)",
    );
    first.connection
      .prepare("INSERT INTO restore_probe (id, v) VALUES (1, 'orig')")
      .run();
    const backup = await createBackup({
      store: first.store,
      homeDir: home,
      dbOnly: true,
      outPath: path.join(home, "backups", "snap.db"),
    });
    await first.store.close();

    writeFileSync(path.join(home, "state.db-wal"), "stale");
    writeFileSync(path.join(home, "state.db-shm"), "stale");

    const result = await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: home,
      probe: async () => "unreachable",
    });
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(existsSync(path.join(home, "state.db-wal"))).toBe(false);
    expect(existsSync(path.join(home, "state.db-shm"))).toBe(false);
    const aside = readdirSync(home).filter((n) =>
      n.startsWith("state.db.pre-restore-"),
    );
    expect(aside.length).toBeGreaterThan(0);

    const db = new Database(path.join(home, "state.db"), { readonly: true });
    const row = db
      .prepare("SELECT v FROM restore_probe WHERE id = 1")
      .get() as { v: string };
    expect(row.v).toBe("orig");
    db.close();
  });

  it("exclusive lock refuses when another connection is busy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-busy-"));
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    connection.prepare("BEGIN EXCLUSIVE").run();
    expect(() => withExclusiveStoreLock(home, () => undefined)).toThrow(
      RestoreError,
    );
    connection.exec("ROLLBACK");
    await store.close();
  });

  it("boot apply succeeds once; two failures write restore.failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-boot-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    const backup = await createBackup({
      store,
      homeDir: home,
      dbOnly: true,
      outPath: path.join(home, "backups", "boot.db"),
    });
    await store.close();

    await stageRestoreForBoot({ archivePath: backup.path, homeDir: home });
    const applied = await applyPendingRestoreAtBoot(home);
    expect(applied.status).toBe("applied");

    unlinkSync(restoreAppliedPath(home));
    mkdirSync(path.join(home, "restore-pending"), { recursive: true });
    writeFileSync(
      path.join(home, "restore-pending", "marker.json"),
      JSON.stringify({
        archive: "missing.db",
        attempts: 0,
        staged_at: new Date().toISOString(),
      }),
    );

    const fail1 = await applyPendingRestoreAtBoot(home);
    expect(fail1.status).toBe("failed");
    if (fail1.status === "failed") expect(fail1.attempts).toBe(1);

    const fail2 = await applyPendingRestoreAtBoot(home);
    expect(fail2.status).toBe("failed");
    expect(existsSync(restoreFailedPath(home))).toBe(true);

    const blocked = await applyPendingRestoreAtBoot(home);
    expect(blocked.status).toBe("blocked");
  });
});
