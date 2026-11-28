import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { deletePublishedArtifact, publishArtifact } from "../src/artifacts/publish.js";
import { refreshArtifact, refreshShareIdle } from "../src/artifacts/refresh.js";
import { REFRESH_JOINERS_PER_FLIGHT, refreshJoinerCount } from "../src/artifacts/refreshShare.js";
import { LIVE_REFRESH_MIN_SECONDS } from "../src/artifacts/limits.js";
import { DEFAULT_LIVE_TTL_SECONDS, REFRESH_RETRY_AFTER_SECONDS, refreshHttpStatus } from "../src/artifacts/refreshPolicy.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import type { FunctionCallInput, FunctionRunView } from "../src/functions/invoke.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes, setArtifactRouteRefreshInvokeForTests } from "../src/server/artifactRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  setArtifactRouteRefreshInvokeForTests(undefined);
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  expect(refreshShareIdle()).toBe(true);
});

function toolSource(body: string): string {
  return `export const access = { network: [] };\nexport default async function execute(context) {\n  ${body}\n}\n`;
}

function functionYaml(id: string, source: string): string {
  return `id: ${id}
name: ${id}
kind: tool
tool_name: ${id}
tool_description: Read ${id}
input_schema:
  type: object
  properties:
    weeks:
      type: integer
  required: [weeks]
  additionalProperties: false
source: |
${source
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`;
}

async function writeFunction(project: string, id: string, source: string): Promise<void> {
  const file = functionFilePath(project, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, functionYaml(id, source));
}

async function writeStage(project: string, ids: string[]): Promise<void> {
  await writeFile(
    path.join(project, "stageflow.yaml"),
    "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n",
  );
  await writeFile(
    path.join(project, "sales.pipeline.yaml"),
    `id: sales
stages:
  - id: summarize
    tools:
      functions:
${ids.map((id) => `        - id: ${id}`).join("\n")}
`,
  );
}

function okView(value: unknown = { weeks: 12 }): FunctionRunView {
  return {
    ok: true,
    value: value as FunctionRunView["value"],
    logs: "",
    durationMs: 5,
    sourceHash: "abc",
    revision: 1,
    kind: "artifact",
    status: "succeeded",
  };
}

function manifest(bindings: Array<{ id: string; function: string }>, refresh?: Record<string, unknown>) {
  return {
    format: "openui-lang",
    library: { name: "stageflow", version: "1.0.0" },
    bindings: bindings.map((binding) => ({ ...binding, args: { weeks: 12 } })),
    ...(refresh ? { refresh } : {}),
  };
}

async function setup(ids = ["revenue_by_week"]) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-scale-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-scale-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  for (const id of ids) await writeFunction(registered, id, toolSource("return { weeks: context.input && context.input.weeks };"));
  await writeStage(registered, ids);
  return { store, project: registered };
}

async function publish(
  store: RunStore,
  project: string,
  bindings: Array<{ id: string; function: string }>,
  refresh?: Record<string, unknown>,
) {
  const db = sqliteConnectionFromStore(store)!;
  const roots = await catalogRootsForArtifacts(store);
  await publishArtifact(db, {
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    projectRoot: project,
    id: "weekly",
    kind: "live.declarative",
    title: "Weekly",
    bytes: Buffer.from('root = TextContent("card")\n'),
    manifest: manifest(bindings, refresh),
    publishSource: "api",
    roots,
  });
  return artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
}

function request(body: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

function refreshPath(project: string): string {
  return `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(project)}`;
}

async function listen(store: RunStore): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleArtifactRoutes(req, req.method ?? "GET", url.pathname, url, store, res, json).catch((error) => {
      if (!res.headersSent) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error), code: "artifact.publish_failed" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function startPost(port: number, pathName: string, body: unknown): {
  done: Promise<{ status: number; body: Record<string, unknown> }>;
  destroy: () => void;
} {
  const payload = Buffer.from(JSON.stringify(body));
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: pathName,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
  });
  const done = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    req.on("error", (error) => reject(error));
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      });
    });
  });
  req.end(payload);
  return { done, destroy: () => req.destroy() };
}

async function call(store: RunStore, method: string, pathname: string, body?: unknown) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = { writeHead() {}, end() {} } as unknown as ServerResponse;
  const url = new URL(pathname, "http://127.0.0.1");
  await handleArtifactRoutes(request(body), method, url.pathname, url, store, res, (response, status, payload) => {
    json(response, status, payload);
    sent.status = status;
    sent.body = payload as Record<string, unknown>;
  });
  return sent;
}

