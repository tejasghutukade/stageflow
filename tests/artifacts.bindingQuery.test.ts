import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_INTERACTION_DISABLED,
  bindingQueryHttpStatus,
  queryBinding,
  bindingQueryBudgetSize,
  resetBindingQueryForTests,
  seedBindingQueryBudgetForTests,
  VARIANT_EXECUTIONS_PER_MINUTE,
  VARIANT_IN_FLIGHT_PER_ARTIFACT,
  VARIANT_SNAPSHOTS_PER_BINDING,
  VIEWER_EXECUTIONS_GLOBAL,
  VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL,
  variantExecutionIdle,
  type BindingQueryResult,
} from "../src/artifacts/bindingQuery.js";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { argsHash } from "../src/artifacts/manifest.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { deletePublishedArtifact, publishArtifact } from "../src/artifacts/publish.js";
import { refreshArtifact, refreshShareIdle } from "../src/artifacts/refresh.js";
import { REFRESH_RETRY_AFTER_SECONDS } from "../src/artifacts/refreshPolicy.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import { createFunctionInvoker, type FunctionCallInput, type FunctionRunView } from "../src/functions/invoke.js";
import { listFunctionInvocations } from "../src/functions/history.js";
import { agentProjectKey } from "../src/functions/store.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes, setArtifactRouteRefreshInvokeForTests } from "../src/server/artifactRoutes.js";
import { requiredScopeFor } from "../src/server/controlToken.js";

const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

afterEach(async () => {
  setArtifactRouteRefreshInvokeForTests(undefined);
  resetBindingQueryForTests();
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  expect(refreshShareIdle()).toBe(true);
  expect(variantExecutionIdle()).toBe(true);
});

function toolSource(access: string, body = "return { weeks: context.input && context.input.weeks };"): string {
  return `export const access = ${access};\nexport default async function execute(context) {\n  ${body}\n}\n`;
}

