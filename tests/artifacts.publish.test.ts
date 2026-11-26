import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactIdFromRelative, artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { ArtifactPublishError, STATIC_CONTENT_MAX_BYTES } from "../src/artifacts/limits.js";
import {
  setPublishCommitFailureForTests,
  setPublishRenameFailureForTests,
  setPublishWriteFailureForTests,
  STALE_STAGING_DIRECTORY_MS,
} from "../src/artifacts/store.js";
import { artifactKeyHash, artifactStoreRoot } from "../src/artifacts/store.js";
import { publishArtifact, setArtifactKeyOperationTraceForTests, setPublishVersionInsertFailureForTests } from "../src/artifacts/publish.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { setPruneFailureForTests } from "../src/artifacts/versions.js";
import { agentProjectKey } from "../src/agents/store.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { attemptArtifactsDir } from "../src/runstore/workspaceLayout.js";
import { json } from "../src/server/createHttpHost.js";
import { decodeBase64, handleArtifactRoutes } from "../src/server/artifactRoutes.js";
import { STATIC_HTML_CONTENT_SECURITY_POLICY } from "../src/artifacts/content.js";
import Database from "better-sqlite3";
import { applySchemaThrough } from "./helpers/schemaAtVersion.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;
const previousCredential = process.env.STAGEFLOW_CREDENTIAL_HOME;
const previousKeep = process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP;

