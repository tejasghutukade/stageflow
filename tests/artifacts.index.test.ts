import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { setArtifactHashMaxBytesForTests, titlesForDeliverables } from "../src/artifacts/indexDeclared.js";
import { inferStaticKind } from "../src/artifacts/kinds.js";
import { ARTIFACT_ID_PATTERN, artifactIdFromRelative, artifactStorageKey } from "../src/artifacts/keys.js";
import { setArtifactCatalogRootsForTests } from "../src/artifacts/projectScope.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";
import { startTestService } from "./helpers/testInProcessService.js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { applySchemaThrough } from "./helpers/schemaAtVersion.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  setArtifactHashMaxBytesForTests(undefined);
  setArtifactCatalogRootsForTests(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix)).then((dir) => {
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

async function openStore(): Promise<RunStore> {
  const root = await temp("sf-artifacts-");
  const store = createRunStore({ rootDir: root, kind: "sqlite" });
  cleanups.push(async () => {
    await store.close();
  });
  return store;
}

async function indexFiles(
  store: RunStore,
  options: {
    projectRoot: string;
    pipelineId?: string;
    stageId?: string;
    files: Record<string, string>;
    artifacts?: string[];
    status?: "success" | "failure";
  },
): Promise<string> {
  const stageId = options.stageId ?? "summarize";
  const created = await store.createRun({
    pipelineId: options.pipelineId ?? "sales",
    taskYaml: "id: t\ngoal: g\n",
    projectRoot: options.projectRoot,
  });
  await store.createStageExecution(created.runId, stageId);
  const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
  await mkdir(dir, { recursive: true });
  for (const [rel, body] of Object.entries(options.files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run(options.projectRoot, created.runId);
  await store.writeEnvelope(
    created.runId,
    stageId,
    {
      status: options.status ?? "success",
      summary: "ok",
      artifacts: options.artifacts ?? Object.keys(options.files),
      payload: {},
    },
    { attempt: 1 },
  );
  return created.runId;
}

function rows(store: RunStore): Array<{ id: string; kind: string; origin: string; project_root_id: string; title: string }> {
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("expected sqlite");
  return db
    .prepare(
      `SELECT id, kind, origin, project_root_id, title FROM artifacts ORDER BY id ASC`,
    )
    .all() as Array<{ id: string; kind: string; origin: string; project_root_id: string; title: string }>;
}

function captureResponse(): { res: ServerResponse; read: () => { status: number; body: any } } {
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
  return {
    res,
    read: () => ({ status, body: payload ? JSON.parse(payload) : undefined }),
  };
}

async function getArtifacts(
  store: RunStore,
  route: string,
): Promise<{ status: number; body: any }> {
  const url = new URL(route, "http://127.0.0.1");
  const captured = captureResponse();
  const handled = await handleArtifactRoutes(
    {} as IncomingMessage,
    "GET",
    url.pathname,
    url,
    store,
    captured.res,
    json,
  );
  expect(handled).toBe(true);
  return captured.read();
}

describe("artifact index", () => {
  it("indexes the three envelope paths and leaves a spill file in the same folder out", async () => {
    const root = await temp("sf-art-proj-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: {
        "report.md": "# report",
        "numbers.csv": "a,b\n1,2\n",
        "shot.png": "png",
        "tool-output/spill.json": "{}",
        "notes.txt": "not listed",
      },
      artifacts: ["report.md", "numbers.csv", "shot.png"],
    });
    const indexed = rows(store);
    expect(indexed).toHaveLength(3);
    expect(indexed.map((row) => row.id).sort()).toEqual(
      ["numbers.csv", "report.md", "shot.png"].map((file) => artifactIdFromRelative(file)).sort(),
    );
    expect(indexed.every((row) => row.origin === "indexed")).toBe(true);
    expect(indexed.find((row) => row.id === artifactIdFromRelative("report.md"))?.title).toBe("report.md");
    const db = sqliteConnectionFromStore(store)!;
    const sources = db.prepare(`SELECT source_run_id FROM artifacts`).all() as Array<{ source_run_id: string }>;
    expect(sources.every((row) => row.source_run_id === runId)).toBe(true);
    const envelope = await store.readEnvelope(runId, "summarize");
    expect(envelope.artifacts).toEqual(["report.md", "numbers.csv", "shot.png"]);
  });

  it("does not index tool-output, .pi-agent, auth.json, or paths the guard denies", async () => {
    const root = await temp("sf-art-deny-");
    const store = await openStore();
    await store.ensureProject(root);
    await indexFiles(store, {
      projectRoot: root,
      files: {
        "kept.md": "ok",
        "tool-output/spill.json": "{}",
        ".pi-agent/session.txt": "secret",
        "auth.json": "{}",
      },
      artifacts: [
        "kept.md",
        "tool-output/spill.json",
        ".pi-agent/session.txt",
        "auth.json",
        "../escape.md",
        "/etc/passwd",
      ],
    });
    expect(rows(store).map((row) => row.id)).toEqual([artifactIdFromRelative("kept.md")]);
  });

  it("infers static kinds from the extension", () => {
    const table: Array<[string, string]> = [
      ["a.md", "static.markdown"],
      ["a.markdown", "static.markdown"],
      ["a.png", "static.image"],
      ["a.jpg", "static.image"],
      ["a.jpeg", "static.image"],
      ["a.gif", "static.image"],
      ["a.webp", "static.image"],
      ["a.csv", "static.table"],
      ["a.json", "static.table"],
      ["a.html", "static.html"],
      ["a.htm", "static.html"],
      ["a.txt", "static.text"],
      ["a.yaml", "static.text"],
      ["README", "static.text"],
    ];
    for (const [file, kind] of table) expect(inferStaticKind(file)).toBe(kind);
  });

  it("resolves an absolute path, a wire id and a seeded id to one canonical id, and keeps an unregistered root", async () => {
    const real = await temp("sf-art-seed-");
    const linkParent = await temp("sf-art-link-");
    const link = path.join(linkParent, "examples-link");
    await symlink(real, link);
    const seeded: CatalogRoot = {
      project_root: "examples",
      path: real,
      kind: "seeded",
      read_only: true,
    };
    setArtifactCatalogRootsForTests([seeded]);
    const store = await openStore();
    await indexFiles(store, { projectRoot: real, stageId: "a", files: { "one.md": "1" } });
    await indexFiles(store, { projectRoot: link, stageId: "b", files: { "two.md": "2" } });
    await indexFiles(store, { projectRoot: "examples", stageId: "c", files: { "three.md": "3" } });
    const indexed = rows(store);
    expect(indexed.map((row) => row.project_root_id)).toEqual(["examples", "examples", "examples"]);

    const gone = "/tmp/stageflow-unregistered-artifact-root";
    setArtifactCatalogRootsForTests(undefined);
    await indexFiles(store, { projectRoot: gone, stageId: "d", files: { "four.md": "4" } });
    const listed = await getArtifacts(store, `/api/artifacts?project_root=${encodeURIComponent(gone)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts).toHaveLength(1);
    expect(listed.body.artifacts[0].project).toEqual({ id: gone, registered: false });
    expect(listed.body.artifacts[0].title).toBe("four.md");
  });

  it("keeps two projects with the same stage apart and returns artifact.ambiguous without project_root", async () => {
    const alpha = await temp("sf-art-a-");
    const beta = await temp("sf-art-b-");
    const store = await openStore();
    await store.ensureProject(alpha);
    await store.ensureProject(beta);
    const runA = await indexFiles(store, { projectRoot: alpha, files: { "report.md": "a" } });
    const runB = await indexFiles(store, { projectRoot: beta, files: { "report.md": "b" } });
    const indexed = rows(store);
    expect(new Set(indexed.map((row) => row.project_root_id)).size).toBe(2);
    const reportId = artifactIdFromRelative("report.md");
    expect(indexed.map((row) => row.id)).toEqual([reportId, reportId]);

    const ambiguous = await getArtifacts(store, `/api/artifacts/stage:sales:summarize/${reportId}`);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe("artifact.ambiguous");
    expect(ambiguous.body.project_roots.sort()).toEqual([realpathSync(alpha), realpathSync(beta)].sort());

    const one = await getArtifacts(
      store,
      `/api/artifacts/stage:sales:summarize/${reportId}?project_root=${encodeURIComponent(alpha)}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.source.run_id).toBe(runA);
    expect(one.body.owner).toEqual({ kind: "stage", pipeline: "sales", stage: "summarize" });

    const scoped = await getArtifacts(store, `/api/artifacts?project_root=${encodeURIComponent(beta)}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.artifacts.map((row: { source: { run_id: string } }) => row.source.run_id)).toEqual([runB]);
  });

  it("rejects the reserved key separator inside ids", async () => {
    expect(() => artifactStorageKey("/proj", "stage:sales:summarize", "a::b")).toThrow(/must not contain "::"/);
    const root = await temp("sf-art-sep-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      pipelineId: "bad::pipe",
      files: { "report.md": "x" },
    });
    expect(rows(store)).toEqual([]);
    expect((await store.readEnvelope(runId, "summarize")).status).toBe("success");
    const rejected = await getArtifacts(store, "/api/artifacts/stage:sales:summarize/a::b");
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("artifact.invalid_id");
    const project = await getArtifacts(store, "/api/artifacts?project_root=foo::bar");
    expect(project.status).toBe(400);
    expect(project.body.code).toBe("artifact.invalid_id");
  });

  it("does not fail the run when indexing throws", async () => {
    const root = await temp("sf-art-fail-");
    const store = await openStore();
    await store.ensureProject(root);
    const db = sqliteConnectionFromStore(store)!;
    db.exec(`DROP TABLE artifact_versions; DROP TABLE artifacts;`);
    const runId = await indexFiles(store, { projectRoot: root, files: { "report.md": "x" } });
    expect((await store.readEnvelope(runId, "summarize")).artifacts).toEqual(["report.md"]);
    expect((await store.readRunMeta(runId)).run_id).toBe(runId);
  });

  it("does not index a failure envelope", async () => {
    const root = await temp("sf-art-failure-");
    const store = await openStore();
    await store.ensureProject(root);
    await indexFiles(store, {
      projectRoot: root,
      files: { "report.md": "x" },
      status: "failure",
    });
    expect(rows(store)).toEqual([]);
  });

  it("applies the artifact migration on a fresh store and on a store that was at version 22", async () => {
    const freshRoot = await temp("sf-art-fresh-");
    const fresh = createRunStore({ rootDir: freshRoot, kind: "sqlite" });
    const freshDb = sqliteConnectionFromStore(fresh)!;
    expect(freshDb.pragma("user_version", { simple: true })).toBe(29);
    expect(
      freshDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('artifacts', 'artifact_versions')`).all(),
    ).toHaveLength(2);
    await fresh.close();

    const existingRoot = await temp("sf-art-existing-");
    const dbPath = path.join(storeRootFor(existingRoot), "state.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    applySchemaThrough(db, 22);
    const runId = "run-kept";
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
       VALUES (?, 'sales', 'id: t\ngoal: g\n', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(runId);
    db.close();
    const migrated = createRunStore({ rootDir: existingRoot, kind: "sqlite" });
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(29);
    expect(migratedDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifacts'`).get()).toBeTruthy();
    expect(migratedDb.prepare(`SELECT run_id FROM runs`).all()).toEqual([{ run_id: runId }]);
    await migrated.close();
  });

  it("lists artifacts for one project over HTTP", async () => {
    const alpha = await temp("sf-art-http-a-");
    const beta = await temp("sf-art-http-b-");
    const store = await openStore();
    await store.ensureProject(alpha);
    await store.ensureProject(beta);
    await indexFiles(store, { projectRoot: alpha, files: { "report.md": "a" } });
    await indexFiles(store, { projectRoot: beta, files: { "other.md": "b" } });
    const service = await startTestService(store, scriptedFakeAgent([]), alpha);
    cleanups.push(() => service.stop());
    const response = await fetch(
      `${service.baseUrl}/api/artifacts?project_root=${encodeURIComponent(alpha)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { artifacts: Array<{ id: string; project: { id: string } }> };
    expect(body.artifacts.map((row) => row.id)).toEqual([artifactIdFromRelative("report.md")]);
    expect(body.artifacts[0]?.project.registered).toBe(true);
  });

  it("gives distinct stable ids to paths that used to share a slug", () => {
    const pairs: Array<[string, string]> = [
      ["a/b.md", "a-b.md"],
      ["docs/report.md", "notes/report.md"],
      ["report.md", "report.csv"],
    ];
    for (const [left, right] of pairs) {
      expect(artifactIdFromRelative(left)).not.toBe(artifactIdFromRelative(right));
    }
    const longA = `${"a".repeat(80)}.md`;
    const longB = `${"a".repeat(80)}.csv`;
    expect(artifactIdFromRelative(longA)).not.toBe(artifactIdFromRelative(longB));
    expect(artifactIdFromRelative(longA).length).toBeLessThanOrEqual(64);
    const nasty = ["报告.md", "café.md", "1.md", "a::b.md", ".hidden", "README", longA];
    for (const name of nasty) {
      const id = artifactIdFromRelative(name);
      expect(id).toMatch(ARTIFACT_ID_PATTERN);
      expect(id.includes("::")).toBe(false);
      expect(artifactIdFromRelative(name)).toBe(id);
    }
    expect(titlesForDeliverables(["docs/report.md", "notes/report.md"])).toEqual([
      "docs/report.md",
      "notes/report.md",
    ]);
    expect(titlesForDeliverables(["report.md", "report.csv"])).toEqual(["report.md", "report.csv"]);
  });

  it("drops indexed rows that a later envelope for the same attempt no longer lists", async () => {
    const root = await temp("sf-art-stale-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: { "a.md": "a", "b.md": "b", "c.md": "c" },
    });
    expect(rows(store)).toHaveLength(3);
    await store.writeEnvelope(runId, "summarize", {
      status: "success",
      summary: "shorter",
      artifacts: ["a.md"],
      payload: {},
    }, { attempt: 1 });
    const left = rows(store);
    expect(left.map((row) => row.id)).toEqual([artifactIdFromRelative("a.md")]);

    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE artifacts SET origin = 'published' WHERE id = ?`).run(artifactIdFromRelative("a.md"));
    await store.writeEnvelope(runId, "summarize", {
      status: "success",
      summary: "empty",
      artifacts: [],
      payload: {},
    }, { attempt: 1 });
    expect(rows(store).map((row) => row.origin)).toEqual(["published"]);
  });

  it("replaces an earlier attempt's live set and clears a failure rewrite", async () => {
    const root = await temp("sf-art-retry-");
    const store = await openStore();
    await store.ensureProject(root);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: { "a.md": "a", "b.md": "b" },
    });
    const second = await store.createStageExecution(runId, "summarize");
    const dir = attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", second.attempt);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "a.md"), "a2");
    await store.writeEnvelope(runId, "summarize", {
      status: "success",
      summary: "retry",
      artifacts: ["a.md"],
      payload: {},
    }, { attempt: second.attempt });
    const db = sqliteConnectionFromStore(store)!;
    const live = db.prepare(`SELECT id, source_attempt FROM artifacts`).all() as Array<{ id: string; source_attempt: number }>;
    expect(live).toEqual([{ id: artifactIdFromRelative("a.md"), source_attempt: second.attempt }]);

    await store.writeEnvelope(runId, "summarize", {
      status: "failure",
      summary: "failed",
      artifacts: [],
      payload: {},
    }, { attempt: second.attempt });
    expect(rows(store)).toEqual([]);
  });

  it("indexes a null project_root as the workspace catalog id", async () => {
    const store = await openStore();
    const created = await store.createRun({
      pipelineId: "sales",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createStageExecution(created.runId, "summarize");
    const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), "summarize", 1);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "report.md"), "x");
    await store.writeEnvelope(created.runId, "summarize", {
      status: "success",
      summary: "ok",
      artifacts: ["report.md"],
      payload: {},
    }, { attempt: 1 });
    expect(rows(store).map((row) => row.project_root_id)).toEqual(["workspace"]);

    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE runs SET project_root = ? WHERE run_id = ?`).run("workspace", created.runId);
    await store.writeEnvelope(created.runId, "summarize", {
      status: "success",
      summary: "ok",
      artifacts: ["report.md"],
      payload: {},
    }, { attempt: 1 });
    expect(rows(store).map((row) => row.project_root_id)).toEqual(["workspace"]);
  });

  it("skips hashing a file over the cap and continues when one file is unreadable", async () => {
    const root = await temp("sf-art-hash-");
    const store = await openStore();
    await store.ensureProject(root);
    setArtifactHashMaxBytesForTests(4);
    const runId = await indexFiles(store, {
      projectRoot: root,
      files: { "big.txt": "hello", "small.txt": "ok" },
    });
    const db = sqliteConnectionFromStore(store)!;
    const hashed = db.prepare(
      `SELECT a.id, v.content_hash, v.size_bytes FROM artifacts a JOIN artifact_versions v ON v.key = a.key ORDER BY a.id`,
    ).all() as Array<{ id: string; content_hash: string | null; size_bytes: number }>;
    const big = hashed.find((row) => row.id === artifactIdFromRelative("big.txt"));
    const small = hashed.find((row) => row.id === artifactIdFromRelative("small.txt"));
    expect(big?.size_bytes).toBe(5);
    expect(big?.content_hash).toBeNull();
    expect(small?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await store.readEnvelope(runId, "summarize")).artifacts).toEqual(["big.txt", "small.txt"]);

    const locked = path.join(attemptArtifactsDir(store.getWorkspaceDir(runId), "summarize", 1), "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "secret.txt"), "secret");
    await chmod(locked, 0o000);
    try {
      await store.writeEnvelope(runId, "summarize", {
        status: "success",
        summary: "partial",
        artifacts: ["locked/secret.txt", "small.txt"],
        payload: {},
      }, { attempt: 1 });
      expect(rows(store).map((row) => row.id)).toEqual([artifactIdFromRelative("small.txt")]);
      expect((await store.readEnvelope(runId, "summarize")).status).toBe("success");
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
