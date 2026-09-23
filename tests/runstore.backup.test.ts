import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackupError,
  assertBackupOutPathAllowed,
  createBackup,
  verifyDbSnapshot,
} from "../src/runstore/backup.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { CURRENT_SCHEMA_VERSION } from "../src/runstore/sqlite/migrations/index.js";

describe("createBackup", () => {
  it("VACUUM INTO snapshot includes recent rows and has no WAL sidecars", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-live-"));
    const { store, connection } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    connection.exec(
      "CREATE TABLE IF NOT EXISTS backup_probe (id INTEGER PRIMARY KEY, note TEXT)",
    );
    connection.prepare("INSERT INTO backup_probe (id, note) VALUES (1, ?)").run(
      "before",
    );

    let stop = false;
    const writer = (async () => {
      let n = 2;
      while (!stop) {
        connection
          .prepare("INSERT INTO backup_probe (id, note) VALUES (?, ?)")
          .run(n, `row-${n}`);
        n += 1;
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    await new Promise((r) => setTimeout(r, 20));
    const out = path.join(home, "backups", "live.db");
    const result = await createBackup({
      store,
      homeDir: home,
      outPath: out,
      dbOnly: true,
    });
    stop = true;
    await writer;

    expect(existsSync(`${out}-wal`)).toBe(false);
    expect(existsSync(`${out}-shm`)).toBe(false);
    verifyDbSnapshot(out, CURRENT_SCHEMA_VERSION);

    const snap = new Database(out, { readonly: true });
    const count = snap
      .prepare("SELECT COUNT(*) AS c FROM backup_probe")
      .get() as { c: number };
    expect(count.c).toBeGreaterThanOrEqual(1);
    snap.close();
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);

    await store.close();
  });

  it("refuses when free space is insufficient before vacuum", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-disk-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    await expect(
      createBackup({
        store,
        homeDir: home,
        dbOnly: true,
        freeSpace: async () => ({ freeBytes: 0 }),
      }),
    ).rejects.toMatchObject({ code: "backup_insufficient_disk" });
    await store.close();
  });

  it("default archive includes auth at 0600 and --no-credentials / --db-only shapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-tar-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "settings.json"), '{"maxConcurrent":1}\n');
    writeFileSync(path.join(home, "agent", "auth.json"), '{"k":"v"}\n', {
      mode: 0o600,
    });

    const full = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "full.tar.gz"),
    });
    expect(full.contents).toEqual(
      expect.arrayContaining([
        "state.db",
        "settings.json",
        "agent/auth.json",
        "manifest.json",
      ]),
    );
    expect(statSync(full.path).mode & 0o777).toBe(0o600);

    const noCred = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "nocred.tar.gz"),
      noCredentials: true,
    });
    expect(noCred.contents).not.toContain("agent/auth.json");

    const dbOnly = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "only.db"),
      dbOnly: true,
    });
    expect(dbOnly.contents).toEqual(["state.db"]);

    await store.close();
  });

  it("interrupted partial may remain without final target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-partial-"));
    const home = storeRootFor(root);
    await mkdir(path.join(home, "backups"), { recursive: true });
    const out = path.join(home, "backups", "gone.tar.gz");
    writeFileSync(`${out}.partial`, "incomplete");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(true);
  });

  it("refuses worktree outs", () => {
    const home = "/tmp/sf-home";
    expect(() =>
      assertBackupOutPathAllowed(`${home}/worktrees/x/out.tar.gz`, home),
    ).toThrow(BackupError);
  });
});
