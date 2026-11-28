import { createHash } from "node:crypto";
import { createGunzip, gzipSync } from "node:zlib";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { artifactKeyHash } from "../src/artifacts/store.js";
import { publishArtifact } from "../src/artifacts/publish.js";
import { listArtifacts } from "../src/artifacts/query.js";
import { setArtifactSearchDdlForTests, resetArtifactSearchForTests } from "../src/artifacts/search.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { createBackup } from "../src/runstore/backup.js";
import { createRunStoreWithConnection, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import {
  applyRestoreArchive,
  extractVerifiedArchive,
  RestoreError,
  setRestoreArtifactSwapFaultForTests,
} from "../src/runstore/restore.js";
import { writeStoredVersion } from "../src/artifacts/store.js";
import { publishedArtifactStoreDoctorCheck } from "../src/diagnostics/artifactStoreCheck.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRestoreArtifactSwapFaultForTests(undefined);
  resetArtifactSearchForTests();
  resetGlobalStageflowHomeForTests();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function withHome(): Promise<{
  home: string;
  project: string;
  store: Awaited<ReturnType<typeof createRunStoreWithConnection>>["store"];
  db: Database.Database;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-artifact-bu-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-artifact-proj-"));
  process.env.STAGEFLOW_HOME = storeRootFor(root);
  resetGlobalStageflowHomeForTests();
  const opened = createRunStoreWithConnection({ rootDir: root, openerMode: "migrate" });
  const home = storeRootFor(root);
  const db = sqliteConnectionFromStore(opened.store)!;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await opened.store.close();
  };
  cleanups.push(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { home, project, store: opened.store, db, close };
}

function insertPublishedArtifact(
  db: Database.Database,
  projectId: string,
  artifactId: string,
  version: number,
  body: string,
  fileName = "body.md",
): { key: string; hash: string } {
  const owner = stageOwnerKey("pipe-a", "stage-a");
  const key = artifactStorageKey(projectId, owner, artifactId);
  const hash = createHash("sha256").update(body).digest("hex");
  const now = new Date().toISOString();
  const exists = db.prepare(`SELECT 1 AS ok FROM artifacts WHERE key = ?`).get(key) as { ok: number } | undefined;
  if (!exists) {
    db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id,
         title, tags_json, kind, origin, current_version, status, hidden, created_at, updated_at
       ) VALUES (
         @key, 'stage', @pipeline, @stage, @project, @id,
         @title, '[]', 'static.markdown', 'published', @version, 'available', 0, @now, @now
       )`,
    ).run({
      key,
      pipeline: "pipe-a",
      stage: "stage-a",
      project: projectId,
      id: artifactId,
      title: artifactId,
      version,
      now,
    });
  } else {
    db.prepare(`UPDATE artifacts SET current_version = @version, updated_at = @now WHERE key = @key`).run({
      key,
      version,
      now,
    });
  }
  db.prepare(
    `INSERT OR REPLACE INTO artifact_versions (
       key, version, size_bytes, content_hash, manifest_json, created_at, pinned, relative_path, storage
     ) VALUES (
       @key, @version, @size, @hash, '{"kind":"static.markdown"}', @now, 0, @fileName, 'store'
     )`,
  ).run({
    key,
    version,
    size: Buffer.byteLength(body),
    hash,
    fileName,
    now,
  });
  return { key, hash };
}

async function tarMembers(archivePath: string): Promise<string[]> {
  const tarPath = path.join(tmpdir(), `sf-extract-${Date.now()}.tar`);
  await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(tarPath));
  const buf = readFileSync(tarPath);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header.subarray(124, 135).toString("utf8").replace(/\0| /g, "");
    const size = Number.parseInt(sizeOctal, 8) || 0;
    offset += size + ((512 - (size % 512)) % 512);
    if (name) names.push(name);
  }
  rmSync(tarPath, { force: true });
  return names;
}

function rowsSnapshot(db: Database.Database): string {
  const artifacts = db
    .prepare(`SELECT key, current_version FROM artifacts ORDER BY key`)
    .all() as { key: string; current_version: number }[];
  const versions = db
    .prepare(`SELECT key, version, content_hash FROM artifact_versions ORDER BY key, version`)
    .all() as { key: string; version: number; content_hash: string }[];
  return JSON.stringify({ artifacts, versions });
}

describe("backup and restore published artifacts", () => {
  it("round-trips three artifacts with three versions each", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    for (let a = 1; a <= 3; a += 1) {
      for (let v = 1; v <= 3; v += 1) {
        const body = `artifact-${a}-v${v}\n`;
        const { key } = insertPublishedArtifact(db, projectId, `art-${a}`, v, body);
        await writeStoredVersion({
          storageKey: key,
          version: v,
          fileName: "body.md",
          bytes: Buffer.from(body),
          manifest: { kind: "static.markdown" },
        });
      }
    }
    const before = rowsSnapshot(db);
    const backup = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "artifacts.tar.gz"),
    });
    expect(backup.contents).toContain("artifacts");
    const members = await tarMembers(backup.path);
    expect(members.some((name) => name.startsWith("artifacts/"))).toBe(true);
  await close();

    const restoreRoot = await mkdtemp(path.join(tmpdir(), "sf-artifact-restore-"));
    process.env.STAGEFLOW_HOME = restoreRoot;
    resetGlobalStageflowHomeForTests();
    mkdirSync(path.join(restoreRoot, "backups"), { recursive: true });
    cleanups.push(async () => rm(restoreRoot, { recursive: true, force: true }));
    const result = await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: restoreRoot,
      probe: async () => "unreachable",
    });
    expect(result.published_artifact_integrity ?? []).toEqual([]);
    const restoredDb = new Database(path.join(restoreRoot, "state.db"), { readonly: true });
    expect(rowsSnapshot(restoredDb)).toBe(before);
    restoredDb.close();
    for (let a = 1; a <= 3; a += 1) {
      for (let v = 1; v <= 3; v += 1) {
        const body = `artifact-${a}-v${v}\n`;
        const owner = stageOwnerKey("pipe-a", "stage-a");
        const key = artifactStorageKey(projectId, owner, `art-${a}`);
        const file = path.join(restoreRoot, "artifacts", artifactKeyHash(key), `v${v}`, "body.md");
        expect(readFileSync(file, "utf8")).toBe(body);
      }
    }
  });

  it("restores a published artifact and finds a body-only search term", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    const roots: CatalogRoot[] = [
      { project_root: projectId, path: project, kind: "registered", read_only: false },
    ];
    await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "pipe-a", stage: "stage-a" },
      projectRoot: projectId,
      id: "note",
      kind: "static.text",
      title: "Visible title",
      bytes: Buffer.from("onlyinbodytoken"),
      publishSource: "api",
      roots,
    });
    const backup = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "search.tar.gz"),
      noCredentials: true,
    });
    await close();
    const restoreRoot = await mkdtemp(path.join(tmpdir(), "sf-artifact-restore-"));
    process.env.STAGEFLOW_HOME = restoreRoot;
    resetGlobalStageflowHomeForTests();
    mkdirSync(path.join(restoreRoot, "backups"), { recursive: true });
    cleanups.push(async () => rm(restoreRoot, { recursive: true, force: true }));
    await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: restoreRoot,
      probe: async () => "unreachable",
    });
    const restored = new Database(path.join(restoreRoot, "state.db"));
    const page = listArtifacts(restored, { limit: 10, q: "onlyinbodytoken" }, roots);
    expect(page.artifacts.map((row) => row.id)).toEqual(["note"]);
    restored.close();
  });

  it("restores a database without artifact_fts onto the text-scan fallback", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    const roots: CatalogRoot[] = [
      { project_root: projectId, path: project, kind: "registered", read_only: false },
    ];
    await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "pipe-a", stage: "stage-a" },
      projectRoot: projectId,
      id: "note",
      kind: "static.text",
      title: "Visible title",
      bytes: Buffer.from("onlyinbodytoken"),
      publishSource: "api",
      roots,
    });
    db.exec(`DROP TABLE artifact_fts`);
    db.exec(`DELETE FROM artifact_search_meta`);
    const backup = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "no-fts.tar.gz"),
      noCredentials: true,
    });
    await close();
    setArtifactSearchDdlForTests(() => {
      throw new Error("fts5 missing");
    });
    const restoreRoot = await mkdtemp(path.join(tmpdir(), "sf-artifact-restore-"));
    process.env.STAGEFLOW_HOME = restoreRoot;
    resetGlobalStageflowHomeForTests();
    mkdirSync(path.join(restoreRoot, "backups"), { recursive: true });
    cleanups.push(async () => rm(restoreRoot, { recursive: true, force: true }));
    await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: restoreRoot,
      probe: async () => "unreachable",
    });
    const restored = new Database(path.join(restoreRoot, "state.db"));
    expect(restored.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_fts'`).get()).toBeUndefined();
    expect(listArtifacts(restored, { limit: 10, q: "Visible" }, roots).artifacts.map((row) => row.id)).toEqual(["note"]);
    expect(listArtifacts(restored, { limit: 10, q: "onlyinbodytoken" }, roots).artifacts).toEqual([]);
    restored.close();
  });

  it("reports missing content and hash mismatch without failing restore", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    const body = "ok\n";
    const { key } = insertPublishedArtifact(db, projectId, "one", 1, body);
    await writeStoredVersion({
      storageKey: key,
      version: 1,
      fileName: "body.md",
      bytes: Buffer.from(body),
      manifest: { kind: "static.markdown" },
    });
    insertPublishedArtifact(db, projectId, "missing", 1, "gone\n");
    const { key: tamperKey } = insertPublishedArtifact(db, projectId, "tamper", 1, "original\n");
    await writeStoredVersion({
      storageKey: tamperKey,
      version: 1,
      fileName: "body.md",
      bytes: Buffer.from("original\n"),
      manifest: { kind: "static.markdown" },
    });
    const backup = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "drift.tar.gz"),
    });
    await close();

    const restoreRoot = await mkdtemp(path.join(tmpdir(), "sf-artifact-restore-"));
    process.env.STAGEFLOW_HOME = restoreRoot;
    resetGlobalStageflowHomeForTests();
    mkdirSync(path.join(restoreRoot, "backups"), { recursive: true });
    const result = await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: restoreRoot,
      probe: async () => "unreachable",
    });
    expect(result.published_artifact_integrity?.some((f) => f.code === "missing_content")).toBe(true);

    const restored = createRunStoreWithConnection({ rootDir: restoreRoot, openerMode: "migrate" });
    const tamperHashDir = path.join(restoreRoot, "artifacts", artifactKeyHash(tamperKey), "v1");
    writeFileSync(path.join(tamperHashDir, "body.md"), "changed\n");
    const doctor = await publishedArtifactStoreDoctorCheck(sqliteConnectionFromStore(restored.store), restoreRoot);
    expect(doctor.status).toBe("warn");
    expect(doctor.code).toMatch(/artifact_/);
    await restored.store.close();
    cleanups.push(async () => rm(restoreRoot, { recursive: true, force: true }));
  });

  it("warns when a backup has no artifact bytes and leaves the current tree in place", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    insertPublishedArtifact(db, projectId, "missing", 1, "gone\n");
    const kept = path.join(home, "artifacts", "kept-dir");
    mkdirSync(kept, { recursive: true });
    writeFileSync(path.join(kept, "stay.txt"), "stay");
    const backup = await createBackup({
      store,
      homeDir: home,
      outPath: path.join(home, "backups", "no-bytes.tar.gz"),
      noArtifacts: true,
      noCredentials: true,
    });
    await close();
    const result = await applyRestoreArchive({
      archivePath: backup.path,
      homeDir: home,
      probe: async () => "unreachable",
    });
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["artifacts_not_in_backup"]);
    expect(result.warnings?.[0]?.message).toMatch(/left in place/);
    expect(readFileSync(path.join(kept, "stay.txt"), "utf8")).toBe("stay");
    expect(result.published_artifact_integrity?.some((finding) => finding.code === "missing_content")).toBe(true);
  });

  it("puts the previous artifact tree and database back when the swap fails", async () => {
    const source = await withHome();
    const projectId = await source.store.ensureProject(source.project);
    const roots: CatalogRoot[] = [
      { project_root: projectId, path: source.project, kind: "registered", read_only: false },
    ];
    await publishArtifact(source.db, {
      owner: { kind: "stage", pipeline: "pipe-a", stage: "stage-a" },
      projectRoot: projectId,
      id: "incoming",
      kind: "static.text",
      title: "Incoming",
      bytes: Buffer.from("incoming-body"),
      publishSource: "api",
      roots,
    });
    const backup = await createBackup({
      store: source.store,
      homeDir: source.home,
      outPath: path.join(source.home, "backups", "incoming.tar.gz"),
      noCredentials: true,
    });
    await source.close();

    const target = await withHome();
    target.db
      .prepare(
        `INSERT INTO artifacts (
           key, owner_kind, owner_pipeline, owner_stage, project_root_id, id,
           title, tags_json, kind, origin, current_version, status, hidden, created_at, updated_at
         ) VALUES (
           'sentinel', 'stage', 'pipe-a', 'stage-a', 'examples', 'sentinel',
           'Sentinel', '[]', 'static.text', 'published', 1, 'available', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
         )`,
      )
      .run();
    const marker = path.join(target.home, "artifacts", "marker.txt");
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, "keep");
    await target.close();
    setRestoreArtifactSwapFaultForTests(() => {
      throw new Error("swap broke");
    });
    await expect(
      applyRestoreArchive({
        archivePath: backup.path,
        homeDir: target.home,
        probe: async () => "unreachable",
      }),
    ).rejects.toMatchObject({ code: "restore_failed" });
    expect(readFileSync(marker, "utf8")).toBe("keep");
    expect(readdirSync(target.home).filter((name) => name.startsWith(".artifacts-incoming-"))).toEqual([]);
    const restored = new Database(path.join(target.home, "state.db"), { readonly: true });
    const row = restored.prepare(`SELECT title FROM artifacts WHERE key = 'sentinel'`).get() as { title: string };
    expect(row.title).toBe("Sentinel");
    restored.close();
  });

  it("reports every artifact store issue with counts, examples, and an adaptive size", async () => {
    const { home, project, store, db, close } = await withHome();
    const projectId = await store.ensureProject(project);
    const paths: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { key } = insertPublishedArtifact(db, projectId, `bad-${index}`, 1, `original-${index}\n`);
      await writeStoredVersion({
        storageKey: key,
        version: 1,
        fileName: "body.md",
        bytes: Buffer.from(`changed-${index}\n`),
        manifest: { kind: "static.markdown" },
      });
      paths.push(`artifacts/${artifactKeyHash(key)}/v1/body.md`);
    }
    insertPublishedArtifact(db, projectId, "absent", 1, "gone\n");
    mkdirSync(path.join(home, "artifacts", "orphan-key", "notes"), { recursive: true });
    mkdirSync(path.join(home, "artifacts", "empty-orphan"), { recursive: true });
    const staging = path.join(home, "artifacts", "orphan-key", ".staging-old");
    mkdirSync(staging, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staging, old, old);
    const doctor = await publishedArtifactStoreDoctorCheck(db, home);
    expect(doctor.status).toBe("warn");
    expect(doctor.issues?.map((issue) => issue.code)).toEqual([
      "artifact_hash_mismatch",
      "artifact_missing_content",
      "artifact_orphan_directory",
      "artifact_stale_staging",
    ]);
    expect(doctor.issues?.[0]).toMatchObject({ count: 6, examples: paths.slice(0, 5) });
    expect(doctor.message).toContain("6 hash mismatches");
    expect(doctor.message).toContain("(+1 more)");
    expect(doctor.message).toContain("1 version missing content");
    expect(doctor.message).toContain("orphan");
    expect(doctor.message).toContain("artifacts/empty-orphan");
    expect(doctor.message).toContain("stale staging");
    expect(doctor.message).not.toContain("0.00 GiB");
    expect(doctor.message).toMatch(/\d+(\.\d+)? (B|KiB|MiB|GiB)/);
    await close();
  });

  it("rejects a directory tar member with restore_bad_member", async () => {
    const header = Buffer.alloc(512, 0);
    Buffer.from("artifacts/", "utf8").copy(header, 0);
    header.write("0000755", 100, 7, "utf8");
    header.write("0000000", 108, 7, "utf8");
    header.write("0000000", 116, 7, "utf8");
    header.write("00000000000", 124, 11, "utf8");
    header.write("00000000000", 136, 11, "utf8");
    header.write("        ", 148, 8, "utf8");
    header[156] = 0x35;
    Buffer.from("ustar\0", "utf8").copy(header, 257);
    Buffer.from("00", "utf8").copy(header, 263);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += header[index]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    const archive = path.join(tmpdir(), `sf-dir-member-${Date.now()}.tar.gz`);
    writeFileSync(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024, 0)])));
    cleanups.push(async () => rm(archive, { force: true }));
    await expect(extractVerifiedArchive(archive)).rejects.toBeInstanceOf(RestoreError);
    await expect(extractVerifiedArchive(archive)).rejects.toMatchObject({ code: "restore_bad_member" });
  });

  function ustar(name: string, type: number, body = ""): Buffer {
    const header = Buffer.alloc(512, 0);
    Buffer.from(name, "utf8").copy(header, 0);
    header.write("0000644", 100, 7, "utf8");
    header.write("0000000", 108, 7, "utf8");
    header.write("0000000", 116, 7, "utf8");
    header.write(body.length.toString(8).padStart(11, "0"), 124, 11, "utf8");
    header.write("00000000000", 136, 11, "utf8");
    header.write("        ", 148, 8, "utf8");
    header[156] = type;
    Buffer.from("ustar\0", "utf8").copy(header, 257);
    Buffer.from("00", "utf8").copy(header, 263);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += header[index]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    const payload = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    Buffer.from(body, "utf8").copy(payload);
    return Buffer.concat([header, payload]);
  }

  async function rejectArchive(bytes: Buffer, code: string): Promise<void> {
    const archive = path.join(tmpdir(), `sf-member-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
    writeFileSync(archive, gzipSync(Buffer.concat([bytes, Buffer.alloc(1024, 0)])));
    cleanups.push(async () => rm(archive, { force: true }));
    await expect(extractVerifiedArchive(archive)).rejects.toMatchObject({ code });
  }

  it("rejects device and fifo tar members with restore_unsafe_member", async () => {
    await rejectArchive(ustar("artifacts/char", 0x33), "restore_unsafe_member");
    await rejectArchive(ustar("artifacts/block", 0x34), "restore_unsafe_member");
    await rejectArchive(ustar("artifacts/fifo", 0x36), "restore_unsafe_member");
  });

  it("rejects a member that collides with an existing path as restore_bad_member", async () => {
    const file = ustar("artifacts/note.txt", 0x30, "hi");
    await rejectArchive(Buffer.concat([file, file]), "restore_bad_member");
  });

  it("rejects a decompressed archive over 1.5 GiB before reading it", async () => {
    const header = Buffer.alloc(512, 0);
    Buffer.from("artifacts/huge.bin", "utf8").copy(header, 0);
    header.write("0000644", 100, 7, "utf8");
    header.write("0000000", 108, 7, "utf8");
    header.write("0000000", 116, 7, "utf8");
    header.write("20000000000", 124, 11, "utf8");
    header.write("00000000000", 136, 11, "utf8");
    header.write("        ", 148, 8, "utf8");
    header[156] = 0x30;
    Buffer.from("ustar\0", "utf8").copy(header, 257);
    Buffer.from("00", "utf8").copy(header, 263);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += header[index]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    await rejectArchive(header, "restore_failed");
  });

  it("removes the staged artifact tree when the store lock fails", async () => {
    const source = await withHome();
    const projectId = await source.store.ensureProject(source.project);
    const { key } = insertPublishedArtifact(source.db, projectId, "note", 1, "body\n");
    await writeStoredVersion({
      storageKey: key,
      version: 1,
      fileName: "body.md",
      bytes: Buffer.from("body\n"),
      manifest: { kind: "static.markdown" },
    });
    const backup = await createBackup({
      store: source.store,
      homeDir: source.home,
      outPath: path.join(source.home, "backups", "lock.tar.gz"),
      noCredentials: true,
    });
    await source.close();
    const target = await withHome();
    await target.close();
    const lock = new Database(path.join(target.home, "state.db"));
    lock.pragma("busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    try {
      await expect(
        applyRestoreArchive({
          archivePath: backup.path,
          homeDir: target.home,
          probe: async () => "unreachable",
        }),
      ).rejects.toMatchObject({ code: "restore_store_busy" });
      expect(readdirSync(target.home).filter((name) => name.startsWith(".artifacts-incoming-"))).toEqual([]);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });
});