afterEach(async () => {
  setPublishWriteFailureForTests(false);
  setPublishRenameFailureForTests(false);
  setPublishCommitFailureForTests(false);
  setPublishVersionInsertFailureForTests(false);
  setArtifactKeyOperationTraceForTests(undefined);
  setPruneFailureForTests(undefined);
  if (previousKeep === undefined) delete process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP;
  else process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = previousKeep;
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  if (previousCredential === undefined) delete process.env.STAGEFLOW_CREDENTIAL_HOME;
  else process.env.STAGEFLOW_CREDENTIAL_HOME = previousCredential;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore(): Promise<{ store: RunStore; home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-pub-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-pub-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  return { store, home, project: registered };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function request(body?: unknown): IncomingMessage {
  if (body === undefined) return {} as IncomingMessage;
  const payload = Buffer.from(JSON.stringify(body));
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

function captureResponse(): {
  res: ServerResponse;
  read: () => { status: number; body: any; raw: string | Buffer; headers: Record<string, string | number> };
} {
  let status = 0;
  let payload: string | Buffer = "";
  const headers: Record<string, string | number> = {};
  const res = {
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      status = code;
      Object.assign(headers, hdrs ?? {});
    },
    end(body?: string | Buffer) {
      payload = body ?? "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => {
      let body: any;
      if (typeof payload === "string") {
        if (payload.length > 0 && (payload.startsWith("{") || payload.startsWith("["))) {
          try {
            body = JSON.parse(payload);
          } catch {
            body = undefined;
          }
        }
      } else if (payload.length > 0 && payload.length <= 1024 * 1024 && (payload[0] === 0x7b || payload[0] === 0x5b)) {
        try {
          body = JSON.parse(payload.toString("utf8"));
        } catch {
          body = undefined;
        }
      }
      return { status, body, raw: payload, headers };
    },
  };
}

async function call(
  store: RunStore,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string | Buffer; headers: Record<string, string | number> }> {
  const url = new URL(route, "http://127.0.0.1");
  const captured = captureResponse();
  const handled = await handleArtifactRoutes(request(body), method, url.pathname, url, store, captured.res, json);
  expect(handled).toBe(true);
  return captured.read();
}

function stageBody(project: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    project_root: project,
    id: "weekly",
    kind: "static.markdown",
    title: "Weekly",
    content: "# weekly\n",
    ...patch,
  };
  if (body.content_base64 !== undefined && !Object.prototype.hasOwnProperty.call(patch, "content")) {
    delete body.content;
  }
  return body;
}

async function publish(store: RunStore, project: string, patch: Record<string, unknown> = {}) {
  return call(store, "POST", "/api/artifacts", stageBody(project, patch));
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("publish and version artifacts", () => {
  it("publishes each static kind into the keep store", async () => {
    const { store, project } = await openStore();
    const cases: Array<{ id: string; kind: string; body: Record<string, unknown>; text?: string; bytes?: Buffer; type: string }> = [
      { id: "weekly", kind: "static.markdown", body: { content: "# weekly\n" }, text: "# weekly\n", type: "text/plain; charset=utf-8" },
      { id: "shot", kind: "static.image", body: { content_base64: PNG.toString("base64") }, bytes: PNG, type: "image/png" },
      { id: "rows", kind: "static.table", body: { content: "a,b\n1,2\n" }, text: "a,b\n1,2\n", type: "text/plain; charset=utf-8" },
      { id: "rows_json", kind: "static.table", body: { content: '[{"week":1}]' }, text: '[{"week":1}]', type: "text/plain; charset=utf-8" },
      { id: "note", kind: "static.text", body: { content: "hello" }, text: "hello", type: "text/plain; charset=utf-8" },
      { id: "page", kind: "static.html", body: { content: "<p>Hi</p>" }, text: "<p>Hi</p>", type: "text/plain; charset=utf-8" },
    ];
    for (const item of cases) {
      const response = await publish(store, project, { id: item.id, kind: item.kind, title: item.id, ...item.body });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        key: `stage:sales:summarize/${item.id}`,
        version: 1,
        project_root: project,
        unchanged: false,
      });
      const db = sqliteConnectionFromStore(store)!;
      const row = db.prepare(`SELECT origin, source, current_version FROM artifacts WHERE id = ?`).get(item.id) as {
        origin: string;
        source: string;
        current_version: number;
      };
      expect(row).toEqual({ origin: "published", source: "api", current_version: 1 });
      const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), item.id);
      const version = db.prepare(`SELECT content_hash, size_bytes, relative_path, storage FROM artifact_versions WHERE key = ?`).get(storageKey) as {
        content_hash: string;
        size_bytes: number;
        relative_path: string;
        storage: string;
      };
      const bytes = item.bytes ?? Buffer.from(item.text ?? "");
      expect(version.storage).toBe("store");
      expect(version.content_hash).toBe(sha256(bytes));
      expect(version.size_bytes).toBe(bytes.length);
      const file = path.join(artifactStoreRoot(), artifactKeyHash(storageKey), "v1", version.relative_path);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(path.join(path.dirname(file), "manifest.json"))).toBe(true);
      const content = await call(
        store,
        "GET",
        `/api/artifacts/stage:sales:summarize/${item.id}/content?project_root=${encodeURIComponent(project)}`,
      );
      expect(content.status).toBe(200);
      expect(content.headers["Content-Type"]).toBe(item.type);
      expect(content.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(content.headers["X-Artifact-Content-Hash"]).toBe(version.content_hash);
      if (item.kind === "static.html") {
        expect(content.headers["Content-Security-Policy"]).toBe(STATIC_HTML_CONTENT_SECURITY_POLICY);
      }
      expect(Buffer.isBuffer(content.raw) ? content.raw : Buffer.from(String(content.raw))).toEqual(bytes);
    }
  });

  it("rejects invalid publish bodies with stable codes", async () => {
    const { store, project } = await openStore();
    const cases: Array<{ patch: Record<string, unknown>; code: string }> = [
      { patch: { id: "Bad" }, code: "artifact.invalid_id" },
      { patch: { id: "bad::id" }, code: "artifact.invalid_id" },
      { patch: { kind: "live.html" }, code: "artifact.invalid_shape" },
      { patch: { kind: "nope" }, code: "artifact.invalid_kind" },
      { patch: { title: "a".repeat(121) }, code: "artifact.invalid_shape" },
      { patch: { tags: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] }, code: "artifact.invalid_shape" },
      { patch: { tags: ["Hello"] }, code: "artifact.invalid_shape" },
      { patch: { tags: ["has space"] }, code: "artifact.invalid_shape" },
      { patch: { summary: "s".repeat(2001) }, code: "artifact.invalid_shape" },
      { patch: { description: "d".repeat(2001) }, code: "artifact.invalid_shape" },
      { patch: { content: "a".repeat(STATIC_CONTENT_MAX_BYTES + 1) }, code: "artifact.too_large" },
      { patch: { kind: "static.image", content_base64: Buffer.from("not an image").toString("base64") }, code: "artifact.invalid_shape" },
      { patch: { kind: "static.table", content: "a,b\n1\n" }, code: "artifact.invalid_shape" },
      { patch: { kind: "static.table", content: '{"a":1}' }, code: "artifact.invalid_shape" },
      { patch: { kind: "static.text", content_base64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") }, code: "artifact.invalid_shape" },
    ];
    for (const item of cases) {
      const patch = { ...item.patch };
      if (patch.kind === "static.image" || patch.kind === "static.text" && patch.content_base64) {
        delete (patch as { content?: string }).content;
      }
      if (item.patch.content_base64 && item.patch.kind === "static.image") {
        delete (patch as { content?: string }).content;
      }
      const response = await publish(store, project, patch);
      expect(response.status, `${item.code} ${JSON.stringify(response.body)}`).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.body.code).toBe(item.code);
      expect(response.body.issues?.[0]?.path).toBeTruthy();
      if ("description" in item.patch && typeof item.patch.description === "string" && item.patch.description.length > 2000) {
        expect(response.body.issues?.[0]?.path).toBe("description");
      }
    }
  });

  it("rejects an eval: owner on the REST body", async () => {
    const { store, project } = await openStore();
    const response = await publish(store, project, {
      owner: { kind: "stage", pipeline: "eval:sales", stage: "summarize" },
      content: "nope",
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("artifact.invalid_shape");
  });

  it("ignores hidden on the REST body", async () => {
    const { store, project } = await openStore();
    const response = await publish(store, project, { hidden: 1, content: "visible" });
    expect(response.status).toBe(200);
    const db = sqliteConnectionFromStore(store)!;
    expect(db.prepare(`SELECT hidden, source FROM artifacts WHERE id = 'weekly'`).get()).toEqual({
      hidden: 0,
      source: "api",
    });
  });

  it("rolls back version, source, and attempt rows when the insert fails", async () => {
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    setPublishVersionInsertFailureForTests(true);
    await expect(
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "weekly",
        kind: "static.markdown",
        title: "Weekly",
        bytes: Buffer.from("one"),
        publishSource: "api",
        source: { kind: "stage", runId: "run-crash", stageId: "summarize", attempt: 1 },
        roots,
      }),
    ).rejects.toThrow(/injected publish version insert failure/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_versions`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifact_attempt_publishes`).get()).toEqual({ n: 0 });
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey)))).toBe(false);
  });

  it("leaves no version directory or row when the write fails before rename", async () => {
    const { store, project } = await openStore();
    setPublishWriteFailureForTests(true);
    const response = await publish(store, project);
    expect(response.status).toBe(500);
    const db = sqliteConnectionFromStore(store)!;
    expect(db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    expect(existsSync(keyDir)).toBe(false);
  });

  it("returns the current version when the same bytes are published again and keeps v1 immutable", async () => {
    const { store, project } = await openStore();
    const first = await publish(store, project, { content: "one" });
    expect(first.body.version).toBe(1);
    const same = await publish(store, project, { content: "one", title: "Renamed" });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ version: 1, unchanged: true });
    const renamed = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly?project_root=${encodeURIComponent(project)}`,
    );
    expect(renamed.body.title).toBe("Renamed");
    const second = await publish(store, project, { content: "two", title: "Renamed" });
    expect(second.body).toMatchObject({ version: 2, unchanged: false });
    const v1 = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/content?project_root=${encodeURIComponent(project)}&version=1`,
    );
    const v2 = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/content?project_root=${encodeURIComponent(project)}&version=2`,
    );
    const text = (raw: string | Buffer) => (Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
    expect(text(v1.raw)).toBe("one");
    expect(text(v2.raw)).toBe("two");
    const record = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly?project_root=${encodeURIComponent(project)}&version=1`,
    );
    expect(record.body.version).toBe(1);
    expect(record.body.title).toBe("Renamed");
    const missing = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/content?project_root=${encodeURIComponent(project)}&version=9`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("artifact.not_found");
  });

  it("lists versions newest first and prunes to the latest N plus pinned, never the current", async () => {
    const { store, project } = await openStore();
    process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = "2";
    expect((await publish(store, project, { content: "v1" })).body.version).toBe(1);
    const db = sqliteConnectionFromStore(store)!;
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    db.prepare(`UPDATE artifact_versions SET pinned = 1 WHERE key = ? AND version = 1`).run(storageKey);
    expect((await publish(store, project, { content: "v2" })).body.version).toBe(2);
    expect((await publish(store, project, { content: "v3" })).body.version).toBe(3);
    expect((await publish(store, project, { content: "v4" })).body.version).toBe(4);
    const listed = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/versions?project_root=${encodeURIComponent(project)}`,
    );
    expect(listed.body.versions.map((row: { version: number }) => row.version)).toEqual([4, 3, 1]);
    expect(listed.body.versions[0]).toMatchObject({ current: true, pinned: false });
    expect(listed.body.versions[2]).toMatchObject({ version: 1, pinned: true, current: false });
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey), "v2"))).toBe(false);
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey), "v4"))).toBe(true);
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey), "v1"))).toBe(true);

    process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = "1";
    const only = await openStore();
    await publish(only.store, only.project, { content: "a" });
    await publish(only.store, only.project, { content: "b" });
    await publish(only.store, only.project, { content: "c" });
    const left = sqliteConnectionFromStore(only.store)!
      .prepare(`SELECT version FROM artifact_versions ORDER BY version`)
      .all() as Array<{ version: number }>;
    expect(left.map((row) => row.version)).toEqual([3]);
  });

  it("does not fail the publish when pruning throws and rejects a bad keep setting", async () => {
    const { store, project } = await openStore();
    process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = "1";
    await publish(store, project, { content: "a" });
    setPruneFailureForTests(() => {
      throw new Error("prune boom");
    });
    const response = await publish(store, project, { content: "b" });
    expect(response.status).toBe(200);
    expect(response.body.version).toBe(2);
    const versions = sqliteConnectionFromStore(store)!
      .prepare(`SELECT version FROM artifact_versions ORDER BY version`)
      .all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2]);

    for (const value of ["0", "1001", "nope"]) {
      process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = value;
      const bad = await publish(store, project, { id: "other", content: "x" });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("artifact.invalid_shape");
      expect(bad.body.issues[0].path).toBe("STAGEFLOW_ARTIFACT_VERSIONS_KEEP");
    }
  });

  it("deletes a published artifact, refuses an indexed one, and keeps published bytes across run deletion", async () => {
    const { store, project } = await openStore();
    const stageId = "summarize";
    const created = await store.createRun({
      pipelineId: "sales",
      taskYaml: "id: t\ngoal: g\n",
      projectRoot: project,
    });
    await store.createStageExecution(created.runId, stageId);
    const dir = attemptArtifactsDir(store.getWorkspaceDir(created.runId), stageId, 1);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "report.md"), "# indexed\n");
    await writeFile(path.join(dir, "other.md"), "stay indexed\n");
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(`UPDATE runs SET project_root = ?, status = 'succeeded', finished_at = ? WHERE run_id = ?`).run(
      project,
      "2026-11-01T00:00:00.000Z",
      created.runId,
    );
    await store.writeEnvelope(
      created.runId,
      stageId,
      { status: "success", summary: "ok", artifacts: ["report.md", "other.md"], payload: {} },
      { attempt: 1 },
    );
    const indexedId = artifactIdFromRelative("report.md");
    const kept = await publish(store, project, { id: "kept", kind: "static.text", content: "kept bytes", title: "Kept" });
    expect(kept.status).toBe(200);
    const promoted = await publish(store, project, {
      id: indexedId,
      kind: "static.markdown",
      content: "# published over index\n",
      title: "Report",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.version).toBe(2);
    const promotedRow = db.prepare(`SELECT origin, status FROM artifacts WHERE id = ?`).get(indexedId) as {
      origin: string;
      status: string;
    };
    expect(promotedRow).toEqual({ origin: "published", status: "available" });

    const indexedDelete = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/${artifactIdFromRelative("other.md")}?project_root=${encodeURIComponent(project)}`,
    );
    expect(indexedDelete.status).toBe(409);
    expect(indexedDelete.body.code).toBe("artifact.not_deletable");

    await store.markIndexedArtifactsExpired(created.runId, "run_deleted", "2026-11-02T00:00:00.000Z");
    await store.deleteRun(created.runId);
    await store.repairMissingIndexedArtifacts("2026-11-02T00:00:00.000Z");

    const keptRow = db.prepare(`SELECT origin, status FROM artifacts WHERE id = 'kept'`).get() as {
      origin: string;
      status: string;
    };
    expect(keptRow).toEqual({ origin: "published", status: "available" });
    const keptKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "kept");
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(keptKey), "v1"))).toBe(true);
    const stillPromoted = db.prepare(`SELECT origin, status, current_version FROM artifacts WHERE id = ?`).get(indexedId) as {
      origin: string;
      status: string;
      current_version: number;
    };
    expect(stillPromoted.origin).toBe("published");
    expect(stillPromoted.status).toBe("available");
    const promotedKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), indexedId);
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(promotedKey), `v${stillPromoted.current_version}`))).toBe(true);
    const other = db.prepare(`SELECT origin, status FROM artifacts WHERE id = ?`).get(artifactIdFromRelative("other.md")) as {
      origin: string;
      status: string;
    };
    expect(other.origin).toBe("indexed");
    expect(other.status).toBe("expired");

    const removed = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/kept?project_root=${encodeURIComponent(project)}`,
    );
    expect(removed.status).toBe(200);
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(keptKey)))).toBe(false);
    const gone = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/kept?project_root=${encodeURIComponent(project)}`,
    );
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe("artifact.not_found");
  });

  it("scopes publish and delete by project and reports an ambiguous owner", async () => {
    const { store, project } = await openStore();
    const other = await mkdtemp(path.join(tmpdir(), "sf-pub-other-"));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    const registered = await store.ensureProject(other);
    const missing = await publish(store, project, { project_root: undefined });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("artifact.ambiguous");
    const first = await publish(store, project);
    const second = await publish(store, registered, { content: "other project" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const ambiguous = await call(store, "DELETE", "/api/artifacts/stage:sales:summarize/weekly");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe("artifact.ambiguous");
    const one = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/weekly?project_root=${encodeURIComponent(project)}`,
    );
    expect(one.status).toBe(200);
    const remaining = sqliteConnectionFromStore(store)!
      .prepare(`SELECT project_root_id FROM artifacts`)
      .all() as Array<{ project_root_id: string }>;
    expect(remaining.map((row) => row.project_root_id)).toEqual([registered]);
  });

  it("accepts an agent that exists and rejects one that does not", async () => {
    const { store, project } = await openStore();
    const missing = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "agent", agent: "helper" },
      project_root: project,
      id: "weekly",
      kind: "static.text",
      title: "Weekly",
      content: "hi",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("artifact.invalid_shape");
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    const found = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "agent", agent: "helper" },
      project_root: project,
      id: "weekly",
      kind: "static.text",
      title: "Weekly",
      content: "hi",
    });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.key).toBe("agent:helper/weekly");

    const unverifiedHome = await openStore();
    const hidden = sqliteConnectionFromStore(unverifiedHome.store)!;
    hidden.exec(`ALTER TABLE agent_definitions RENAME TO agent_definitions_hidden`);
    const unverified = await call(unverifiedHome.store, "POST", "/api/artifacts", {
      owner: { kind: "agent", agent: "helper" },
      project_root: unverifiedHome.project,
      id: "weekly",
      kind: "static.text",
      title: "Weekly",
      content: "hi",
    });
    expect(unverified.status).toBe(200);
    expect(unverified.body.agent_unverified).toBe(true);
  });

  it("applies migration 026 on a fresh store and on a store that was at version 24", async () => {
    const fresh = await openStore();
    const freshDb = sqliteConnectionFromStore(fresh.store)!;
    expect(freshDb.pragma("user_version", { simple: true })).toBe(31);
    const artifactCols = freshDb.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
    const versionCols = freshDb.prepare(`PRAGMA table_info(artifact_versions)`).all() as Array<{ name: string }>;
    expect(artifactCols.map((col) => col.name)).toContain("source");
    expect(versionCols.map((col) => col.name)).toEqual(expect.arrayContaining(["pinned", "relative_path", "storage"]));
    expect(
      freshDb.prepare(`SELECT name FROM schema_migrations WHERE version IN (25, 26) ORDER BY version`).all(),
    ).toEqual([
      expect.objectContaining({ name: "025_reserved_search" }),
      expect.objectContaining({ name: "026_artifact_publish" }),
    ]);

    await fresh.store.close();
    const home = await mkdtemp(path.join(tmpdir(), "sf-pub-v24-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const dbPath = path.join(home, "state.db");
    const db = new Database(dbPath);
    applySchemaThrough(db, 24);
    db.close();
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
    });
    resetGlobalStageflowHomeForTests();
    const migrated = createRunStore({ rootDir: home });
    cleanups.push(() => migrated.close());
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(31);
    expect((migratedDb.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>).map((col) => col.name)).toContain(
      "source",
    );
    expect(
      (migratedDb.prepare(`PRAGMA table_info(artifact_versions)`).all() as Array<{ name: string }>).map((col) => col.name),
    ).toContain("storage");
  });

  async function directoryNames(storageKey: string): Promise<string[]> {
    const dir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    if (!existsSync(dir)) return [];
    return (await readdir(dir)).sort();
  }

  async function parallelPublish(
    store: RunStore,
    project: string,
    count: number,
    bodyFor: (index: number) => Record<string, unknown>,
  ) {
    return Promise.all(
      Array.from({ length: count }, (_, index) => publish(store, project, bodyFor(index))),
    );
  }

  it("assigns distinct versions for parallel publishes of one key", async () => {
    process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = "100";
    const { store, project } = await openStore();
    const db = sqliteConnectionFromStore(store)!;
    for (const count of [6, 20]) {
      const id = `parallel-${count}`;
      const responses = await parallelPublish(store, project, count, (index) => ({
        id,
        content: `body-${index}\n`,
        title: id,
      }));
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: count }, () => 200));
      const versions = responses.map((response) => response.body.version as number).sort((a, b) => a - b);
      expect(versions).toEqual(Array.from({ length: count }, (_, index) => index + 1));
      const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), id);
      const rows = db
        .prepare(`SELECT version FROM artifact_versions WHERE key = ? ORDER BY version`)
        .all(storageKey) as Array<{ version: number }>;
      expect(rows.map((row) => row.version)).toEqual(versions);
      expect(await directoryNames(storageKey)).toEqual(versions.map((version) => `v${version}`).sort());
      const texts: string[] = [];
      for (let version = 1; version <= count; version++) {
        const content = await call(
          store,
          "GET",
          `/api/artifacts/stage:sales:summarize/${id}/content?project_root=${encodeURIComponent(project)}&version=${version}`,
        );
        expect(content.status).toBe(200);
        texts.push(Buffer.isBuffer(content.raw) ? content.raw.toString("utf8") : String(content.raw));
      }
      expect(texts.sort()).toEqual(Array.from({ length: count }, (_, index) => `body-${index}\n`).sort());
    }
    const existing = await publish(store, project, { id: "existing-distinct", content: "v1" });
    expect(existing.body.version).toBe(1);
    const more = await parallelPublish(store, project, 6, (index) => ({
      id: "existing-distinct",
      content: `next-${index}`,
    }));
    expect(more.every((response) => response.status === 200)).toBe(true);
    expect(more.map((response) => response.body.version).sort((a: number, b: number) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "existing-distinct");
    expect(await directoryNames(storageKey)).toEqual(["v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
    const first = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/existing-distinct/content?project_root=${encodeURIComponent(project)}&version=1`,
    );
    expect(Buffer.isBuffer(first.raw) ? first.raw.toString("utf8") : String(first.raw)).toBe("v1");
  });

  it("returns unchanged for parallel publishes of identical content", async () => {
    process.env.STAGEFLOW_ARTIFACT_VERSIONS_KEEP = "100";
    const { store, project } = await openStore();
    for (const count of [6, 20]) {
      const id = `same-${count}`;
      const responses = await parallelPublish(store, project, count, () => ({
        id,
        content: "same-bytes",
        title: id,
      }));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.filter((response) => response.body.unchanged === false)).toHaveLength(1);
      expect(responses.filter((response) => response.body.unchanged === true)).toHaveLength(count - 1);
      expect(new Set(responses.map((response) => response.body.version))).toEqual(new Set([1]));
      const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), id);
      const db = sqliteConnectionFromStore(store)!;
      const rows = db.prepare(`SELECT version FROM artifact_versions WHERE key = ?`).all(storageKey) as Array<{
        version: number;
      }>;
      expect(rows).toEqual([{ version: 1 }]);
      expect(await directoryNames(storageKey)).toEqual(["v1"]);
      const content = await call(
        store,
        "GET",
        `/api/artifacts/stage:sales:summarize/${id}/content?project_root=${encodeURIComponent(project)}`,
      );
      expect(Buffer.isBuffer(content.raw) ? content.raw.toString("utf8") : String(content.raw)).toBe("same-bytes");
    }
    await publish(store, project, { id: "existing-same", content: "old" });
    const again = await parallelPublish(store, project, 6, () => ({
      id: "existing-same",
      content: "new-same",
    }));
    expect(again.every((response) => response.status === 200)).toBe(true);
    expect(again.filter((response) => response.body.unchanged === false).map((response) => response.body.version)).toEqual([
      2,
    ]);
    expect(again.filter((response) => response.body.unchanged === true)).toHaveLength(5);
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "existing-same");
    expect(await directoryNames(storageKey)).toEqual(["v1", "v2"]);
  });

  it("leaves no row or directory when rename fails after staging", async () => {
    const { store, project } = await openStore();
    const first = await publish(store, project, { content: "kept" });
    expect(first.status).toBe(200);
    setPublishRenameFailureForTests(true);
    const failed = await publish(store, project, { content: "lost" });
    expect(failed.status).toBe(500);
    const db = sqliteConnectionFromStore(store)!;
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    const rows = db.prepare(`SELECT version, content_hash FROM artifact_versions WHERE key = ?`).all(storageKey) as Array<{
      version: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(await directoryNames(storageKey)).toEqual(["v1"]);
    const content = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/content?project_root=${encodeURIComponent(project)}&version=1`,
    );
    expect(content.status).toBe(200);
    expect(Buffer.isBuffer(content.raw) ? content.raw.toString("utf8") : String(content.raw)).toBe("kept");
  });

  it("rejects owner ids that are not catalog or agent ids", async () => {
    const { store, project } = await openStore();
    const cases: Array<{ owner: Record<string, unknown>; path: string }> = [
      { owner: { kind: "stage", pipeline: "../etc", stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "a/b", stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "sales\0x", stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "säles", stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "a".repeat(5000), stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "sales.txt", stage: "summarize" }, path: "owner.pipeline" },
      { owner: { kind: "stage", pipeline: "sales", stage: "sum/marize" }, path: "owner.stage" },
      { owner: { kind: "stage", pipeline: "sales", stage: ".." }, path: "owner.stage" },
      { owner: { kind: "agent", agent: "Bad" }, path: "owner.agent" },
      { owner: { kind: "agent", agent: "a/b" }, path: "owner.agent" },
      { owner: { kind: "agent", agent: "has.dot" }, path: "owner.agent" },
      { owner: { kind: "agent", agent: "a".repeat(5000) }, path: "owner.agent" },
      { owner: { kind: "agent", agent: "bad\0id" }, path: "owner.agent" },
    ];
    for (const item of cases) {
      const response = await publish(store, project, { owner: item.owner });
      expect(response.status, JSON.stringify(item)).toBe(400);
      expect(response.body.code).toBe("artifact.invalid_shape");
      expect(response.body.issues?.[0]?.path).toBe(item.path);
    }
    expect((await publish(store, project)).status).toBe(200);
  });

  it("stores kind on each version and serves the viewed version's kind", async () => {
    const { store, project } = await openStore();
    expect((await publish(store, project, { content: "# hi\n", kind: "static.markdown" })).status).toBe(200);
    expect((await publish(store, project, { content: "plain", kind: "static.text" })).body.version).toBe(2);
    const listed = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/versions?project_root=${encodeURIComponent(project)}`,
    );
    expect(listed.body.versions.find((row: { version: number }) => row.version === 1).kind).toBe("static.markdown");
    expect(listed.body.versions.find((row: { version: number }) => row.version === 2).kind).toBe("static.text");
    const v1 = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly?project_root=${encodeURIComponent(project)}&version=1`,
    );
    expect(v1.body.kind).toBe("static.markdown");
    expect(v1.body.version).toBe(1);
    const current = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly?project_root=${encodeURIComponent(project)}`,
    );
    expect(current.body.kind).toBe("static.text");
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    const db = sqliteConnectionFromStore(store)!;
    const stored = db
      .prepare(`SELECT version, manifest_json FROM artifact_versions WHERE key = ? ORDER BY version`)
      .all(storageKey) as Array<{ version: number; manifest_json: string }>;
    expect(stored.map((row) => JSON.parse(row.manifest_json))).toEqual([{ kind: "static.markdown" }, { kind: "static.text" }]);
    const manifest = JSON.parse(
      await readFile(path.join(artifactStoreRoot(), artifactKeyHash(storageKey), "v1", "manifest.json"), "utf8"),
    ) as { kind: string };
    expect(manifest.kind).toBe("static.markdown");
  });

  function imageBytes(kind: "png" | "jpg" | "gif" | "webp", size: number): Buffer {
    const bytes = Buffer.alloc(size);
    if (kind === "png") bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    else if (kind === "jpg") bytes.set([0xff, 0xd8, 0xff], 0);
    else if (kind === "gif") bytes.set(Buffer.from("GIF89a"), 0);
    else {
      bytes.set(Buffer.from("RIFF"), 0);
      bytes.set(Buffer.from("WEBP"), 8);
    }
    return bytes;
  }

  it("caps description at 2000 characters", async () => {
    const { store, project } = await openStore();
    const ok = await publish(store, project, { description: "d".repeat(2000) });
    expect(ok.status).toBe(200);
    const row = sqliteConnectionFromStore(store)!.prepare(`SELECT description FROM artifacts WHERE id = 'weekly'`).get() as {
      description: string;
    };
    expect(row.description).toBe("d".repeat(2000));
  });

  it("replaces an orphan version directory that has no row", async () => {
    const { store, home, project } = await openStore();
    expect((await publish(store, project, { id: "orph", content: "old" })).body.version).toBe(1);
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "orph");
    const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    await mkdir(path.join(keyDir, "v2"));
    await writeFile(path.join(keyDir, "v2", "content.md"), "stale");
    const second = await publish(store, project, { id: "orph", content: "new" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.version).toBe(2);
    expect(await readFile(path.join(keyDir, "v2", "content.md"), "utf8")).toBe("new");
    expect(await readFile(path.join(keyDir, "v1", "content.md"), "utf8")).toBe("old");

    expect((await publish(store, project, { id: "link", content: "v1" })).status).toBe(200);
    const linkKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "link");
    const linkDir = path.join(artifactStoreRoot(), artifactKeyHash(linkKey));
    const outside = path.join(home, "outside-target");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep-me"), "safe");
    await symlink(outside, path.join(linkDir, "v2"));
    const linked = await publish(store, project, { id: "link", content: "fresh" });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.version).toBe(2);
    expect(await readFile(path.join(outside, "keep-me"), "utf8")).toBe("safe");
    const v2Stat = await lstat(path.join(linkDir, "v2"));
    expect(v2Stat.isSymbolicLink()).toBe(false);
    expect(v2Stat.isDirectory()).toBe(true);
    expect(await readFile(path.join(linkDir, "v2", "content.md"), "utf8")).toBe("fresh");
  });

  it("keeps a version row whose directory is missing and publishes the next number", async () => {
    const { store, project } = await openStore();
    expect((await publish(store, project, { id: "gap", content: "v1" })).body.version).toBe(1);
    const db = sqliteConnectionFromStore(store)!;
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "gap");
    db.prepare(
      `INSERT INTO artifact_versions (
         key, version, content_type, size_bytes, content_hash, manifest_json, created_at, pinned, relative_path, storage
       )
       SELECT key, 2, content_type, size_bytes, content_hash, manifest_json, created_at, pinned, relative_path, storage
       FROM artifact_versions WHERE key = ? AND version = 1`,
    ).run(storageKey);
    const before = db.prepare(`SELECT content_hash FROM artifact_versions WHERE key = ? AND version = 2`).get(storageKey) as {
      content_hash: string;
    };
    const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    expect(existsSync(path.join(keyDir, "v2"))).toBe(false);
    const next = await publish(store, project, { id: "gap", content: "v3" });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.version).toBe(3);
    const after = db.prepare(`SELECT content_hash FROM artifact_versions WHERE key = ? AND version = 2`).get(storageKey) as {
      content_hash: string;
    };
    expect(after.content_hash).toBe(before.content_hash);
    const versions = db.prepare(`SELECT version FROM artifact_versions WHERE key = ? ORDER BY version`).all(storageKey) as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(existsSync(path.join(keyDir, "v2"))).toBe(false);
    expect(await readFile(path.join(keyDir, "v3", "content.md"), "utf8")).toBe("v3");
    expect(await readFile(path.join(keyDir, "v1", "content.md"), "utf8")).toBe("v1");
  });

  it("recovers a version directory left by a crash after rename", async () => {
    const { store, project } = await openStore();
    expect((await publish(store, project, { content: "kept" })).body.version).toBe(1);
    setPublishCommitFailureForTests(true);
    const crashed = await publish(store, project, { content: "lost" });
    expect(crashed.status).toBe(500);
    expect(crashed.body.code).toBe("artifact.publish_failed");
    const db = sqliteConnectionFromStore(store)!;
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    expect(existsSync(path.join(keyDir, "v2"))).toBe(true);
    expect(db.prepare(`SELECT version FROM artifact_versions WHERE key = ? AND version = 2`).get(storageKey)).toBeUndefined();
    const recovered = await publish(store, project, { content: "recovered" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.version).toBe(2);
    expect(await readFile(path.join(keyDir, "v2", "content.md"), "utf8")).toBe("recovered");
    expect(await readFile(path.join(keyDir, "v1", "content.md"), "utf8")).toBe("kept");
    const names = (await readdir(keyDir)).sort();
    expect(names.filter((name) => name.startsWith(".staging-"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("v"))).toEqual(["v1", "v2"]);
  });

  it("removes staging directories older than 10 minutes and leaves a fresh one", async () => {
    const { store, project } = await openStore();
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
    const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
    const stale = path.join(keyDir, ".staging-stale");
    const fresh = path.join(keyDir, ".staging-fresh");
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const old = new Date(Date.now() - STALE_STAGING_DIRECTORY_MS - 60_000);
    await utimes(stale, old, old);
    const response = await publish(store, project, { content: "ok" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(keyDir, "v1"))).toBe(true);
  });

  it("serializes publishes and deletes on one key and restarts versions after delete", async () => {
    const { store, project } = await openStore();
    expect((await publish(store, project, { id: "again", content: "first" })).body.version).toBe(1);
    const removed = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/again?project_root=${encodeURIComponent(project)}`,
    );
    expect(removed.status).toBe(200);
    const again = await publish(store, project, { id: "again", content: "second" });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(1);
    const db = sqliteConnectionFromStore(store)!;
    const againKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "again");
    expect(db.prepare(`SELECT version FROM artifact_versions WHERE key = ?`).all(againKey)).toEqual([{ version: 1 }]);
    const secondDelete = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/again?project_root=${encodeURIComponent(project)}`,
    );
    expect(secondDelete.status).toBe(200);
    const thirdDelete = await call(
      store,
      "DELETE",
      `/api/artifacts/stage:sales:summarize/again?project_root=${encodeURIComponent(project)}`,
    );
    expect(thirdDelete.status).toBe(404);
    expect(thirdDelete.body.code).toBe("artifact.not_found");

    const raceId = "race";
    const route = `/api/artifacts/stage:sales:summarize/${raceId}?project_root=${encodeURIComponent(project)}`;
    let seq = 0;
    for (let round = 0; round < 30; round++) {
      const finished: Array<"publish" | "delete"> = [];
      setArtifactKeyOperationTraceForTests((op) => finished.push(op));
      const jobs: Array<Promise<void>> = [];
      const steps: Array<"publish" | "delete"> =
        round % 2 === 0
          ? ["delete", "delete", "publish", "publish", "publish", "publish", "publish", "publish"]
          : ["publish", "publish", "publish", "publish", "publish", "publish", "delete", "delete"];
      let publishIndex = 0;
      for (const step of steps) {
        if (step === "publish") {
          const content = `r${round}-p${publishIndex}-${seq++}`;
          publishIndex += 1;
          jobs.push(
            publish(store, project, { id: raceId, content }).then((response) => {
              if (response.status !== 200) throw new Error(`publish ${response.status} ${JSON.stringify(response.body)}`);
            }),
          );
        } else {
          jobs.push(
            call(store, "DELETE", route).then((response) => {
              if (response.status !== 200 && response.status !== 404) {
                throw new Error(`delete ${response.status} ${JSON.stringify(response.body)}`);
              }
              if (response.status === 404 && response.body?.code !== "artifact.not_found") {
                throw new Error(`delete code ${response.body?.code}`);
              }
            }),
          );
        }
      }
      await Promise.all(jobs);
      const last = finished[finished.length - 1];
      const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), raceId);
      const artifact = db.prepare(`SELECT current_version FROM artifacts WHERE key = ?`).get(storageKey) as
        | { current_version: number }
        | undefined;
      const rows = db
        .prepare(`SELECT version, relative_path FROM artifact_versions WHERE key = ? ORDER BY version`)
        .all(storageKey) as Array<{ version: number; relative_path: string }>;
      const keyDir = path.join(artifactStoreRoot(), artifactKeyHash(storageKey));
      const names = existsSync(keyDir) ? (await readdir(keyDir)).sort() : [];
      if (last === "delete") {
        expect(artifact, `round ${round}`).toBeUndefined();
        expect(rows, `round ${round}`).toEqual([]);
        expect(existsSync(keyDir), `round ${round}`).toBe(false);
      } else {
        expect(artifact, `round ${round}`).toBeTruthy();
        expect(names.filter((name) => /^v\d+$/.test(name)), `round ${round} ${names.join(",")}`).toEqual(
          rows.map((row) => `v${row.version}`).sort(),
        );
        expect(names.filter((name) => !/^v\d+$/.test(name)), `round ${round}`).toEqual([]);
        for (const row of rows) {
          expect(existsSync(path.join(keyDir, `v${row.version}`, row.relative_path)), `v${row.version}`).toBe(true);
        }
        const content = await call(
          store,
          "GET",
          `/api/artifacts/stage:sales:summarize/${raceId}/content?project_root=${encodeURIComponent(project)}`,
        );
        expect(content.status, `round ${round}`).toBe(200);
        const raw = Buffer.isBuffer(content.raw) ? content.raw : Buffer.from(String(content.raw));
        expect(raw.length).toBeGreaterThan(0);
      }
    }
    const closed: Array<"publish" | "delete"> = [];
    setArtifactKeyOperationTraceForTests((op) => closed.push(op));
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        publish(store, project, { id: raceId, content: `tail-${index}-${seq++}` }).then((response) => {
          expect(response.status).toBe(200);
        }),
      ),
    );
    const endDeletes = await Promise.all([call(store, "DELETE", route), call(store, "DELETE", route)]);
    expect(endDeletes.map((response) => response.status).sort()).toEqual([200, 404]);
    expect(endDeletes.find((response) => response.status === 404)?.body.code).toBe("artifact.not_found");
    expect(closed[closed.length - 1]).toBe("delete");
    const storageKey = artifactStorageKey(project, stageOwnerKey("sales", "summarize"), raceId);
    expect(db.prepare(`SELECT key FROM artifacts WHERE key = ?`).get(storageKey)).toBeUndefined();
    expect(db.prepare(`SELECT version FROM artifact_versions WHERE key = ?`).all(storageKey)).toEqual([]);
    expect(existsSync(path.join(artifactStoreRoot(), artifactKeyHash(storageKey)))).toBe(false);
  });

  it("accepts base64 images up to 5 MiB and rejects invalid base64", async () => {
    const { store, project } = await openStore();
    const cases: Array<{ id: string; bytes: Buffer }> = [
      { id: "png4", bytes: imageBytes("png", 4 * 1024 * 1024) },
      { id: "jpg5", bytes: imageBytes("jpg", STATIC_CONTENT_MAX_BYTES - 10) },
      { id: "gif5", bytes: imageBytes("gif", STATIC_CONTENT_MAX_BYTES) },
    ];
    for (const item of cases) {
      const response = await publish(store, project, {
        id: item.id,
        kind: "static.image",
        title: item.id,
        content_base64: item.bytes.toString("base64"),
      });
      expect(response.status, item.id).toBe(200);
      expect(response.body.version).toBe(1);
      const content = await call(
        store,
        "GET",
        `/api/artifacts/stage:sales:summarize/${item.id}/content?project_root=${encodeURIComponent(project)}`,
      );
      expect(content.status).toBe(200);
      const raw = Buffer.isBuffer(content.raw) ? content.raw : Buffer.from(String(content.raw));
      expect(raw.length).toBe(item.bytes.length);
      expect(Buffer.compare(raw, item.bytes)).toBe(0);
    }
    const webp = await publish(store, project, {
      id: "webp",
      kind: "static.image",
      content_base64: imageBytes("webp", 32).toString("base64"),
    });
    expect(webp.status).toBe(200);
    const padded = await publish(store, project, {
      id: "padbits",
      kind: "static.text",
      content_base64: "YR==",
    });
    expect(padded.status, JSON.stringify(padded.body)).toBe(200);
    const paddedBody = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/padbits/content?project_root=${encodeURIComponent(project)}`,
    );
    expect(Buffer.isBuffer(paddedBody.raw) ? paddedBody.raw.toString("utf8") : String(paddedBody.raw)).toBe("a");
    let tooBigError: unknown;
    try {
      decodeBase64(imageBytes("png", STATIC_CONTENT_MAX_BYTES + 1).toString("base64"));
    } catch (error) {
      tooBigError = error;
    }
    expect(tooBigError).toBeInstanceOf(ArtifactPublishError);
    expect((tooBigError as ArtifactPublishError).status).toBe(413);
    expect((tooBigError as ArtifactPublishError).code).toBe("artifact.too_large");
    const invalid: Array<{ id: string; content_base64: string }> = [
      { id: "chars", content_base64: "@@@@" },
      { id: "pad", content_base64: "YQ=a" },
      { id: "short", content_base64: "YQ=" },
      { id: "space", content_base64: "YQ== YQ==" },
      { id: "break", content_base64: "YQ==\n" },
    ];
    for (const item of invalid) {
      const response = await publish(store, project, {
        id: item.id,
        kind: "static.image",
        content_base64: item.content_base64,
      });
      expect(response.status, item.id).toBe(400);
      expect(response.body.code).toBe("artifact.invalid_shape");
      expect(response.body.issues?.[0]?.path).toBe("content_base64");
    }
  });
});
