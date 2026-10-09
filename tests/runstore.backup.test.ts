import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import {
  BackupError,
  assertBackupOutPathAllowed,
  backupsDir,
  createBackup,
  resolveBackupDownloadPath,
  verifyDbSnapshot,
} from "../src/runstore/backup.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { extractVerifiedArchive } from "../src/runstore/restore.js";
import { CURRENT_SCHEMA_VERSION } from "../src/runstore/sqlite/migrations/index.js";

const CREDENTIAL_HOME_ENV = "STAGEFLOW_CREDENTIAL_HOME";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withCredentialRoots<T>(
  roots: { data: string; creds: string },
  fn: () => Promise<T>,
): Promise<T> {
  const prevHome = process.env.STAGEFLOW_HOME;
  const prevCreds = process.env[CREDENTIAL_HOME_ENV];
  process.env.STAGEFLOW_HOME = roots.data;
  process.env[CREDENTIAL_HOME_ENV] = roots.creds;
  resetGlobalStageflowHomeForTests();
  try {
    return await fn();
  } finally {
    restoreEnv("STAGEFLOW_HOME", prevHome);
    restoreEnv(CREDENTIAL_HOME_ENV, prevCreds);
    resetGlobalStageflowHomeForTests();
  }
}

async function manifestOf(archivePath: string): Promise<{
  credentials_included?: boolean;
  secret_warning?: string;
  contents?: string[];
  authPacked: boolean;
}> {
  const verified = await extractVerifiedArchive(archivePath);
  try {
    const manifest = verified.manifest as {
      credentials_included?: boolean;
      secret_warning?: string;
      contents?: string[];
    } | null;
    return {
      credentials_included: manifest?.credentials_included,
      secret_warning: manifest?.secret_warning,
      contents: manifest?.contents,
      authPacked: existsSync(path.join(verified.stagingDir, "agent", "auth.json")),
    };
  } finally {
    await rm(verified.stagingDir, { recursive: true, force: true });
  }
}

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

    try {
      await withCredentialRoots({ data: home, creds: home }, async () => {
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
      });
    } finally {
      await store.close();
    }
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

describe("resolveBackupDownloadPath", () => {
  it("rejects .PARTIAL by name (case-insensitive)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-partial-name-"));
    const home = storeRootFor(root);
    await mkdir(backupsDir(home), { recursive: true });
    await expect(
      resolveBackupDownloadPath("snap.PARTIAL", home),
    ).rejects.toMatchObject({ code: "backup_out_denied" });
  });

  it("rejects symlink whose real basename ends with .partial", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-partial-link-"));
    const home = storeRootFor(root);
    const dir = backupsDir(home);
    await mkdir(dir, { recursive: true });
    const partial = path.join(dir, "incomplete.tar.gz.partial");
    writeFileSync(partial, "incomplete");
    const linkName = "looks-ok.tar.gz";
    symlinkSync(partial, path.join(dir, linkName));
    await expect(resolveBackupDownloadPath(linkName, home)).rejects.toMatchObject({
      code: "backup_out_denied",
    });
  });
});

describe("backup credential root", () => {
  it("packs a usable auth file when the archive directory is the credential root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-cred-root-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "agent", "auth.json"), '{"k":"usable"}\n', {
      mode: 0o600,
    });
    writeFileSync(path.join(home, "agent", "models.json"), '{"models":[]}\n');
    writeFileSync(path.join(home, "agent", "cursor-api-key"), "cursor-secret\n");

    try {
      await withCredentialRoots({ data: home, creds: home }, async () => {
        const full = await createBackup({
          store,
          homeDir: home,
          outPath: path.join(home, "backups", "cred-root.tar.gz"),
        });
        expect(full.contents).toContain("agent/auth.json");
        expect(full.contents).not.toContain("models.json");
        expect(full.contents).not.toContain("cursor-api-key");
        const manifest = await manifestOf(full.path);
        expect(manifest.credentials_included).toBe(true);
        expect(manifest.authPacked).toBe(true);
        expect(manifest.secret_warning).toMatch(/credential/i);
      });
    } finally {
      await store.close();
    }
  });

  it("omits a leftover empty auth file when the data directory is not the credential root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-cred-split-"));
    const creds = await mkdtemp(path.join(tmpdir(), "sf-backup-cred-store-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "agent", "auth.json"), "{}\n", { mode: 0o600 });
    mkdirSync(path.join(creds, "agent"), { recursive: true });
    writeFileSync(
      path.join(creds, "agent", "auth.json"),
      '{"operator":"keep-me"}\n',
      { mode: 0o600 },
    );

    try {
      await withCredentialRoots({ data: home, creds }, async () => {
        const result = await createBackup({
          store,
          homeDir: home,
          outPath: path.join(home, "backups", "process.tar.gz"),
        });
        expect(result.contents).not.toContain("agent/auth.json");
        const manifest = await manifestOf(result.path);
        expect(manifest.credentials_included).toBe(false);
        expect(manifest.authPacked).toBe(false);
        expect(manifest.secret_warning ?? "").not.toMatch(/credential/i);
      });
    } finally {
      await store.close();
      await rm(creds, { recursive: true, force: true });
    }
  });

  it("omits an unusable auth file when the archive directory is the credential root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-backup-cred-empty-"));
    const { store } = createRunStoreWithConnection({
      rootDir: root,
      openerMode: "migrate",
    });
    const home = storeRootFor(root);
    mkdirSync(path.join(home, "agent"), { recursive: true });
    writeFileSync(path.join(home, "agent", "auth.json"), "{}\n", { mode: 0o600 });

    try {
      await withCredentialRoots({ data: home, creds: home }, async () => {
        const result = await createBackup({
          store,
          homeDir: home,
          outPath: path.join(home, "backups", "empty-auth.tar.gz"),
        });
        expect(result.contents).not.toContain("agent/auth.json");
        const manifest = await manifestOf(result.path);
        expect(manifest.credentials_included).toBe(false);
        expect(manifest.authPacked).toBe(false);
        expect(manifest.secret_warning ?? "").not.toMatch(/credential/i);
      });
    } finally {
      await store.close();
    }
  });
});
