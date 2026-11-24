import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { A2aStore } from "../src/a2a/store.js";
import { artifactIdFromRelative } from "../src/artifacts/keys.js";
import { ArtifactQueryError, listArtifacts, parseArtifactStatus } from "../src/artifacts/query.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { indexedExpiresAt } from "../src/runstore/artifactRetention.js";
import { createRunStore, createRunStoreWithConnection, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { DAY_MS, retentionWindowsFromEnv } from "../src/runstore/retention.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { deleteRunEverywhere } from "../src/runtime/runDeletion.js";
import { runRetentionSweep } from "../src/runtime/runRetentionSweep.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";

const temps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "STAGEFLOW_HOME",
  "STAGEFLOW_PURGE_SUCCEEDED_MS",
  "STAGEFLOW_PURGE_FAILED_MS",
  "STAGEFLOW_PURGE_CANCELLED_MS",
  "STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES",
];

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  resetGlobalStageflowHomeForTests();
  const home = await mkdtemp(path.join(tmpdir(), "sf-art-ret-home-"));
  temps.push(home);
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetGlobalStageflowHomeForTests();
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix)).then((dir) => {
    temps.push(dir);
    return dir;
  });
}

type IndexedState = {
  id: string;
  origin: string;
  status: string;
  expired_at: string | null;
  expired_reason: string | null;
  expires_at: string | null;
};

function states(db: Database.Database): IndexedState[] {
  return db
    .prepare(
      `SELECT id, origin, status, expired_at, expired_reason, expires_at
       FROM artifacts ORDER BY id ASC`,
    )
    .all() as IndexedState[];
}

function stateFor(db: Database.Database, id: string): IndexedState {
  const row = states(db).find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing artifact ${id}`);
  return row;
}

async function openStore(): Promise<{ store: RunStore; db: Database.Database; root: string }> {
  const root = await temp("sf-art-ret-");
  const opened = createRunStoreWithConnection({ rootDir: root, kind: "sqlite" });
  return { store: opened.store, db: opened.connection, root };
}

async function indexFiles(
  store: RunStore,
  files: Record<string, string | Buffer>,
  projectRoot: string,
): Promise<string> {
  const created = await store.createRun({
    pipelineId: "sales",
    taskYaml: "id: t\ngoal: g\n",
    projectRoot,
  });
  await store.createStageExecution(created.runId, "summarize");
  const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), "summarize", 1);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(projectRoot, created.runId);
  await store.writeEnvelope(
    created.runId,
    "summarize",
    {
      status: "success",
      summary: "ok",
      artifacts: Object.keys(files),
      payload: {},
    },
    { attempt: 1 },
  );
  return created.runId;
}

function finish(db: Database.Database, runId: string, finishedAt: string, status = "succeeded"): void {
  db.prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?`).run(status, finishedAt, runId);
}

