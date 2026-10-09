import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createBackup } from "../src/runstore/backup.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
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

  it("restoring a process archive leaves the operator auth file unchanged and restores settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-process-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-restore-operator-"));
    const prevHome = process.env.STAGEFLOW_HOME;
    const prevCreds = process.env[CREDENTIAL_HOME_ENV];
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    const archivedAuth = '{"archived":"old"}\n';
    const operatorAuth = '{"operator":"keep"}\n';
    const archivedSettings = '{"from":"archive"}\n';
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "agent", "auth.json"), archivedAuth, {
      mode: 0o600,
    });
    writeFileSync(path.join(home, "settings.json"), archivedSettings);

    try {
      process.env.STAGEFLOW_HOME = home;
      process.env[CREDENTIAL_HOME_ENV] = home;
      resetGlobalStageflowHomeForTests();

      const backup = await createBackup({
        store,
        homeDir: home,
        outPath: path.join(home, "backups", "process-old.tar.gz"),
      });
      await store.close();

      process.env.STAGEFLOW_HOME = home;
      process.env[CREDENTIAL_HOME_ENV] = creds;
      resetGlobalStageflowHomeForTests();

      mkdirSync(path.join(creds, "agent"), { recursive: true });
      writeFileSync(path.join(creds, "agent", "auth.json"), operatorAuth, {
        mode: 0o600,
      });
      writeFileSync(path.join(home, "agent", "auth.json"), "{}\n", {
        mode: 0o600,
      });
      writeFileSync(path.join(home, "settings.json"), '{"from":"live"}\n');

      await applyRestoreArchive({
        archivePath: backup.path,
        homeDir: home,
        probe: async () => "unreachable",
      });

      expect(readFileSync(path.join(creds, "agent", "auth.json"), "utf8")).toBe(
        operatorAuth,
      );
      expect(readFileSync(path.join(home, "agent", "auth.json"), "utf8")).toBe(
        "{}\n",
      );
      expect(readFileSync(path.join(home, "settings.json"), "utf8")).toBe(
        archivedSettings,
      );
    } finally {
      restoreEnv("STAGEFLOW_HOME", prevHome);
      restoreEnv(CREDENTIAL_HOME_ENV, prevCreds);
      resetGlobalStageflowHomeForTests();
      await rm(creds, { recursive: true, force: true });
    }
  });

  it("restores a usable auth file onto the credential root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-restore-cred-root-"));
    const prevHome = process.env.STAGEFLOW_HOME;
    const prevCreds = process.env[CREDENTIAL_HOME_ENV];
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    const archivedAuth = '{"archived":"usable"}\n';
    const archivedSettings = '{"from":"archive"}\n';
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "agent", "auth.json"), archivedAuth, {
      mode: 0o600,
    });
    writeFileSync(path.join(home, "settings.json"), archivedSettings);

    try {
      process.env.STAGEFLOW_HOME = home;
      process.env[CREDENTIAL_HOME_ENV] = home;
      resetGlobalStageflowHomeForTests();

      const backup = await createBackup({
        store,
        homeDir: home,
        outPath: path.join(home, "backups", "cred-root.tar.gz"),
      });
      await store.close();
      writeFileSync(path.join(home, "agent", "auth.json"), '{"replaced":true}\n', {
        mode: 0o600,
      });
      writeFileSync(path.join(home, "settings.json"), '{"from":"live"}\n');

      await applyRestoreArchive({
        archivePath: backup.path,
        homeDir: home,
        probe: async () => "unreachable",
      });

      expect(readFileSync(path.join(home, "agent", "auth.json"), "utf8")).toBe(
        archivedAuth,
      );
      expect(readFileSync(path.join(home, "settings.json"), "utf8")).toBe(
        archivedSettings,
      );
    } finally {
      restoreEnv("STAGEFLOW_HOME", prevHome);
      restoreEnv(CREDENTIAL_HOME_ENV, prevCreds);
      resetGlobalStageflowHomeForTests();
    }
  });
});