function functionYaml(id: string, source: string, additional = false): string {
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
  additionalProperties: ${additional ? "true" : "false"}
source: |
${source
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`;
}

async function writeFunction(project: string, id: string, source: string, additional = false): Promise<void> {
  const file = functionFilePath(project, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, functionYaml(id, source, additional));
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

function manifest(bindings: Array<{ id: string; function: string; args?: Record<string, unknown> }>, refresh?: Record<string, unknown>) {
  return {
    format: "openui-lang",
    library: { name: "stageflow", version: "1.0.0" },
    bindings: bindings.map((binding) => ({ ...binding, args: binding.args ?? { weeks: 12 } })),
    refresh: refresh ?? { ttl_seconds: 30 },
  };
}

async function setup(ids = ["revenue_by_week"], additional = false) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-query-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-query-proj-"));
  process.env.STAGEFLOW_HOME = home;
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: home });
  const registered = await store.ensureProject(project);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  for (const id of ids) {
    await writeFunction(registered, id, toolSource("{ network: [] }"), additional && id === ids[0]);
  }
  await writeStage(registered, ids);
  return { store, project: registered };
}

async function publish(
  store: RunStore,
  project: string,
  options: { program?: string; bindings?: Array<{ id: string; function: string; args?: Record<string, unknown> }>; id?: string; kind?: string } = {},
) {
  const db = sqliteConnectionFromStore(store)!;
  const roots = await catalogRootsForArtifacts(store);
  const id = options.id ?? "weekly";
  const kind = options.kind ?? "live.declarative";
  await publishArtifact(db, {
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    projectRoot: project,
    id,
    kind,
    title: "Weekly",
    bytes: Buffer.from(options.program ?? 'root = TextContent("card")\n'),
    ...(kind === "live.declarative"
      ? { manifest: manifest(options.bindings ?? [{ id: "rows", function: "revenue_by_week" }]) }
      : {}),
    publishSource: "api",
    roots,
  });
  return artifactStorageKey(project, stageOwnerKey("sales", "summarize"), id);
}

function requestBytes(payload: Buffer): IncomingMessage {
  return {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
}

function request(body: unknown): IncomingMessage {
  return requestBytes(Buffer.from(JSON.stringify(body ?? {})));
}

async function call(store: RunStore, method: string, pathname: string, body?: unknown) {
  return callRaw(store, method, pathname, request(body));
}

async function callRaw(store: RunStore, method: string, pathname: string, req: IncomingMessage) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const res = { writeHead() {}, end() {}, once() {}, removeListener() {} } as unknown as ServerResponse;
  const url = new URL(pathname, "http://127.0.0.1");
  await handleArtifactRoutes(req, method, url.pathname, url, store, res, (response, status, payload) => {
    json(response, status, payload);
    sent.status = status;
    sent.body = payload as Record<string, unknown>;
  });
  return sent;
}

function queryPath(project: string, id = "weekly"): string {
  return `/api/artifacts/stage:sales:summarize/${id}/query?project_root=${encodeURIComponent(project)}`;
}

function statusOf(db: ReturnType<typeof sqliteConnectionFromStore>, key: string) {
  return db!.prepare(`SELECT live_status, last_error_code, last_refreshed_at FROM artifacts WHERE key = ?`).get(key) as {
    live_status: string | null;
    last_error_code: string | null;
    last_refreshed_at: string | null;
  };
}

function rowsOf(db: ReturnType<typeof sqliteConnectionFromStore>, key: string) {
  return db!.prepare(`SELECT binding_id, args_hash, fetched_at FROM artifact_snapshots WHERE artifact_key = ? ORDER BY args_hash`).all(key) as Array<{
    binding_id: string;
    args_hash: string;
    fetched_at: string;
  }>;
}

describe("binding query", () => {
  it("exports the disabled interaction code and requires the drive scope", () => {
    expect(ARTIFACT_INTERACTION_DISABLED).toBe("artifact.interaction_disabled");
    expect(requiredScopeFor("POST", "/api/artifacts/stage:sales:summarize/weekly/query")).toBe("drive");
    expect(requiredScopeFor("POST", "/api/artifacts/stage:sales:summarize/weekly/refresh")).toBe("drive");
  });

  it("merges defaults, rejects bad viewer args, and follows the input schema", async () => {
    const { store, project } = await setup(["revenue_by_week", "open_metric"], true);
    await writeFunction(project, "open_metric", toolSource("{ network: [] }"), true);
    await writeStage(project, ["revenue_by_week", "open_metric"]);
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project, {
      bindings: [
        { id: "rows", function: "revenue_by_week" },
        { id: "open", function: "open_metric" },
      ],
    });
    const seen: unknown[] = [];
    const invoke = vi.fn(async (_root: string, input: FunctionCallInput) => {
      seen.push(input.input);
      const args = (input.input as { input?: { weeks?: number } }).input;
      return okView({ weeks: args?.weeks ?? 0 });
    });
    const overridden = await queryBinding(db, { projectRoot: project, invoke }, key, {
      bindingId: "rows",
      args: { weeks: 4 },
    });
    expect(overridden.snapshot?.value).toEqual({ weeks: 4 });
    expect(overridden.snapshot?.source).toBe("executed");
    expect(overridden.args_hash).toBe(argsHash({ weeks: 4 }));
    const open = await queryBinding(db, { projectRoot: project, invoke }, key, {
      bindingId: "open",
      args: { region: "us" },
    });
    expect(open.errors).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ input: { weeks: 12, region: "us" } });
    await expect(queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { "bad-key": 1 } })).rejects.toMatchObject({
      code: "artifact.binding_args_invalid",
    });
    let deep: unknown = 1;
    for (let i = 0; i < 8; i += 1) deep = { n: deep };
    await expect(queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: deep as Record<string, unknown> })).rejects.toMatchObject({
      code: "artifact.binding_args_invalid",
    });
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 17; i += 1) many[`k${i}`] = 1;
    await expect(queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: many })).rejects.toMatchObject({
      code: "artifact.binding_args_invalid",
    });
    await expect(
      queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { note: "x".repeat(9000) } }),
    ).rejects.toMatchObject({ code: "artifact.binding_args_invalid" });
    await expect(queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: "no" } as unknown as Record<string, unknown> })).rejects.toMatchObject({
      code: "artifact.binding_args_invalid",
      issues: [expect.objectContaining({ path: expect.stringContaining("weeks") })],
    });
    const callsBeforeSchema = invoke.mock.calls.length;
    expect(callsBeforeSchema).toBe(2);
  });

  it("updates artifact status only for the default args hash", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const invoke = vi.fn(async () => okView({ weeks: 4 }));
    const variant = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 4 } });
    expect(variant.errors).toEqual([]);
    expect(statusOf(db, key)).toEqual({ live_status: null, last_error_code: null, last_refreshed_at: null });
    const before = statusOf(db, key);
    invoke.mockResolvedValue(okView({ weeks: 12 }));
    const defaults = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 12 } });
    expect(defaults.snapshot?.source).toBe("executed");
    expect(defaults.args_hash).toBe(argsHash({ weeks: 12 }));
    const after = statusOf(db, key);
    expect(after.live_status).toBe("fresh");
    expect(after.last_refreshed_at).toEqual(expect.any(String));
    expect(after.last_error_code).toBeNull();
    invoke.mockResolvedValue(okView({ weeks: 9 }));
    await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 9 } });
    expect(statusOf(db, key)).toEqual(after);
    expect(before.last_refreshed_at).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS c FROM runs`).get()).toEqual({ c: 0 });
  });

  it("reuses a fresh variant, reruns a stale one, and isolates args", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const invoke = vi.fn(async (_root: string, input: FunctionCallInput) => {
      const weeks = (input.input as { input?: { weeks?: number } }).input?.weeks;
      return okView({ weeks });
    });
    const deps = { projectRoot: project, invoke, now };
    const first = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 4 } });
    const second = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 4 } });
    expect(second.snapshot?.source).toBe("cache");
    expect(second.snapshot?.fetched_at).toBe(first.snapshot?.fetched_at);
    expect(invoke).toHaveBeenCalledTimes(1);
    const other = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 5 } });
    expect(other.snapshot?.source).toBe("executed");
    expect(other.args_hash).not.toBe(first.args_hash);
    expect(rowsOf(db, key)).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    clock += 31_000;
    const stale = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 4 } });
    expect(stale.snapshot?.source).toBe("executed");
    expect(invoke).toHaveBeenCalledTimes(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    invoke.mockImplementation(async () => {
      await gate;
      return okView({ weeks: 7 });
    });
    const pending = Array.from({ length: 12 }, () =>
      queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 7 } }),
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    release();
    const joined = await Promise.all(pending);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(joined.every((result) => result === joined[0])).toBe(true);
    expect(joined[0]?.snapshot?.value).toEqual({ weeks: 7 });
  });

  it("keeps 32 variants and evicts the oldest fetch time, then drops them on republish and delete", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    let step = 0;
    const now = () => new Date(Date.parse("2026-01-01T00:00:00.000Z") + step++ * 61_000).toISOString();
    const invoke = vi.fn(async () => okView({ weeks: 1 }));
    const deps = { projectRoot: project, invoke, now };
    const hashes: string[] = [];
    for (let weeks = 40; weeks <= 40 + VARIANT_SNAPSHOTS_PER_BINDING; weeks += 1) {
      const result = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks } });
      expect(result.errors).toEqual([]);
      hashes.push(result.args_hash);
    }
    const kept = rowsOf(db, key).map((row) => row.args_hash);
    expect(kept).toHaveLength(VARIANT_SNAPSHOTS_PER_BINDING);
    expect(kept).not.toContain(hashes[0]);
    expect(kept).toContain(hashes[VARIANT_SNAPSHOTS_PER_BINDING]);
    const tieAt = "2026-02-01T00:00:00.000Z";
    db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(key);
    for (let index = 0; index < VARIANT_SNAPSHOTS_PER_BINDING; index += 1) {
      const hash = index.toString(16).padStart(2, "0");
      db.prepare(
        `INSERT INTO artifact_snapshots (
           artifact_key, binding_id, args_hash, value_json, fetched_at, duration_ms, status, error_code
         ) VALUES (?, 'rows', ?, '{"weeks":1}', ?, 1, 'ok', NULL)`,
      ).run(key, hash, tieAt);
    }
    await queryBinding(db, { projectRoot: project, invoke, now: () => tieAt }, key, { bindingId: "rows", args: { weeks: 80 } });
    const afterTie = rowsOf(db, key).map((row) => row.args_hash);
    expect(afterTie).not.toContain("00");
    expect(afterTie).toContain("01");
    expect(afterTie).toHaveLength(VARIANT_SNAPSHOTS_PER_BINDING);
    await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: 12 }) }, key, { bindingIds: ["rows"] });
    expect(rowsOf(db, key).some((row) => row.args_hash === argsHash({ weeks: 12 }))).toBe(true);
    expect(rowsOf(db, key).length).toBeGreaterThan(1);
    await publish(store, project, { program: 'root = TextContent("next")\n' });
    const republished = rowsOf(db, key);
    expect(republished.map((row) => row.args_hash)).toEqual([argsHash({ weeks: 12 })]);
    await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 3 } });
    expect(rowsOf(db, key)).toHaveLength(2);
    const roots = await catalogRootsForArtifacts(store);
    await deletePublishedArtifact(db, "stage:sales:summarize", "weekly", project, roots);
    expect(rowsOf(db, key)).toEqual([]);
  });

  it("refuses variant executions past the rate and in-flight limits and when the executor queue is full", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const invoke = vi.fn(async () => okView({ weeks: 1 }));
    for (let weeks = 40; weeks < 40 + VARIANT_EXECUTIONS_PER_MINUTE; weeks += 1) {
      const result = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks } });
      expect(result.errors).toEqual([]);
    }
    setArtifactRouteRefreshInvokeForTests(invoke);
    const blocked = await call(store, "POST", queryPath(project), { binding_id: "rows", args: { weeks: 90 } });
    expect(blocked.status).toBe(503);
    expect(blocked.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(blocked.body?.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
    expect(blocked.body?.snapshot).toBeNull();
    expect(blocked.body?.binding_id).toBe("rows");
    expect(invoke).toHaveBeenCalledTimes(VARIANT_EXECUTIONS_PER_MINUTE);
    resetBindingQueryForTests();
    for (let weeks = 100; weeks < 100 + VARIANT_EXECUTIONS_PER_MINUTE; weeks += 1) {
      await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks } });
    }
    const again = await call(store, "POST", queryPath(project), { binding_id: "rows", args: { weeks: 129 }, ifStale: false });
    expect(again.status).toBe(200);
    expect((again.body?.snapshot as { source?: string }).source).toBe("cache");
    expect(again.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(bindingQueryHttpStatus(again.body as unknown as BindingQueryResult)).toBe(200);
    resetBindingQueryForTests();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = vi.fn(async () => {
      await gate;
      return okView({ weeks: 1 });
    });
    const callsBefore = held.mock.calls.length;
    const pending = Array.from({ length: VIEWER_EXECUTIONS_GLOBAL }, (_, index) =>
      queryBinding(db, { projectRoot: project, invoke: held }, key, { bindingId: "rows", args: { weeks: 200 + index } }),
    );
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(callsBefore + VIEWER_EXECUTIONS_GLOBAL));
    const overflow = await queryBinding(db, { projectRoot: project, invoke: held }, key, {
      bindingId: "rows",
      args: { weeks: 250 },
    });
    expect(overflow.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(overflow.snapshot).toBeNull();
    expect(held).toHaveBeenCalledTimes(callsBefore + VIEWER_EXECUTIONS_GLOBAL);
    release();
    await Promise.all(pending);
    resetBindingQueryForTests();
    const queued = vi.fn(async () => ({ ...okView(), ok: false, value: undefined, code: "resource_limit", status: "failed" as const }));
    setArtifactRouteRefreshInvokeForTests(queued);
    const failed = await call(store, "POST", queryPath(project), { binding_id: "rows", args: { weeks: 61 } });
    expect(failed.status).toBe(503);
    expect(failed.body?.snapshot).toBeNull();
    expect(failed.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    const stored = await queryBinding(db, { projectRoot: project, invoke: async () => okView({ weeks: 62 }) }, key, {
      bindingId: "rows",
      args: { weeks: 62 },
    });
    expect(stored.snapshot?.source).toBe("executed");
    const full = await queryBinding(db, { projectRoot: project, invoke: queued }, key, {
      bindingId: "rows",
      args: { weeks: 62 },
      ifStale: false,
    });
    expect(full.snapshot?.source).toBe("cache");
    expect(full.snapshot?.value).toEqual({ weeks: 62 });
    expect(full.errors[0]?.code).toBe("artifact.resource_limit");
    expect(bindingQueryHttpStatus(full)).toBe(200);
    expect(statusOf(db, key).last_error_code).toBeNull();
  });

  it("refuses unknown, static, expired, and hidden artifacts and a function that is no longer read-only", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const invoke = vi.fn(async () => okView());
    await expect(queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "missing" })).rejects.toMatchObject({
      code: "artifact.invalid_shape",
      status: 400,
    });
    const unknown = await call(store, "POST", queryPath(project), { binding_id: "missing" });
    expect(unknown.status).toBe(400);
    expect(unknown.body?.code).toBe("artifact.invalid_shape");
    const extra = await call(store, "POST", queryPath(project), { binding_id: "rows", extra: true });
    expect(extra.status).toBe(400);
    expect(extra.body?.code).toBe("artifact.invalid_shape");
    const badFlag = await call(store, "POST", queryPath(project), { binding_id: "rows", ifStale: "yes" });
    expect(badFlag.body?.code).toBe("artifact.invalid_shape");
    await publish(store, project, { id: "note", kind: "static.markdown", program: "# n\n" });
    const staticArtifact = await call(store, "POST", queryPath(project, "note"), { binding_id: "rows" });
    expect(staticArtifact.status).toBe(404);
    expect(staticArtifact.body?.code).toBe("artifact.not_live");
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'file_missing' WHERE key = ?`).run(key);
    const expired = await call(store, "POST", queryPath(project), { binding_id: "rows" });
    expect(expired.status).toBe(404);
    expect(expired.body?.code).toBe("artifact.content_unavailable");
    db.prepare(`UPDATE artifacts SET status = 'available', expired_reason = NULL, hidden = 1 WHERE key = ?`).run(key);
    const hidden = await call(store, "POST", queryPath(project), { binding_id: "rows" });
    expect(hidden.status).toBe(404);
    expect(hidden.body?.code).toBe("artifact.not_found");
    db.prepare(`UPDATE artifacts SET hidden = 0 WHERE key = ?`).run(key);
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource('{ network: [{ origin: "https://hooks.test", effect: "action", methods: ["POST"], path: "/" }] }'),
    );
    setArtifactRouteRefreshInvokeForTests(invoke);
    const refused = await call(store, "POST", queryPath(project), { binding_id: "rows", args: { weeks: 4 } });
    expect(refused.status).toBe(200);
    expect(refused.body?.errors).toEqual([{ binding_id: "rows", code: "artifact.binding_not_read_only" }]);
    expect(invoke).not.toHaveBeenCalled();
    await writeFile(functionFilePath(project, "revenue_by_week"), "");
    const gone = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 4 } });
    expect(gone.errors[0]?.code).toBe("artifact.binding_unknown_function");
    expect(invoke).not.toHaveBeenCalled();
    await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }"));
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales
stages:
  - id: summarize
    tools:
      functions: []
`,
    );
    const ungranted = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 4 } });
    expect(ungranted.errors[0]?.code).toBe("artifact.binding_not_granted");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("runs the checked revision and scrubs secrets out of the variant snapshot", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const invoker = createFunctionInvoker({
      db,
      stageflowHome: path.join(project, "home"),
      lookup: async () => ["203.0.113.10"],
    });
    const result = await queryBinding(
      db,
      {
        projectRoot: project,
        invoke: async (root, input) => {
          expect(input.revision).toBeGreaterThan(0);
          await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }", "return { edited: true };"));
          return invoker.call(root, input);
        },
      },
      key,
      { bindingId: "rows", args: { weeks: 4 } },
    );
    expect(result.errors).toEqual([]);
    expect(result.snapshot?.value).toEqual({ weeks: 4 });
    expect(JSON.stringify(result)).not.toContain("edited");
    const history = listFunctionInvocations(db, agentProjectKey(project), "revenue_by_week");
    expect(history[0]?.kind).toBe("artifact");
    expect(JSON.stringify(history)).not.toContain("weeks");
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource("{ network: [] }", `return { weeks: context.input.weeks, api_key: "${SECRET}", note: "Bearer ${SECRET}" };`),
    );
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const scrubbed = await queryBinding(db, { projectRoot: project, invoke: (root, input) => invoker.call(root, input) }, key, {
      bindingId: "rows",
      args: { weeks: 6 },
    });
    errorSpy.mockRestore();
    logSpy.mockRestore();
    const dumped = JSON.stringify({
      scrubbed,
      logs,
      history: listFunctionInvocations(db, agentProjectKey(project), "revenue_by_week"),
      rows: db.prepare(`SELECT value_json FROM artifact_snapshots WHERE artifact_key = ? AND binding_id = 'rows'`).all(key),
    });
    expect(dumped).not.toContain(SECRET);
    expect(JSON.stringify(scrubbed.snapshot?.value)).toContain("[redacted]");
    expect(statusOf(db, key).live_status).toBeNull();
  });

  it("joins ifStale false queries for the same args into one execution", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await gate;
      return okView({ weeks: 9 });
    });
    const pending = Array.from({ length: 20 }, () =>
      queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 9 }, ifStale: false }),
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledTimes(1);
    release();
    const joined = await Promise.all(pending);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(joined.every((result) => result === joined[0])).toBe(true);
    expect(joined[0]?.snapshot?.source).toBe("executed");
    const again = await queryBinding(db, { projectRoot: project, invoke }, key, {
      bindingId: "rows",
      args: { weeks: 9 },
      ifStale: false,
    });
    expect(again.snapshot?.source).toBe("executed");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("admits a default refresh while viewer executions fill the global cap", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const other = await publish(store, project, { id: "daily" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted: number[] = [];
    const invoke = vi.fn(async (_root: string, input: FunctionCallInput) => {
      const weeks = (input.input.input as { weeks?: number }).weeks ?? -1;
      admitted.push(weeks);
      await gate;
      return okView({ weeks });
    });
    const deps = { projectRoot: project, invoke };
    const pending = Array.from({ length: VIEWER_EXECUTIONS_GLOBAL }, (_, index) =>
      queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 400 + index } }),
    );
    await vi.waitFor(() => expect(admitted).toHaveLength(VIEWER_EXECUTIONS_GLOBAL));
    const refresh = refreshArtifact(db, deps, other, { bindingIds: ["rows"] });
    await vi.waitFor(() => expect(admitted).toContain(12));
    expect(admitted.filter((weeks) => weeks === 12)).toEqual([12]);
    const extra = await queryBinding(db, deps, key, { bindingId: "rows", args: { weeks: 499 } });
    expect(extra.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(extra.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
    expect(admitted).not.toContain(499);
    const forced = await queryBinding(db, deps, key, { bindingId: "rows", ifStale: false });
    expect(forced.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(admitted.filter((weeks) => weeks === 12)).toEqual([12]);
    release();
    await Promise.all([...pending, refresh]);
    expect(invoke).toHaveBeenCalledTimes(VIEWER_EXECUTIONS_GLOBAL + 1);
  });

  it("refuses variant executions past the global per-minute cap and still refreshes defaults", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const first = await publish(store, project);
    const ids = ["alpha", "bravo", "charlie", "delta"];
    const keys = [first];
    for (const id of ids) keys.push(await publish(store, project, { id }));
    let clock = Date.parse("2026-06-01T00:00:00.000Z");
    const now = () => new Date(clock).toISOString();
    const invoke = vi.fn(async () => okView({ weeks: 1 }));
    const deps = { projectRoot: project, invoke, now };
    for (let artifact = 0; artifact < 4; artifact += 1) {
      for (let n = 0; n < VARIANT_EXECUTIONS_PER_MINUTE; n += 1) {
        const result = await queryBinding(db, deps, keys[artifact]!, {
          bindingId: "rows",
          args: { weeks: 1_000 + artifact * 100 + n },
        });
        expect(result.errors).toEqual([]);
      }
    }
    expect(invoke).toHaveBeenCalledTimes(VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL);
    const blocked = await queryBinding(db, deps, keys[4]!, { bindingId: "rows", args: { weeks: 3 } });
    expect(blocked.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(blocked.retry_after_seconds).toBe(REFRESH_RETRY_AFTER_SECONDS);
    expect(invoke).toHaveBeenCalledTimes(VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL);
    const refreshed = await refreshArtifact(db, deps, keys[4]!, { bindingIds: ["rows"] });
    expect(refreshed.errors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL + 1);
    clock += 61_000;
    const later = await queryBinding(db, deps, keys[4]!, { bindingId: "rows", args: { weeks: 4 } });
    expect(later.errors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(VIEWER_VARIANT_EXECUTIONS_PER_MINUTE_GLOBAL + 2);
  }, 60_000);

  it("keeps the per-artifact in-flight cap and drops empty rate windows", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const key = await publish(store, project);
    const invoke = vi.fn(async () => okView({ weeks: 1 }));
    seedBindingQueryBudgetForTests(key, Date.now(), VARIANT_IN_FLIGHT_PER_ARTIFACT);
    const blocked = await queryBinding(db, { projectRoot: project, invoke }, key, { bindingId: "rows", args: { weeks: 70 } });
    expect(blocked.errors).toEqual([{ binding_id: "rows", code: "artifact.resource_limit" }]);
    expect(invoke).not.toHaveBeenCalled();
    resetBindingQueryForTests();
    const old = Date.parse("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 5_000; index += 1) seedBindingQueryBudgetForTests(`synthetic-${index}`, old, 0);
    expect(bindingQueryBudgetSize()).toBe(5_000);
    const ran = await queryBinding(db, { projectRoot: project, invoke, now: () => "2026-01-01T00:02:00.000Z" }, key, {
      bindingId: "rows",
      args: { weeks: 71 },
    });
    expect(ran.errors).toEqual([]);
    expect(bindingQueryBudgetSize()).toBe(1);
  });

  it("rejects query and refresh bodies over 64 KiB and still publishes a larger body", async () => {
    const { store, project } = await setup();
    await publish(store, project);
    const fat = Buffer.alloc(64 * 1024 + 1, 0x7b);
    const query = await callRaw(store, "POST", queryPath(project), requestBytes(fat));
    expect(query.status).toBe(413);
    expect(query.body?.code).toBe("artifact.too_large");
    const refresh = await callRaw(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(project)}`,
      requestBytes(fat),
    );
    expect(refresh.status).toBe(413);
    expect(refresh.body?.code).toBe("artifact.too_large");
    const content = "x".repeat(70_000);
    const published = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      project_root: project,
      id: "longnote",
      kind: "static.markdown",
      title: "Long",
      content,
    });
    expect(published.status).toBe(200);
  });
});