describe("refresh at scale", () => {
  it("keeps the UI TTL constants equal to the server constants", () => {
    const source = readFileSync(new URL("../ui/src/api/artifacts.ts", import.meta.url), "utf8");
    expect(source).toContain(`export const DEFAULT_LIVE_TTL_SECONDS = ${DEFAULT_LIVE_TTL_SECONDS}`);
    expect(source).toContain(`export const LIVE_REFRESH_MIN_SECONDS = ${LIVE_REFRESH_MIN_SECONDS}`);
  });

  it("runs a binding only when its snapshot is missing, failed, or older than the TTL", async () => {
    const { store, project } = await setup(["revenue_by_week", "totals"]);
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [
      { id: "rows", function: "revenue_by_week" },
      { id: "totals", function: "totals" },
    ], { ttl_seconds: 30 });
    let nowMs = Date.parse("2026-11-24T00:00:00.000Z");
    const now = () => new Date(nowMs).toISOString();
    const calls: string[] = [];
    const invoke = async (_root: string, input: FunctionCallInput) => {
      calls.push(input.functionId);
      return okView({ fn: input.functionId });
    };
    const deps = { projectRoot: project, invoke, now };
    const missing = await refreshArtifact(db, deps, key, { ifStale: true });
    expect(calls).toEqual(["revenue_by_week", "totals"]);
    expect(missing.snapshots.every((snapshot) => snapshot.source === "executed")).toBe(true);
    const stamped = db.prepare(`SELECT last_refreshed_at AS at FROM artifacts WHERE key = ?`).get(key) as { at: string };
    const invocations = () =>
      (db.prepare(`SELECT COUNT(*) AS c FROM function_invocations`).get() as { c: number }).c;
    expect(invocations()).toBe(0);
    const fresh = await refreshArtifact(db, { projectRoot: project, now }, key, { ifStale: true });
    expect(invocations()).toBe(0);
    expect(fresh.snapshots.every((snapshot) => snapshot.source === "cache")).toBe(true);
    expect(db.prepare(`SELECT last_refreshed_at AS at FROM artifacts WHERE key = ?`).get(key)).toEqual(stamped);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }).c).toBe(0);

    nowMs += 30_000;
    calls.length = 0;
    const exact = await refreshArtifact(db, deps, key, { ifStale: true });
    expect(calls).toEqual([]);
    expect(exact.snapshots.every((snapshot) => snapshot.source === "cache")).toBe(true);

    nowMs += 1_000;
    calls.length = 0;
    const older = await refreshArtifact(db, deps, key, { ifStale: true, bindingIds: ["rows"] });
    expect(calls).toEqual(["revenue_by_week"]);
    expect(older.snapshots.find((snapshot) => snapshot.binding_id === "rows")?.source).toBe("executed");
    expect(older.snapshots.find((snapshot) => snapshot.binding_id === "totals")?.source).toBeUndefined();

    db.prepare(`UPDATE artifact_snapshots SET status = 'error', error_code = 'exception' WHERE artifact_key = ? AND binding_id = 'totals'`).run(key);
    calls.length = 0;
    nowMs += 1_000;
    const failed = await refreshArtifact(db, deps, key, { ifStale: true, bindingIds: ["totals"] });
    expect(calls).toEqual(["totals"]);
    expect(failed.snapshots.find((snapshot) => snapshot.binding_id === "totals")?.source).toBe("executed");
  });

  it("uses a 300 second default TTL and leaves a fresh custom TTL on the cache", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let nowMs = Date.parse("2026-11-24T00:00:00.000Z");
    const now = () => new Date(nowMs).toISOString();
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return okView();
    };
    await refreshArtifact(db, { projectRoot: project, invoke, now }, key);
    nowMs += 300_000;
    await refreshArtifact(db, { projectRoot: project, invoke, now }, key, { ifStale: true });
    expect(calls).toBe(1);
    nowMs += 1;
    await refreshArtifact(db, { projectRoot: project, invoke, now }, key, { ifStale: true });
    expect(calls).toBe(2);
  });

  it("shares one execution across twelve viewers and across overlapping binding sets", async () => {
    const { store, project } = await setup(["revenue_by_week", "totals"]);
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [
      { id: "rows", function: "revenue_by_week" },
      { id: "totals", function: "totals" },
    ]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const invoke = async (_root: string, input: FunctionCallInput) => {
      calls.push(input.functionId);
      if (input.functionId === "revenue_by_week") await gate;
      return okView({ fn: input.functionId });
    };
    const deps = { projectRoot: project, invoke };
    const viewers = Promise.all(Array.from({ length: 12 }, () => refreshArtifact(db, deps, key, { ifStale: true })));
    const started = Date.now();
    while (calls.filter((id) => id === "revenue_by_week").length < 1) {
      if (Date.now() - started > 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls.filter((id) => id === "revenue_by_week")).toHaveLength(1);
    release();
    const results = await viewers;
    expect(calls.filter((id) => id === "totals")).toHaveLength(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }).c).toBe(0);

    db.prepare(`UPDATE artifact_snapshots SET fetched_at = '2000-01-01T00:00:00.000Z' WHERE artifact_key = ?`).run(key);
    let releaseRows: () => void = () => undefined;
    const rowsGate = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    const secondCalls: string[] = [];
    const second = async (_root: string, input: FunctionCallInput) => {
      secondCalls.push(input.functionId);
      if (input.functionId === "revenue_by_week") await rowsGate;
      return okView();
    };
    const rowsOnly = refreshArtifact(db, { projectRoot: project, invoke: second }, key, { bindingIds: ["rows"], ifStale: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const both = refreshArtifact(db, { projectRoot: project, invoke: second }, key, { bindingIds: ["rows", "totals"], ifStale: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondCalls.filter((id) => id === "revenue_by_week")).toHaveLength(1);
    releaseRows();
    await rowsOnly;
    await both;
    expect(secondCalls.filter((id) => id === "revenue_by_week")).toHaveLength(1);
    expect(secondCalls.filter((id) => id === "totals")).toHaveLength(1);
  });

  it("gives every joined caller the same failure and does not cancel the shared run when one caller aborts", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      await gate;
      return { ...okView(), ok: false, value: undefined, code: "exception", status: "failed" as const };
    };
    const leader = refreshArtifact(db, { projectRoot: project, invoke }, key, { ifStale: true });
    const joined = refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { ifStale: true });
    const aborted = new AbortController();
    const quitting = refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, {
      ifStale: true,
      signal: aborted.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborted.abort();
    await expect(quitting).rejects.toMatchObject({ name: "AbortError" });
    release();
    const [left, right] = await Promise.all([leader, joined]);
    expect(left).toBe(right);
    expect(left.errors[0]?.code).toBe("exception");
    expect(calls).toBe(1);

    let releaseThrow: () => void = () => undefined;
    const throwGate = new Promise<void>((resolve) => {
      releaseThrow = resolve;
    });
    const failing = refreshArtifact(db, {
      projectRoot: project,
      invoke: async () => {
        await throwGate;
        db.prepare(`UPDATE artifacts SET deleted_at = '2026-11-24T00:00:00.000Z' WHERE key = ?`).run(key);
        return okView();
      },
    }, key, { ifStale: true });
    const partner = refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { ifStale: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseThrow();
    const outcomes = await Promise.allSettled([failing, partner]);
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[1]?.status).toBe("rejected");
    if (outcomes[0].status === "rejected" && outcomes[1].status === "rejected") {
      expect(outcomes[0].reason).toBe(outcomes[1].reason);
      expect(outcomes[0].reason).toMatchObject({ code: "artifact.not_found" });
    }
  });

  it("drops in-flight entries after errors and does not cap joined ifStale callers at 32", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    for (let index = 0; index < 20; index += 1) {
      await refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, `${key}-missing-${index}`).catch((error) => error);
    }
    await expect(
      refreshArtifact(db, { projectRoot: project, now: () => { throw new Error("clock"); }, invoke: async () => okView() }, key),
    ).rejects.toThrow(/clock/);
    expect(refreshShareIdle()).toBe(true);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      await gate;
      return okView();
    };
    const first = refreshArtifact(db, { projectRoot: project, invoke }, key, { ifStale: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = Array.from({ length: 40 }, () =>
      refreshArtifact(db, { projectRoot: project, invoke: async () => { calls += 1; return okView(); } }, key, { ifStale: true }),
    );
    release();
    const results = await Promise.all([first, ...waiting]);
    expect(calls).toBe(1);
    expect(results.every((result) => result === results[0])).toBe(true);
  });

  it("lets delete run ahead of a refresh for bindings that are not in flight", async () => {
    const { store, project } = await setup(["revenue_by_week", "totals"]);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const key = await publish(store, project, [
      { id: "rows", function: "revenue_by_week" },
      { id: "totals", function: "totals" },
    ]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = refreshArtifact(db, {
      projectRoot: project,
      invoke: async () => {
        await gate;
        return okView();
      },
    }, key, { bindingIds: ["rows"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { bindingIds: ["totals"] }).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleted = deletePublishedArtifact(db, "stage:sales:summarize", "weekly", project, roots);
    release();
    await slow;
    await expect(other).resolves.toMatchObject({ code: "artifact.not_found" });
    await deleted;
  });

  it("keeps the last snapshot when the executor queue is full", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    const limited = async () => ({ ...okView(), ok: false, value: undefined, code: "resource_limit", status: "failed" as const });
    const empty = await refreshArtifact(db, { projectRoot: project, invoke: limited }, key);
    expect(empty.status).toBe("error");
    expect(empty.last_error_code).toBe("artifact.resource_limit");
    expect(empty.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
    expect(empty.snapshots).toEqual([]);
    expect(refreshHttpStatus(empty)).toBe(503);
    await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: 3 }) }, key);
    const again = await refreshArtifact(db, { projectRoot: project, invoke: limited }, key);
    expect(again.status).toBe("stale");
    expect(again.last_error_code).toBe("artifact.resource_limit");
    expect(again.retry_after_seconds).toBe(30);
    expect(again.snapshots[0]?.value).toEqual({ weeks: 3 });
    expect(again.snapshots[0]?.source).toBe("cache");
    expect(refreshHttpStatus(again)).toBe(200);

    const pathName = `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(project)}`;
    setArtifactRouteRefreshInvokeForTests(limited);
    const queued = await call(store, "POST", pathName, {});
    expect(queued.status).toBe(200);
    expect(queued.body?.retry_after_seconds).toBe(30);
    expect(queued.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(key);
    const unavailable = await call(store, "POST", pathName, { ifStale: true });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body?.retry_after_seconds).toBe(30);
    const bad = await call(store, "POST", pathName, { ifStale: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.body?.code).toBe("artifact.invalid_shape");
  });

  it("serves 100 ifStale viewers from one execution and does not spend a queue slot on a fresh cache", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return okView({ weeks: 9 });
    };
    await refreshArtifact(db, { projectRoot: project, invoke }, key);
    calls = 0;
    const cached = await Promise.all(
      Array.from({ length: 100 }, () => refreshArtifact(db, { projectRoot: project, invoke }, key, { ifStale: true })),
    );
    expect(calls).toBe(0);
    expect(cached.every((result) => result.snapshots[0]?.source === "cache" && result.snapshots[0]?.value)).toBe(true);

    db.prepare(`UPDATE artifact_snapshots SET fetched_at = '2000-01-01T00:00:00.000Z' WHERE artifact_key = ?`).run(key);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async () => {
      calls += 1;
      await gate;
      return okView({ weeks: 9 });
    };
    const server = await listen(store);
    setArtifactRouteRefreshInvokeForTests(slow);
    const pathName = refreshPath(project);
    const viewers = Array.from({ length: 100 }, () => startPost(server.port, pathName, { ifStale: true }));
    const started = Date.now();
    while ((calls < 1 || refreshJoinerCount(key) < 99) && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toBe(1);
    expect(refreshJoinerCount(key)).toBe(99);
    release();
    const results = await Promise.all(viewers.map((viewer) => viewer.done));
    expect(calls).toBe(1);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.every((result) => JSON.stringify(result.body.snapshots) === JSON.stringify(results[0]?.body.snapshots))).toBe(true);
    expect((results[0]?.body.snapshots as Array<{ value: { weeks: number } }>)[0]?.value).toEqual({ weeks: 9 });
    await server.close();
  });

  it("queues at most 32 manual refreshes and refuses the rest with the snapshot result shape", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: 4 }) }, key);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      await gate;
      return okView({ weeks: 4 });
    };
    const running = refreshArtifact(db, { projectRoot: project, invoke }, key);
    const started = Date.now();
    while (calls < 1 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
    const flood = Array.from({ length: 100 }, () => refreshArtifact(db, { projectRoot: project, invoke }, key));
    const settled: Array<Awaited<ReturnType<typeof refreshArtifact>> | "pending"> = Array.from({ length: 100 }, () => "pending");
    flood.forEach((promise, index) => {
      void promise.then((result) => {
        settled[index] = result;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = settled.filter((result) => result !== "pending");
    const queued = settled.filter((result) => result === "pending");
    expect(queued).toHaveLength(32);
    expect(refused).toHaveLength(68);
    for (const result of refused) {
      if (result === "pending") continue;
      expect(result.status).toBe("stale");
      expect(result.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
      expect(result.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
      expect(result.snapshots[0]?.value).toEqual({ weeks: 4 });
      expect(result.snapshots[0]?.source).toBe("cache");
      expect(refreshHttpStatus(result)).toBe(200);
      expect(result).not.toHaveProperty("code");
    }
    const pathName = refreshPath(project);
    setArtifactRouteRefreshInvokeForTests(invoke);
    const httpRefused = await call(store, "POST", pathName, {});
    expect(httpRefused.status).toBe(200);
    expect(httpRefused.body?.retry_after_seconds).toBe(30);
    expect(httpRefused.body?.status).toBe("stale");
    expect(httpRefused.body?.code).toBeUndefined();
    expect(httpRefused.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    release();
    await running;
    await Promise.all(flood);
    expect(calls).toBe(33);
  });

  it("refuses a manual refresh with 503 when the execution queue is full and no snapshot exists", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      await gate;
      return okView();
    };
    const running = refreshArtifact(db, { projectRoot: project, invoke }, key);
    while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = Array.from({ length: 32 }, () => refreshArtifact(db, { projectRoot: project, invoke }, key));
    const pathName = refreshPath(project);
    setArtifactRouteRefreshInvokeForTests(invoke);
    const refused = await call(store, "POST", pathName, {});
    expect(refused.status).toBe(503);
    expect(refused.body?.status).toBe("error");
    expect(refused.body?.snapshots).toEqual([]);
    expect(refused.body?.retry_after_seconds).toBe(30);
    expect(refused.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(refused.body?.code).toBeUndefined();
    release();
    await Promise.all([running, ...queued]);
  });

  it("bounds joiners per flight and releases a joiner when its request aborts", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      await gate;
      return okView({ weeks: 2 });
    };
    const leader = refreshArtifact(db, { projectRoot: project, invoke }, key, { ifStale: true });
    while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const controllers = Array.from({ length: REFRESH_JOINERS_PER_FLIGHT }, () => new AbortController());
    const joiners = controllers.map((controller) =>
      refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { ifStale: true, signal: controller.signal }),
    );
    const started = Date.now();
    while (refreshJoinerCount(key) < REFRESH_JOINERS_PER_FLIGHT && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(refreshJoinerCount(key)).toBe(REFRESH_JOINERS_PER_FLIGHT);
    const blocked = await refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { ifStale: true });
    expect(blocked.status).toBe("error");
    expect(blocked.snapshots).toEqual([]);
    expect(blocked.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
    expect(blocked.errors[0]?.code).toBe("artifact.resource_limit");
    expect(refreshHttpStatus(blocked)).toBe(503);
    controllers[0]?.abort();
    await expect(joiners[0]).rejects.toMatchObject({ name: "AbortError" });
    const admitted = refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { ifStale: true });
    const joinedAt = Date.now();
    while (refreshJoinerCount(key) < REFRESH_JOINERS_PER_FLIGHT && Date.now() - joinedAt < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(refreshJoinerCount(key)).toBe(REFRESH_JOINERS_PER_FLIGHT);
    release();
    const leaderResult = await leader;
    const admittedResult = await admitted;
    expect(admittedResult).toBe(leaderResult);
    expect(calls).toBe(1);
    await Promise.all(joiners.slice(1));
  });

  it("drops a joined HTTP caller when the socket closes and still finishes the shared refresh", async () => {
    const { store, project } = await setup();
    const key = await publish(store, project, [{ id: "rows", function: "revenue_by_week" }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    setArtifactRouteRefreshInvokeForTests(async () => {
      calls += 1;
      await gate;
      return okView({ weeks: 6 });
    });
    const server = await listen(store);
    const pathName = refreshPath(project);
    const leader = startPost(server.port, pathName, { ifStale: true });
    const started = Date.now();
    while (calls < 1 && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
    const joiner = startPost(server.port, pathName, { ifStale: true });
    const joinedAt = Date.now();
    while (refreshJoinerCount(key) < 1 && Date.now() - joinedAt < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refreshJoinerCount(key)).toBe(1);
    joiner.destroy();
    await expect(joiner.done).rejects.toThrow();
    const releasedAt = Date.now();
    while (refreshJoinerCount(key) > 0 && Date.now() - releasedAt < 5000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refreshJoinerCount(key)).toBe(0);
    expect(calls).toBe(1);
    release();
    const leaderResult = await leader.done;
    expect(leaderResult.status).toBe(200);
    expect((leaderResult.body.snapshots as Array<{ value: { weeks: number } }>)[0]?.value).toEqual({ weeks: 6 });
    expect(calls).toBe(1);
    await server.close();
  });
});
