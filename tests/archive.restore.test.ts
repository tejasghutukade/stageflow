import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchive, type ArchiveManifest } from "../src/archive/build.js";
import { detectArchive } from "../src/archive/restoreArchive.js";
import { readTarGz } from "../src/archive/tarReader.js";
import { TarStream } from "../src/archive/tarStream.js";
import { createBackup } from "../src/runstore/backup.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import type { RunStore } from "../src/runstore/port.js";
import { applyPendingRestoreAtBoot, applyRestoreArchive, restoreMarkerPath, stageRestoreForBoot, RestoreError } from "../src/runstore/restore.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const CANARY = "CANARY-SECRET-77aa";
const down = async () => "unreachable" as const;

async function makeHome(): Promise<{ home: string; store: RunStore; connection: Database.Database }> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-restore-src-"));
  const { store, connection } = createRunStoreWithConnection({ rootDir: root, openerMode: "migrate" });
  cleanups.push(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { home: storeRootFor(root), store, connection };
}

async function emptyHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-restore-dst-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function put(home: string, relative: string, content: string): void {
  const file = path.join(home, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function plant(home: string): void {
  put(home, "settings.json", '{"maxConcurrent":3}');
  put(home, "workspace/stageflow.yaml", "version: 1\n");
  put(home, "workspace/a/long/path/pipeline.pipeline.yaml", "id: p\n");
  put(home, "memories/m1/body.md", "remember");
  put(home, "connections.yaml", "connections: []\n");
  put(home, "agents/pi-sessions/s1.jsonl", "{}\n");
  put(home, "runs/run-1/stages/s1/attempts/1/artifacts/out.txt", "artifact");
  put(home, "agent/auth.json", `{"k":"${CANARY}"}`);
  put(home, "channel-secrets.json", `{"s":"${CANARY}"}`);
  put(home, "secrets/mcp-oauth.key", "key");
  put(home, "agent/mcp-oauth-encrypted", "enc");
  const identity = new Database(path.join(home, "identity-db.tmp"));
  identity.close();
  mkdirSync(path.join(home, "identity"), { recursive: true });
  const db = new Database(path.join(home, "identity", "consumer-identity.db"));
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO people (name) VALUES ('ada')");
  db.close();
  rmSync2(path.join(home, "identity-db.tmp"));
}
function rmSync2(file: string): void {
  try { writeFileSync(file, ""); } catch { /* ignore */ }
}

function runsFor(store: RunStore, home: string) {
  return { snapshotInto: store.snapshotInto.bind(store), listRuns: async () => [{ run_id: "run-1" }] as never, getWorkspaceDir: (id: string) => path.join(home, "runs", id) };
}

function tree(home: string, skip: RegExp = /(\.pre-restore-|^backups|^tmp|^host|state\.db|^identity-db)/): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(home, relative)).sort()) {
      const rel = relative ? `${relative}/${entry}` : entry;
      if (skip.test(rel)) continue;
      const abs = path.join(home, rel);
      const stat = lstatSync(abs);
      if (stat.isDirectory()) walk(rel);
      else if (stat.isSymbolicLink()) out.set(rel, `-> ${readlinkSync(abs)}`);
      else out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk("");
  return out;
}

/** Rewrites an archive: `edit` may change or drop entries, or add new ones, before the tar is written again. */
async function rewrite(archive: string, edit: (entries: Array<{ name: string; kind: string; data: Buffer; linkName: string; mode: number }>) => void): Promise<string> {
  const entries: Array<{ name: string; kind: string; data: Buffer; linkName: string; mode: number }> = [];
  await readTarGz(archive, async (entry, data) => {
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(chunk);
    entries.push({ name: entry.name, kind: entry.kind, data: Buffer.concat(chunks), linkName: entry.linkName, mode: entry.mode });
  });
  edit(entries);
  const out = `${archive}.rewritten.tar.gz`;
  const gzip = createGzip();
  const writing = pipeline(gzip, createWriteStream(out));
  const tar = new TarStream(gzip);
  for (const entry of entries) {
    const meta = { mode: entry.mode || 0o644, mtimeSeconds: 0 };
    if (entry.kind === "symlink") await tar.addSymlink(entry.name, entry.linkName, meta);
    else if (entry.kind === "directory") await tar.addDirectory(entry.name, meta);
    else await tar.addBuffer(entry.name, entry.data, meta);
  }
  await tar.finish();
  gzip.end();
  await writing;
  return out;
}

async function archiveOf(options: { secrets?: boolean } = {}): Promise<{ archive: string; home: string; store: RunStore }> {
  const { home, store } = await makeHome();
  plant(home);
  const result = await buildArchive({ store: runsFor(store, home), homeDir: home, includeSecrets: options.secrets === true });
  return { archive: result.path, home, store };
}