function insertPublished(db: Database.Database, runId: string, projectId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO artifacts (
       key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
       kind, origin, current_version, source_run_id, source_stage_id, source_attempt, hidden,
       status, created_at, updated_at
     ) VALUES (
       @key, 'stage', 'sales', 'summarize', @project, 'published-keep', 'Published', '[]',
       'static.text', 'published', 1, @run, 'summarize', 1, 0,
       'available', @now, @now
     )`,
  ).run({
    key: `${projectId}::stage:sales:summarize/published-keep`,
    project: projectId,
    run: runId,
    now,
  });
}

function insertEscape(db: Database.Database, runId: string, projectId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  const key = `${projectId}::stage:sales:summarize/linked-out`;
  db.prepare(
    `INSERT INTO artifacts (
       key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
       kind, origin, current_version, source_run_id, source_stage_id, source_attempt, hidden,
       status, created_at, updated_at
     ) VALUES (
       @key, 'stage', 'sales', 'summarize', @project, 'linked-out', 'Linked', '[]',
       'static.text', 'indexed', 1, @run, 'summarize', 1, 0,
       'available', @now, @now
     )`,
  ).run({ key, project: projectId, run: runId, now });
  db.prepare(
    `INSERT INTO artifact_versions (
       key, version, content_type, size_bytes, source_run_id, source_stage_id, source_attempt,
       created_at, pinned, relative_path
     ) VALUES (
       @key, 1, 'text/plain', 4, @run, 'summarize', 1, @now, 0, 'linked-out.txt'
     )`,
  ).run({ key, run: runId, now });
}

async function getRecord(store: RunStore, route: string): Promise<{ status: number; body: any }> {
  const url = new URL(route, "http://127.0.0.1");
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body?: string) {
      payload = body ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleArtifactRoutes(
    {} as IncomingMessage,
    "GET",
    url.pathname,
    url,
    store,
    res,
    json,
  );
  expect(handled).toBe(true);
  return { status, body: payload ? JSON.parse(payload) : undefined };
}

describe("indexed artifacts follow run retention", () => {
  it("expires only the files slim drops, leaves a published row, and keeps expired_at", async () => {
    const project = await temp("sf-art-slim-proj-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const hugeBytes = 1024 * 1024 + 64;
    const runId = await indexFiles(
      store,
      { "small.txt": "tiny", "huge.bin": Buffer.alloc(hugeBytes, 1) },
      project,
    );
    const projectId = (
      db.prepare(`SELECT project_root_id FROM artifacts LIMIT 1`).get() as { project_root_id: string }
    ).project_root_id;
    const artifactsDir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    await writeFile(path.join(project, "outside.txt"), Buffer.alloc(hugeBytes, 2));
    await symlink(path.join(project, "outside.txt"), path.join(artifactsDir, "linked-out.txt"));
    insertPublished(db, runId, projectId);
    insertEscape(db, runId, projectId);
    finish(db, runId, new Date(now.getTime() - 4 * DAY_MS).toISOString());

    const firstAt = "2026-06-01T00:00:00.000Z";
    const secondAt = "2026-06-02T00:00:00.000Z";
    await store.markSlimmedIndexedArtifacts(runId, 1024 * 1024, firstAt);
    await store.markSlimmedIndexedArtifacts(runId, 1024 * 1024, secondAt);
    const hugeId = artifactIdFromRelative("huge.bin");
    const smallId = artifactIdFromRelative("small.txt");
    expect(stateFor(db, hugeId)).toMatchObject({
      status: "expired",
      expired_reason: "run_slimmed",
      expired_at: firstAt,
    });
    expect(stateFor(db, smallId).status).toBe("available");
    expect(stateFor(db, "published-keep")).toMatchObject({ origin: "published", status: "available", expired_at: null });
    expect(stateFor(db, "linked-out").status).toBe("available");
    expect(existsSync(path.join(artifactsDir, "huge.bin"))).toBe(true);

    const report = await runRetentionSweep(store, a2a, { now, execute: true });
    expect(report.slimmed).toEqual([runId]);
    expect(stateFor(db, hugeId).expired_at).toBe(firstAt);
    expect(stateFor(db, smallId)).toMatchObject({ status: "available", expired_reason: null });
    expect(stateFor(db, "published-keep").status).toBe("available");
    expect(stateFor(db, "linked-out")).toMatchObject({ status: "expired", expired_reason: "file_missing" });
    expect(existsSync(path.join(artifactsDir, "huge.bin"))).toBe(false);
    expect(existsSync(path.join(artifactsDir, "small.txt"))).toBe(true);

    const again = await runRetentionSweep(store, a2a, { now, execute: true });
    expect(again.slimmed).toEqual([]);
    expect(stateFor(db, hugeId).expired_at).toBe(firstAt);
    expect(stateFor(db, "linked-out").expired_at).not.toBeNull();
    const escapeAt = stateFor(db, "linked-out").expired_at;
    await store.repairMissingIndexedArtifacts(secondAt, 100);
    expect(stateFor(db, "linked-out").expired_at).toBe(escapeAt);
    await store.close();
  });

  it("expires every indexed artifact on purge and on delete, and still removes the run if the index update throws", async () => {
    const project = await temp("sf-art-purge-proj-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const purgedId = await indexFiles(store, { "one.txt": "a", "two.txt": "b" }, project);
    const projectId = (db.prepare(`SELECT project_root_id FROM artifacts LIMIT 1`).get() as { project_root_id: string }).project_root_id;
    insertPublished(db, purgedId, projectId);
    const workspace = store.getWorkspaceDir(purgedId);
    finish(db, purgedId, new Date(now.getTime() - 31 * DAY_MS).toISOString());
    const keptId = await indexFiles(store, { "keep.txt": "k" }, project);
    finish(db, keptId, now.toISOString());
    let sawWorkspace = false;
    const original = store.markIndexedArtifactsExpired.bind(store);
    (store as { markIndexedArtifactsExpired: RunStore["markIndexedArtifactsExpired"] }).markIndexedArtifactsExpired =
      async (runId, reason, at) => {
        if (existsSync(workspace)) sawWorkspace = true;
        return original(runId, reason, at);
      };

    const report = await runRetentionSweep(store, a2a, { now, execute: true });
    expect(report.purged).toContain(purgedId);
    expect(sawWorkspace).toBe(true);
    expect(existsSync(workspace)).toBe(false);
    const purgedRow = stateFor(db, artifactIdFromRelative("one.txt"));
    expect(purgedRow).toMatchObject({
      status: "expired",
      expired_reason: "run_purged",
    });
    expect(purgedRow.expired_at).toEqual(expect.any(String));
    expect(stateFor(db, artifactIdFromRelative("keep.txt"))).toMatchObject({
      status: "available",
      expired_at: null,
      expired_reason: null,
    });
    expect(stateFor(db, artifactIdFromRelative("two.txt")).expired_reason).toBe("run_purged");
    expect(stateFor(db, "published-keep")).toMatchObject({ status: "available", expired_at: null });
    await expect(store.readRun(purgedId)).rejects.toThrow(/Run not found/);

    const deletedId = await indexFiles(store, { "gone.txt": "c" }, project);
    const deletedWorkspace = store.getWorkspaceDir(deletedId);
    let deleteSawWorkspace = false;
    (store as { markIndexedArtifactsExpired: RunStore["markIndexedArtifactsExpired"] }).markIndexedArtifactsExpired =
      async (runId, reason, at) => {
        if (runId === deletedId && existsSync(deletedWorkspace)) deleteSawWorkspace = true;
        return original(runId, reason, at);
      };
    await deleteRunEverywhere(store, a2a, deletedId);
    expect(deleteSawWorkspace).toBe(true);
    expect(existsSync(deletedWorkspace)).toBe(false);
    expect(stateFor(db, artifactIdFromRelative("gone.txt"))).toMatchObject({
      status: "expired",
      expired_reason: "run_deleted",
    });
    expect(stateFor(db, "published-keep").status).toBe("available");
    await store.close();
  });

  it("does not abort a sweep when the artifact index update throws, and a missing run does not fail it", async () => {
    const project = await temp("sf-art-fail-proj-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const slimId = await indexFiles(store, { "huge.bin": Buffer.alloc(1024 * 1024 + 8, 3) }, project);
    finish(db, slimId, new Date(now.getTime() - 4 * DAY_MS).toISOString());
    const hugePath = path.join(attemptArtifactsDir(store.getWorkspaceDir(slimId), "summarize", 1), "huge.bin");
    (store as { markSlimmedIndexedArtifacts: RunStore["markSlimmedIndexedArtifacts"] }).markSlimmedIndexedArtifacts =
      async () => {
        throw new Error("index down");
      };
    const slimmed = await runRetentionSweep(store, a2a, {
      now,
      execute: true,
      artifactRepairBatch: 0,
    });
    expect(slimmed.slimmed).toEqual([slimId]);
    expect(existsSync(hugePath)).toBe(false);
    expect(stateFor(db, artifactIdFromRelative("huge.bin")).status).toBe("available");

    const first = await indexFiles(store, { "a.txt": "a" }, project);
    const second = await indexFiles(store, { "b.txt": "b" }, project);
    finish(db, first, new Date(now.getTime() - 40 * DAY_MS).toISOString());
    finish(db, second, new Date(now.getTime() - 40 * DAY_MS).toISOString());
    const deleteRun = store.deleteRun.bind(store);
    (store as { deleteRun: RunStore["deleteRun"] }).deleteRun = async (runId) => {
      if (runId === first) throw new Error(`Run not found: ${runId}`);
      return deleteRun(runId);
    };
    const purged = await runRetentionSweep(store, a2a, { now, execute: true, artifactRepairBatch: 0 });
    expect(purged.purged).toEqual(expect.arrayContaining([first, second]));
    expect(stateFor(db, artifactIdFromRelative("a.txt")).expired_reason).toBe("run_purged");
    await expect(store.readRun(second)).rejects.toThrow(/Run not found/);
    await expect(store.markIndexedArtifactsExpired("missing-run", "run_deleted", now.toISOString())).resolves.toBeUndefined();
    await expect(store.repairMissingIndexedArtifacts(now.toISOString(), 10)).resolves.toBeUndefined();

    const doomed = await indexFiles(store, { "c.txt": "c" }, project);
    finish(db, doomed, new Date(now.getTime() - 40 * DAY_MS).toISOString());
    (store as { markIndexedArtifactsExpired: RunStore["markIndexedArtifactsExpired"] }).markIndexedArtifactsExpired =
      async () => {
        throw new Error("index down");
      };
    (store as { deleteRun: RunStore["deleteRun"] }).deleteRun = deleteRun;
    const still = await runRetentionSweep(store, a2a, { now, execute: true, artifactRepairBatch: 0 });
    expect(still.purged).toContain(doomed);
    await expect(store.readRun(doomed)).rejects.toThrow(/Run not found/);
    expect(stateFor(db, artifactIdFromRelative("c.txt")).status).toBe("available");
    await store.close();
  });

  it("repairs a bounded batch of missing files on terminal runs only", async () => {
    const project = await temp("sf-art-repair-proj-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const ids: string[] = [];
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      const runId = await indexFiles(store, { [name]: name }, project);
      await unlink(path.join(attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1), name));
      await store.updateRunStatus(runId, "succeeded");
      ids.push(runId);
    }
    const running = await indexFiles(store, { "live.txt": "live" }, project);
    await unlink(path.join(attemptArtifactsDir(store.getWorkspaceDir(running), "summarize", 1), "live.txt"));

    const once = await runRetentionSweep(store, a2a, { now, execute: true, artifactRepairBatch: 1 });
    expect(once.slimmed).toEqual([]);
    expect(once.purged).toEqual([]);
    const expired = () => states(db).filter((row) => row.expired_reason === "file_missing");
    expect(expired()).toHaveLength(1);
    expect(stateFor(db, artifactIdFromRelative("live.txt")).status).toBe("available");
    const firstAt = expired()[0]!.expired_at;
    await runRetentionSweep(store, a2a, { now, execute: true, artifactRepairBatch: 1 });
    expect(expired()).toHaveLength(2);
    expect(expired().find((row) => row.expired_at === firstAt)?.expired_at).toBe(firstAt);
    await runRetentionSweep(store, a2a, { now, execute: true, artifactRepairBatch: 1 });
    expect(expired()).toHaveLength(3);
    expect(stateFor(db, artifactIdFromRelative("live.txt")).status).toBe("available");
    expect(ids).toHaveLength(3);
    await store.close();
  });

  it("repairs missing files past the first batch and a row whose run is gone", async () => {
    const project = await temp("sf-art-repair-rotate-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const runId = await indexFiles(store, { "seed.txt": "seed" }, project);
    await store.updateRunStatus(runId, "succeeded");
    const projectId = (
      db.prepare(`SELECT project_root_id FROM artifacts WHERE source_run_id = ? LIMIT 1`).get(runId) as {
        project_root_id: string;
      }
    ).project_root_id;
    const dir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    const stamp = "2026-01-01T00:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, source_run_id, source_stage_id, source_attempt, hidden,
         status, created_at, updated_at
       ) VALUES (
         @key, 'stage', 'sales', 'summarize', @project, @id, @title, '[]',
         'static.text', 'indexed', 1, @run, 'summarize', 1, 0,
         'available', @now, @now
       )`,
    );
    const version = db.prepare(
      `INSERT INTO artifact_versions (
         key, version, content_type, size_bytes, source_run_id, source_stage_id, source_attempt,
         created_at, pinned, relative_path
       ) VALUES (
         @key, 1, 'text/plain', 1, @run, 'summarize', 1, @now, 0, @relative
       )`,
    );
    for (let index = 0; index < 102; index += 1) {
      const id = `p${String(index).padStart(4, "0")}`;
      const key = `${projectId}::repair/${id}`;
      const relative = `${id}.txt`;
      insert.run({ key, id, title: relative, project: projectId, run: runId, now: stamp });
      version.run({ key, run: runId, now: stamp, relative });
      if (index < 100) await writeFile(path.join(dir, relative), "x");
    }
    insert.run({
      key: `${projectId}::repair/run-gone`,
      id: "run-gone",
      title: "gone.txt",
      project: projectId,
      run: "missing-run-row",
      now: stamp,
    });
    version.run({
      key: `${projectId}::repair/run-gone`,
      run: "missing-run-row",
      now: stamp,
      relative: "gone.txt",
    });

    await runRetentionSweep(store, a2a, { now, execute: true });
    expect(stateFor(db, "p0100").status).toBe("available");
    expect(stateFor(db, "p0101").status).toBe("available");
    expect(stateFor(db, "run-gone").status).toBe("available");

    await runRetentionSweep(store, a2a, { now, execute: true });
    expect(stateFor(db, "p0100")).toMatchObject({ status: "expired", expired_reason: "file_missing" });
    expect(stateFor(db, "p0101")).toMatchObject({ status: "expired", expired_reason: "file_missing" });
    expect(stateFor(db, "run-gone")).toMatchObject({ status: "expired", expired_reason: "run_deleted" });
    expect(stateFor(db, "p0000")).toMatchObject({ status: "available", expired_reason: null });
    const missingAt = stateFor(db, "p0100").expired_at;
    const goneAt = stateFor(db, "run-gone").expired_at;
    expect(missingAt).not.toBeNull();

    await runRetentionSweep(store, a2a, { now, execute: true });
    expect(stateFor(db, "p0100").expired_at).toBe(missingAt);
    expect(stateFor(db, "run-gone").expired_at).toBe(goneAt);
    await store.repairMissingIndexedArtifacts(now.toISOString(), 100);
    expect(stateFor(db, "p0100").expired_at).toBe(missingAt);
    expect(stateFor(db, "run-gone").expired_at).toBe(goneAt);
    await store.close();
  });

  it("restores run_slimmed rows whose files remain when slim fails", async () => {
    const project = await temp("sf-art-slim-fail-");
    const { store, db, root } = await openStore();
    const a2a = new A2aStore(root, db);
    const now = new Date("2026-06-01T00:00:00.000Z");
    const huge = Buffer.alloc(1024 * 1024 + 32, 7);
    const runId = await indexFiles(store, { "huge-a.bin": huge, "huge-b.bin": huge, "small.txt": "ok" }, project);
    finish(db, runId, new Date(now.getTime() - 4 * DAY_MS).toISOString());
    const dir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1);
    const droppedId = artifactIdFromRelative("huge-a.bin");
    const keptId = artifactIdFromRelative("huge-b.bin");
    let markedBeforeRemove = false;
    const report = await runRetentionSweep(store, a2a, {
      now,
      execute: true,
      slimWorkspace: async () => {
        markedBeforeRemove = stateFor(db, keptId).status === "expired";
        await unlink(path.join(dir, "huge-a.bin"));
        return false;
      },
    });
    expect(markedBeforeRemove).toBe(true);
    expect(report.slimmed).toEqual([]);
    expect(existsSync(path.join(dir, "huge-a.bin"))).toBe(false);
    expect(existsSync(path.join(dir, "huge-b.bin"))).toBe(true);
    expect(stateFor(db, droppedId)).toMatchObject({ status: "expired", expired_reason: "run_slimmed" });
    expect(stateFor(db, keptId)).toMatchObject({ status: "available", expired_at: null, expired_reason: null });
    expect(stateFor(db, artifactIdFromRelative("small.txt")).status).toBe("available");
    await store.close();
  });

  it("sets expires_at once from the run retention window for succeeded and failed runs", async () => {
    const project = await temp("sf-art-exp-proj-");
    const { store, db } = await openStore();
    const succeeded = await indexFiles(store, { "ok.txt": "ok" }, project);
    const okId = artifactIdFromRelative("ok.txt");
    expect(stateFor(db, okId).expires_at).toBeNull();
    process.env.STAGEFLOW_PURGE_SUCCEEDED_MS = "123456";
    await store.updateRunStatus(succeeded, "succeeded");
    const finished = (await store.readRunMeta(succeeded)).finished_at;
    expect(finished).toBeTruthy();
    const stamped = indexedExpiresAt("succeeded", finished ?? null);
    expect(stateFor(db, okId).expires_at).toBe(stamped);
    expect(Date.parse(stamped!) - Date.parse(finished!)).toBe(retentionWindowsFromEnv().succeeded.purgeMs);

    process.env.STAGEFLOW_PURGE_SUCCEEDED_MS = "1";
    await store.updateRunStatus(succeeded, "succeeded");
    await store.writeEnvelope(succeeded, "summarize", {
      status: "success",
      summary: "again",
      artifacts: ["ok.txt"],
      payload: {},
    }, { attempt: 1 });
    expect(stateFor(db, okId).expires_at).toBe(stamped);

    delete process.env.STAGEFLOW_PURGE_FAILED_MS;
    const failed = await indexFiles(store, { "bad.txt": "bad" }, project);
    await store.updateRunStatus(failed, "failed");
    const failedAt = (await store.readRunMeta(failed)).finished_at!;
    const failedExpires = stateFor(db, artifactIdFromRelative("bad.txt")).expires_at;
    expect(failedExpires).toBe(indexedExpiresAt("failed", failedAt));
    expect(Date.parse(failedExpires!) - Date.parse(failedAt)).toBe(retentionWindowsFromEnv().failed.purgeMs);
    expect(retentionWindowsFromEnv().failed.purgeMs).not.toBe(123456);
    await store.close();
  });

  it("returns status fields from the API record and filters them in the query layer", async () => {
    const project = await temp("sf-art-api-proj-");
    const { store, db } = await openStore();
    const runId = await indexFiles(store, { "note.txt": "n" }, project);
    const id = artifactIdFromRelative("note.txt");
    const listed = await getRecord(store, "/api/artifacts");
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts[0]).toMatchObject({
      id,
      status: "available",
      expired_at: null,
      expired_reason: null,
      expires_at: null,
    });
    const detail = await getRecord(store, `/api/artifacts/stage:sales:summarize/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("available");
    await store.markIndexedArtifactsExpired(runId, "run_deleted", "2026-04-01T00:00:00.000Z");
    const expired = await getRecord(store, `/api/artifacts/stage:sales:summarize/${id}`);
    expect(expired.body).toMatchObject({
      status: "expired",
      expired_at: "2026-04-01T00:00:00.000Z",
      expired_reason: "run_deleted",
    });

    const page = listArtifacts(db, { limit: 50, status: "expired" }, []);
    expect(page.artifacts.map((row) => row.id)).toEqual([id]);
    expect(listArtifacts(db, { limit: 50, status: "available" }, []).artifacts).toEqual([]);
    expect(parseArtifactStatus(null)).toBeUndefined();
    expect(parseArtifactStatus("")).toBeUndefined();
    expect(() => parseArtifactStatus("stale")).toThrow(ArtifactQueryError);
    await store.close();
  });

  it("adds retention columns on a fresh store and on a store that was at version 23", async () => {
    const freshRoot = await temp("sf-art-m24-fresh-");
    const fresh = createRunStore({ rootDir: freshRoot, kind: "sqlite" });
    const freshDb = sqliteConnectionFromStore(fresh)!;
    expect(freshDb.pragma("user_version", { simple: true })).toBe(26);
    const freshCols = freshDb.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
    expect(freshCols.map((col) => col.name)).toEqual(expect.arrayContaining(["status", "expired_at", "expired_reason"]));
    expect(
      freshDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifacts_indexed_run_status'`).get(),
    ).toBeTruthy();
    await fresh.close();

    const project = await temp("sf-art-m24-proj-");
    const existingRoot = await temp("sf-art-m24-old-");
    const existing = createRunStore({ rootDir: existingRoot, kind: "sqlite" });
    const runId = await indexFiles(existing, { "kept.txt": "k" }, project);
    await existing.close();
    const dbPath = path.join(storeRootFor(existingRoot), "state.db");
    const db = new Database(dbPath);
    db.exec(`DROP INDEX IF EXISTS artifacts_indexed_run_status`);
    db.exec(`ALTER TABLE artifacts DROP COLUMN expired_reason`);
    db.exec(`ALTER TABLE artifacts DROP COLUMN expired_at`);
    db.exec(`ALTER TABLE artifacts DROP COLUMN status`);
    db.prepare(`DELETE FROM schema_migrations WHERE version >= 24`).run();
    db.pragma("user_version = 23");
    db.close();

    const migrated = createRunStore({ rootDir: existingRoot, kind: "sqlite" });
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(26);
    const row = migratedDb
      .prepare(`SELECT status, expired_at, expired_reason, source_run_id FROM artifacts`)
      .get() as { status: string; expired_at: string | null; expired_reason: string | null; source_run_id: string };
    expect(row).toEqual({
      status: "available",
      expired_at: null,
      expired_reason: null,
      source_run_id: runId,
    });
    await migrated.close();
  });
});