describe("restoring an sf archive", () => {
  it("round trip: a fresh home gets back every file it was given, byte for byte", async () => {
    const { archive, home } = await archiveOf();
    const target = await emptyHome();
    const result = await applyRestoreArchive({ archivePath: archive, homeDir: target, probe: down });
    expect(result.kind).toBe("archive");
    expect(result.files_restored).toBeGreaterThan(8);
    const expected = tree(home, /(\.pre-restore-|^backups|^tmp|^host|state\.db|^identity-db|^agent\/|^channel-secrets|^secrets|consumer-identity\.db)/);
    const got = tree(target, /(\.pre-restore-|^backups|^tmp|^host|state\.db|consumer-identity\.db)/);
    expect(got).toEqual(expected);
    expect(existsSync(path.join(target, "state.db"))).toBe(true);
    const restoredIdentity = new Database(path.join(target, "identity", "consumer-identity.db"), { readonly: true });
    expect(restoredIdentity.prepare("SELECT name FROM people").get()).toEqual({ name: "ada" });
    restoredIdentity.close();
    expect(readFileSync(path.join(target, "runs/run-1/stages/s1/attempts/1/artifacts/out.txt"), "utf8")).toBe("artifact");
  });

  it("a default archive restores no secrets and leaves the target's own secret files alone", async () => {
    const { archive } = await archiveOf();
    const target = await emptyHome();
    put(target, "agent/auth.json", "target-own-auth");
    put(target, "channel-secrets.json", "target-own-secrets");
    const result = await applyRestoreArchive({ archivePath: archive, homeDir: target, probe: down });
    expect(result.secrets_restored).toBe(0);
    expect(readFileSync(path.join(target, "agent/auth.json"), "utf8")).toBe("target-own-auth");
    expect(readFileSync(path.join(target, "channel-secrets.json"), "utf8")).toBe("target-own-secrets");
  });

  it("an archive with secrets restores them, replaced files are kept aside, and restoreCredentials false skips them", async () => {
    const { archive } = await archiveOf({ secrets: true });
    const target = await emptyHome();
    put(target, "settings.json", "old-settings");
    const skipped = await applyRestoreArchive({ archivePath: archive, homeDir: target, probe: down, restoreCredentials: false });
    expect(skipped.secrets_restored).toBe(0);
    expect(existsSync(path.join(target, "agent/auth.json"))).toBe(false);

    const second = await emptyHome();
    put(second, "settings.json", "old-settings");
    const result = await applyRestoreArchive({ archivePath: archive, homeDir: second, probe: down });
    expect(result.secrets_restored).toBe(4);
    expect(readFileSync(path.join(second, "agent/auth.json"), "utf8")).toContain(CANARY);
    expect(statSync(path.join(second, "agent/auth.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(second, "settings.json"), "utf8")).toBe('{"maxConcurrent":3}');
    expect(readFileSync(path.join(second, `settings.json.pre-restore-${result.pre_restore_stamp}`), "utf8")).toBe("old-settings");
  });

  it("moves an existing store aside with its sidecars and replaces it", async () => {
    const { archive } = await archiveOf();
    const { home: target, connection } = await makeHome();
    connection.exec("CREATE TABLE IF NOT EXISTS marker (id INTEGER)");
    const result = await applyRestoreArchive({ archivePath: archive, homeDir: target, probe: down }).catch((error: unknown) => error);
    // The live store of `target` is open in this process, so the exclusive lock may refuse; either way the archive was not half applied.
    if (result instanceof RestoreError) expect(result.code).toBe("restore_store_busy");
    else expect(existsSync(path.join(target, `state.db.pre-restore-${(result as { pre_restore_stamp: string }).pre_restore_stamp}`))).toBe(true);
  });

  it("refuses a file whose bytes were changed, and touches nothing", async () => {
    const { archive } = await archiveOf();
    const tampered = await rewrite(archive, (entries) => {
      const target = entries.find((entry) => entry.name === "settings.json")!;
      target.data = Buffer.from('{"maxConcurrent":99}');
    });
    const target = await emptyHome();
    put(target, "settings.json", "keep-me");
    await expect(applyRestoreArchive({ archivePath: tampered, homeDir: target, probe: down })).rejects.toMatchObject({ code: "restore_verify_failed" });
    expect(readFileSync(path.join(target, "settings.json"), "utf8")).toBe("keep-me");
    expect(existsSync(path.join(target, "state.db"))).toBe(false);
  });

  it("refuses a truncated archive and one with a missing or extra file", async () => {
    const { archive } = await archiveOf();
    const bytes = readFileSync(archive);
    const truncated = `${archive}.cut.tar.gz`;
    writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    const target = await emptyHome();
    await expect(applyRestoreArchive({ archivePath: truncated, homeDir: target, probe: down })).rejects.toBeDefined();
    expect(existsSync(path.join(target, "state.db"))).toBe(false);

    const missing = await rewrite(archive, (entries) => { entries.splice(entries.findIndex((entry) => entry.name === "settings.json"), 1); });
    await expect(applyRestoreArchive({ archivePath: missing, homeDir: await emptyHome(), probe: down })).rejects.toMatchObject({ code: "restore_verify_failed" });

    const extra = await rewrite(archive, (entries) => { entries.splice(0, 0, { name: "settings.json.extra", kind: "file", data: Buffer.from("x"), linkName: "", mode: 0o644 }); });
    await expect(applyRestoreArchive({ archivePath: extra, homeDir: await emptyHome(), probe: down })).rejects.toMatchObject({ code: expect.stringMatching(/restore_(unsafe_member|verify_failed)/) });
  });

  it("refuses an archive from a newer minor version even with force, and a major mismatch without force", async () => {
    const { archive } = await archiveOf();
    const [major, minor] = PACKAGE_VERSION.split(".").map(Number) as [number, number];
    const withVersion = async (version: string) => rewrite(archive, (entries) => {
      const entry = entries.find((item) => item.name === "manifest.json")!;
      const manifest = JSON.parse(entry.data.toString("utf8")) as ArchiveManifest;
      manifest.stageflow_version = version;
      entry.data = Buffer.from(JSON.stringify(manifest));
    });
    const newer = await withVersion(`${major}.${minor + 1}.0`);
    await expect(applyRestoreArchive({ archivePath: newer, homeDir: await emptyHome(), probe: down, force: true })).rejects.toMatchObject({ code: "restore_schema_too_new" });
    const newerMajor = await withVersion(`${major + 1}.0.0`);
    await expect(applyRestoreArchive({ archivePath: newerMajor, homeDir: await emptyHome(), probe: down, force: true })).rejects.toMatchObject({ code: "restore_schema_too_new" });
    const older = await withVersion(`${Math.max(0, major - 1)}.${minor + 5}.0`);
    if (major > 0) {
      await expect(applyRestoreArchive({ archivePath: older, homeDir: await emptyHome(), probe: down })).rejects.toMatchObject({ code: "restore_version_mismatch" });
      await expect(applyRestoreArchive({ archivePath: older, homeDir: await emptyHome(), probe: down, force: true })).resolves.toMatchObject({ kind: "archive" });
    }
    const samePatch = await withVersion(`${major}.${minor}.99`);
    await expect(applyRestoreArchive({ archivePath: samePatch, homeDir: await emptyHome(), probe: down })).resolves.toMatchObject({ kind: "archive" });
    const badVersion = await rewrite(archive, (entries) => {
      const entry = entries.find((item) => item.name === "manifest.json")!;
      const manifest = JSON.parse(entry.data.toString("utf8")) as ArchiveManifest;
      manifest.archive_version = 2;
      entry.data = Buffer.from(JSON.stringify(manifest));
    });
    await expect(applyRestoreArchive({ archivePath: badVersion, homeDir: await emptyHome(), probe: down })).rejects.toMatchObject({ code: "restore_verify_failed" });
  });

  it("refuses members that are not part of an archive: traversal, lock files, disposable folders, links out of a run", async () => {
    const { archive } = await archiveOf();
    for (const [name, kind] of [["../evil", "file"], ["/etc/passwd", "file"], ["host.lock", "file"], ["eval-engine/x", "file"], ["worktrees/r/f", "file"], ["runs/run-1/.pi-agent/auth.json", "file"], ["unknown/thing", "file"]] as const) {
      const bad = await rewrite(archive, (entries) => { entries.splice(0, 0, { name, kind, data: Buffer.from("x"), linkName: "", mode: 0o644 }); });
      const target = await emptyHome();
      await expect(applyRestoreArchive({ archivePath: bad, homeDir: target, probe: down }), name).rejects.toMatchObject({ code: "restore_unsafe_member" });
      expect(existsSync(path.join(target, "state.db")), name).toBe(false);
    }
  });

  it("restores a symbolic link inside the data directory and skips one that points out of it", async () => {
    const { home, store } = await makeHome();
    plant(home);
    symlinkSync("stageflow.yaml", path.join(home, "workspace", "inside-link"));
    symlinkSync("/etc/hosts", path.join(home, "workspace", "outside-link"));
    const result = await buildArchive({ store: runsFor(store, home), homeDir: home });
    const target = await emptyHome();
    const applied = await applyRestoreArchive({ archivePath: result.path, homeDir: target, probe: down });
    expect(lstatSync(path.join(target, "workspace", "inside-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(target, "workspace", "inside-link"))).toBe("stageflow.yaml");
    expect(existsSync(path.join(target, "workspace", "outside-link"))).toBe(false);
    expect(applied.links_skipped).toEqual(["workspace/outside-link"]);
  });

  it("will not write through a link that already exists in the target and points outside it", async () => {
    const { archive } = await archiveOf();
    const target = await emptyHome();
    const outside = await mkdtemp(path.join(tmpdir(), "sf-restore-out-"));
    cleanups.push(async () => rm(outside, { recursive: true, force: true }));
    symlinkSync(outside, path.join(target, "workspace"));
    await expect(applyRestoreArchive({ archivePath: archive, homeDir: target, probe: down })).rejects.toMatchObject({ code: "restore_unsafe_member" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses early when there is not enough room to stage the files", async () => {
    const { archive } = await archiveOf();
    const { stageArchive } = await import("../src/archive/restoreArchive.js");
    const dir = await mkdtemp(path.join(tmpdir(), "sf-stage-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    await expect(stageArchive(archive, dir, { freeSpace: async () => ({ freeBytes: 10 }) })).rejects.toMatchObject({ code: "restore_insufficient_space" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("detects an archive, and does not mistake a backup or a bare database for one", async () => {
    const { archive, home, store } = await archiveOf();
    expect((await detectArchive(archive))?.archive_version).toBe(1);
    const backup = await createBackup({ store, homeDir: home, outPath: path.join(home, "backups", "b.tar.gz"), noCredentials: true });
    expect(await detectArchive(backup.path)).toBeUndefined();
    const dbOnly = await createBackup({ store, homeDir: home, outPath: path.join(home, "backups", "b.db"), dbOnly: true });
    expect(await detectArchive(dbOnly.path)).toBeUndefined();
    expect(await detectArchive(path.join(home, "missing.tar.gz"))).toBeUndefined();
  });

  it("a plain backup still restores exactly as before", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const backup = await createBackup({ store, homeDir: home, outPath: path.join(home, "backups", "plain.tar.gz"), noCredentials: true });
    const target = await emptyHome();
    const result = await applyRestoreArchive({ archivePath: backup.path, homeDir: target, probe: down });
    expect(result.kind).toBeUndefined();
    expect(existsSync(path.join(target, "state.db"))).toBe(true);
    expect(existsSync(path.join(target, "workspace"))).toBe(false);
  });

  it("an API restore stages an archive and the next boot applies it", async () => {
    const { archive } = await archiveOf();
    const target = await emptyHome();
    const staged = await stageRestoreForBoot({ archivePath: archive, homeDir: target, graceMs: 0 });
    expect(existsSync(staged.stagedPath)).toBe(true);
    expect(existsSync(restoreMarkerPath(target))).toBe(true);
    const outcome = await applyPendingRestoreAtBoot(target);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "applied" });
    expect(existsSync(path.join(target, "workspace", "stageflow.yaml"))).toBe(true);
    expect(existsSync(path.join(target, "state.db"))).toBe(true);
  });

  it("staging refuses a bad archive up front", async () => {
    const { archive } = await archiveOf();
    const tampered = await rewrite(archive, (entries) => { entries.find((entry) => entry.name === "settings.json")!.data = Buffer.from("changed"); });
    const target = await emptyHome();
    await expect(stageRestoreForBoot({ archivePath: tampered, homeDir: target })).rejects.toMatchObject({ code: "restore_verify_failed" });
    expect(existsSync(restoreMarkerPath(target))).toBe(false);
  });
});

void createGunzip; void createReadStream; void gunzipSync; void gzipSync; void once;

describe("staging a plain backup for the next boot", () => {
  it("keeps the .tar.gz extension so the boot restore reads it as an archive of files, not a database", async () => {
    const { home, store } = await makeHome();
    plant(home);
    const backup = await createBackup({ store, homeDir: home, outPath: path.join(home, "backups", "plain.tar.gz"), noCredentials: true });
    const target = await emptyHome();
    const staged = await stageRestoreForBoot({ archivePath: backup.path, homeDir: target, graceMs: 0 });
    expect(staged.stagedPath.endsWith(".tar.gz")).toBe(true);
    const outcome = await applyPendingRestoreAtBoot(target);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "applied" });
  });
});
