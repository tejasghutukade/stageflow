import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPublishArtifactTool } from "../src/agents/artifactTools.js";
import { agentProjectKey } from "../src/agents/store.js";
import { indexDeclaredDeliverables } from "../src/artifacts/indexDeclared.js";
import { artifactStorageKey, stageOwnerKey } from "../src/artifacts/keys.js";
import { LIVE_PROGRAM_MAX_BYTES, LIVE_SNAPSHOT_MAX_BYTES } from "../src/artifacts/limits.js";
import { validateLiveManifest } from "../src/artifacts/manifest.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { listArtifacts, readArtifact } from "../src/artifacts/query.js";
import { deletePublishedArtifact, publishArtifact } from "../src/artifacts/publish.js";
import {
  recoverRefreshingArtifacts,
  refreshArtifact,
  scrubSnapshotValue,
  SNAPSHOT_MAX_DEPTH,
} from "../src/artifacts/refresh.js";
import { publishSessionArtifact } from "../src/artifacts/sessionPublish.js";
import { functionFilePath } from "../src/config/loadFunction.js";
import { createFunctionInvoker, type FunctionCallInput, type FunctionRunView } from "../src/functions/invoke.js";
import { listFunctionInvocations } from "../src/functions/history.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { publishBodyFromToolParams } from "../src/tools/publishArtifact.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { repairMissingIndexed } from "../src/runstore/artifactRetention.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import { formatArtifactRefresh } from "../src/cli/artifactListFormat.js";
import type { RunStore } from "../src/runstore/port.js";
import { json } from "../src/server/createHttpHost.js";
import { handleArtifactRoutes } from "../src/server/artifactRoutes.js";
import { httpFixture } from "./fixtures/httpFixture.js";
import Database from "better-sqlite3";
import { applySchemaThrough } from "./helpers/schemaAtVersion.js";

const SECRET = "zebra-corpus-ticket-7781";
const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore(): Promise<{ store: RunStore; home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "sf-live-home-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-live-proj-"));
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

function toolSource(access: string, body = "return { weeks: context.input && context.input.weeks };"): string {
  return `export const access = ${access};\nexport default async function execute(context) {\n  ${body}\n}\n`;
}

function functionYaml(id: string, source: string, extra = ""): string {
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
${extra}source: |
${source
  .trimEnd()
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
`;
}

async function writeFunction(project: string, id: string, source: string, extra = ""): Promise<void> {
  const file = functionFilePath(project, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, functionYaml(id, source, extra));
}

async function writeStage(
  project: string,
  functionIds: string[],
  grants: Record<string, string> = {},
): Promise<void> {
  await writeFile(
    path.join(project, "stageflow.yaml"),
    "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  tasks: []\n",
  );
  const functions =
    functionIds.length === 0
      ? "      functions: []\n"
      : `      functions:\n${functionIds
          .map((id) =>
            grants[id] === undefined
              ? `        - id: ${id}`
              : `        - id: ${id}\n          grants:\n            - id: ${grants[id]}`,
          )
          .join("\n")}\n`;
  await writeFile(
    path.join(project, "sales.pipeline.yaml"),
    `id: sales
stages:
  - id: summarize
    tools:
${functions}`,
  );
}

async function writeAgent(project: string, functionIds: string[]): Promise<void> {
  await mkdir(path.join(project, "agents"), { recursive: true });
  const functions = functionIds.map((id) => `    - id: ${id}`).join("\n");
  await writeFile(
    path.join(project, "agents", "helper.agent.yaml"),
    `id: helper
name: Helper
instructions: Help.
model:
  id: openrouter/openai/gpt-4o-mini
tools:
  functions:
${functions}
`,
  );
}

function manifest(functionId = "revenue_by_week", args: Record<string, unknown> = { weeks: 12 }, extra: Record<string, unknown> = {}) {
  return {
    format: "openui-lang",
    library: { name: "stageflow", version: "1.0.0" },
    bindings: [{ id: "rows", function: functionId, args }],
    ...extra,
  };
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

async function publishLive(
  store: RunStore,
  project: string,
  body: Record<string, unknown> = {},
) {
  const db = sqliteConnectionFromStore(store)!;
  const roots = await catalogRootsForArtifacts(store);
  return publishArtifact(db, {
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    projectRoot: project,
    id: "weekly",
    kind: "live.declarative",
    title: "Weekly",
    bytes: Buffer.from("card rows\n"),
    manifest: manifest(),
    publishSource: "api",
    roots,
    ...body,
  });
}

function storageKey(project: string): string {
  return artifactStorageKey(project, stageOwnerKey("sales", "summarize"), "weekly");
}

describe("live artifact manifest", () => {
  it("rejects a bad manifest with issue paths and accepts a valid one", () => {
    expect(validateLiveManifest(manifest(), "card rows\n").bindings[0]?.id).toBe("rows");
    const cases: Array<{ raw: unknown; program?: string; path: string }> = [
      { raw: [], path: "manifest" },
      { raw: { ...manifest(), format: "" }, path: "manifest.format" },
      { raw: { ...manifest(), library: { name: "", version: "1" } }, path: "manifest.library.name" },
      { raw: { ...manifest(), bindings: manifest().bindings.concat(manifest().bindings) }, path: "manifest.bindings[1].id" },
      { raw: { ...manifest(), bindings: [{ id: "Bad", function: "revenue_by_week", args: {} }] }, path: "manifest.bindings[0].id" },
      { raw: { ...manifest(), bindings: [{ id: "rows", function: "Not An Id", args: {} }] }, path: "manifest.bindings[0].function" },
      { raw: { ...manifest(), bindings: [{ id: "rows", function: "revenue_by_week", args: [] }] }, path: "manifest.bindings[0].args" },
      { raw: { ...manifest(), refresh: { ttl_seconds: 1 } }, path: "manifest.refresh.ttl_seconds" },
      { raw: { ...manifest(), program: "other" }, program: "card", path: "manifest.program" },
    ];
    for (const item of cases) {
      expect(() => validateLiveManifest(item.raw, item.program ?? "card rows\n"), item.path).toThrow(
        expect.objectContaining({ code: "artifact.invalid_shape" }),
      );
    }
    expect(() => validateLiveManifest(manifest(), "x".repeat(LIVE_PROGRAM_MAX_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "artifact.too_large" }),
    );
  });
});

async function setup(access = "{ network: [] }", ids = ["revenue_by_week"]) {
  const opened = await openStore();
  await writeFunction(opened.project, "revenue_by_week", toolSource(access));
  await writeStage(opened.project, ids);
  return opened;
}

describe("live artifact publish and refresh", () => {
  it("publishes a live artifact, records live on the record, and filters it", async () => {
    const { store, project } = await setup();
    const published = await publishLive(store, project, {
      manifest: manifest("revenue_by_week", { weeks: 12 }, { refresh: { on_view: true, ttl_seconds: 30 } }),
    });
    expect(published.unchanged).toBe(false);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const record = readArtifact(db, "stage:sales:summarize", "weekly", project, roots);
    expect(record.kind).toBe("live.declarative");
    expect(record.live).toMatchObject({
      status: null,
      last_refreshed_at: null,
      last_error_code: null,
      library: { name: "stageflow", version: "1.0.0" },
      refresh: { on_view: true, ttl_seconds: 30 },
      bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
    });
    expect(record.content_type).toBe("application/vnd.stageflow.openui");
    const live = listArtifacts(db, { limit: 10, live: true }, roots);
    expect(live.artifacts.map((row) => row.id)).toEqual(["weekly"]);
    const exact = listArtifacts(db, { limit: 10, kind: "live.declarative" }, roots);
    expect(exact.artifacts).toHaveLength(1);
    const family = listArtifacts(db, { limit: 10, kind: "live" }, roots);
    expect(family.artifacts).toHaveLength(1);
    const again = await publishLive(store, project, {
      title: "Weekly renamed",
      manifest: manifest("revenue_by_week", { weeks: 12 }, { refresh: { on_view: true, ttl_seconds: 30 } }),
    });
    expect(again.unchanged).toBe(true);
    expect(again.version).toBe(1);
    const changed = await publishLive(store, project, {
      manifest: manifest("revenue_by_week", { weeks: 4 }, { refresh: { on_view: true, ttl_seconds: 30 } }),
    });
    expect(changed.version).toBe(2);
  });

  it("rejects each binding rule at publish", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const attempt = (manifestBody: unknown) =>
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "weekly",
        kind: "live.declarative",
        title: "Weekly",
        bytes: Buffer.from("card\n"),
        manifest: manifestBody,
        publishSource: "api",
        roots,
      });
    await expect(attempt(manifest("missing_fn"))).rejects.toMatchObject({ code: "artifact.binding_unknown_function" });
    await writeFunction(project, "not_a_tool", "export default function execute() { return { passed: true }; }\n");
    await writeFile(
      functionFilePath(project, "not_a_tool"),
      `id: not_a_tool
name: Gate
kind: verification
source: |
  export const access = { network: [] };
  export default function execute() { return { passed: true }; }
`,
    );
    await writeStage(project, ["not_a_tool"]);
    await expect(attempt(manifest("not_a_tool", {}))).rejects.toMatchObject({ code: "artifact.binding_unknown_function" });
    await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }"));
    await writeStage(project, []);
    await expect(attempt(manifest())).rejects.toMatchObject({ code: "artifact.binding_not_granted" });
    await writeStage(project, ["revenue_by_week"]);
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource('{ network: [{ origin: "https://hooks.test", effect: "action", methods: ["POST"], path: "/" }] }'),
    );
    await expect(attempt(manifest())).rejects.toMatchObject({ code: "artifact.binding_not_read_only" });
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource('{ network: [{ origin: "https://hooks.test", effect: "read", methods: ["POST"], path: "/" }] }'),
    );
    await expect(attempt(manifest())).rejects.toMatchObject({ code: "artifact.binding_not_read_only" });
    await writeFunction(project, "revenue_by_week", toolSource('{ artifacts: "write", network: [] }'));
    await expect(attempt(manifest())).rejects.toMatchObject({ code: "artifact.binding_not_read_only" });
    await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }"));
    await expect(attempt(manifest("revenue_by_week", { weeks: "nope" }))).rejects.toMatchObject({
      code: "artifact.binding_args_invalid",
    });
  });

  it("checks stage, agent, and operator owners", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    await writeAgent(project, []);
    const roots = await catalogRootsForArtifacts(store);
    await expect(
      publishArtifact(db, {
        owner: { kind: "agent", agent: "helper" },
        projectRoot: project,
        id: "board",
        kind: "live.declarative",
        title: "Board",
        bytes: Buffer.from("card\n"),
        manifest: manifest(),
        publishSource: "api",
        roots,
      }),
    ).rejects.toMatchObject({ code: "artifact.binding_not_granted" });
    await writeAgent(project, ["revenue_by_week"]);
    const agent = await publishArtifact(db, {
      owner: { kind: "agent", agent: "helper" },
      projectRoot: project,
      id: "board",
      kind: "live.declarative",
      title: "Board",
      bytes: Buffer.from("card\n"),
      manifest: manifest(),
      publishSource: "api",
      roots,
    });
    expect(agent.key).toBe("agent:helper/board");
    const operator = await publishLive(store, project);
    expect(operator.key).toBe("stage:sales:summarize/weekly");
  });

  it("refreshes one snapshot per binding without a version or a run", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    const versionsBefore = (db.prepare(`SELECT COUNT(*) AS c FROM artifact_versions WHERE key = ?`).get(key) as { c: number }).c;
    const runsBefore = (db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }).c;
    const invoke = vi.fn(async (_root: string, input: FunctionCallInput) => {
      expect(input.historyKind).toBe("artifact");
      expect(input.input).toEqual({ kind: "tool", input: { weeks: 12 }, envelope: null });
      return okView({ weeks: 12 });
    });
    const result = await refreshArtifact(db, { projectRoot: project, invoke }, key);
    expect(result.status).toBe("fresh");
    expect(result.errors).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({ binding_id: "rows", status: "ok", value: { weeks: 12 } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1].input).toEqual({ kind: "tool", input: { weeks: 12 }, envelope: null });
    expect((db.prepare(`SELECT COUNT(*) AS c FROM artifact_versions WHERE key = ?`).get(key) as { c: number }).c).toBe(
      versionsBefore,
    );
    const after = await refreshArtifact(db, { projectRoot: project, invoke }, key);
    expect(after.snapshots).toHaveLength(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(key) as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM artifact_versions WHERE key = ?`).get(key) as { c: number }).c).toBe(
      versionsBefore,
    );
    expect((db.prepare(`SELECT COUNT(*) AS c FROM runs`).get() as { c: number }).c).toBe(runsBefore);
  });

  it("keeps the previous snapshot on failure and uses error when none succeeded", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    const invoke = vi.fn<(_root: string, input: FunctionCallInput) => Promise<FunctionRunView>>();
    invoke.mockResolvedValueOnce({ ...okView(), ok: false, value: undefined, code: "timeout", status: "failed" });
    const first = await refreshArtifact(db, { projectRoot: project, invoke }, key);
    expect(first.status).toBe("error");
    expect(first.last_error_code).toBe("timeout");
    expect(first.snapshots).toEqual([]);
    invoke.mockResolvedValueOnce(okView({ weeks: 12 }));
    await refreshArtifact(db, { projectRoot: project, invoke }, key);
    const stored = db.prepare(`SELECT value_json FROM artifact_snapshots WHERE artifact_key = ?`).get(key) as { value_json: string };
    invoke.mockResolvedValueOnce({ ...okView(), ok: false, value: undefined, code: "exception", status: "failed" });
    const failed = await refreshArtifact(db, { projectRoot: project, invoke }, key);
    expect(failed.status).toBe("stale");
    expect(failed.last_error_code).toBe("exception");
    expect(db.prepare(`SELECT value_json FROM artifact_snapshots WHERE artifact_key = ?`).get(key)).toEqual(stored);
  });

  it("does not call the executor when the function is no longer read-only", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const invoke = vi.fn(async () => okView());
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource('{ network: [{ origin: "https://hooks.test", effect: "action", methods: ["POST"], path: "/" }] }'),
    );
    const result = await refreshArtifact(db, { projectRoot: project, invoke }, storageKey(project));
    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.errors[0]?.code).toBe("artifact.binding_not_read_only");
    await writeFile(functionFilePath(project, "revenue_by_week"), "");
    const gone = await refreshArtifact(db, { projectRoot: project, invoke }, storageKey(project));
    expect(invoke).not.toHaveBeenCalled();
    expect(gone.errors[0]?.code).toBe("artifact.binding_unknown_function");
  });

  it("maps a full executor queue and an oversized snapshot", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    const limited = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async () => ({ ...okView(), ok: false, value: undefined, code: "resource_limit", status: "failed" }),
      },
      key,
    );
    expect(limited.status).toBe("error");
    expect(limited.last_error_code).toBe("artifact.resource_limit");
    const huge = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async () => okView({ blob: "a".repeat(LIVE_SNAPSHOT_MAX_BYTES) }),
      },
      key,
    );
    expect(huge.status).toBe("error");
    expect(huge.last_error_code).toBe("artifact.snapshot_too_large");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(key)).toEqual({ c: 0 });
  });

  it("records invocation kind artifact and never stores a credential", async () => {
    const { store, project } = await setup(
      '{ network: [{ origin: "https://allowed.test", effect: "read", methods: ["GET"], path: "/v1", credential: "API_TOKEN" }] }',
    );
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource(
        '{ network: [{ origin: "https://allowed.test", effect: "read", methods: ["GET"], path: "/v1", credential: "API_TOKEN" }] }',
        `const response = await context.http.request({ method: "GET", origin: "https://allowed.test", path: "/v1/status" });
  return { body: response.body, weeks: context.input.weeks };`,
      ),
    );
    await writeStage(project, ["revenue_by_week"], { revenue_by_week: "api_allowed_test" });
    await publishLive(store, project, { manifest: manifest("revenue_by_week", { weeks: 1 }) });
    const db = sqliteConnectionFromStore(store)!;
    const service = new FunctionService({ store: new FunctionStore(db) });
    await service.get(project, "revenue_by_week");
    const fixture = await httpFixture({ status: 200, body: '{"ok":true}' });
    cleanups.push(() => fixture.close());
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const invoker = createFunctionInvoker({
      db,
      env: { API_TOKEN: SECRET, STAGEFLOW_SECRET_REGISTRY: "API_TOKEN" },
      stageflowHome: path.join(project, "home"),
      lookup: async () => ["203.0.113.10"],
      dial: () =>
        new Promise((resolve, reject) => {
          const socket = netConnect({ host: "127.0.0.1", port: Number(new URL(fixture.url).port) }, () => resolve(socket));
          socket.once("error", reject);
        }),
    });
    const result = await refreshArtifact(
      db,
      { projectRoot: project, invoke: (root, input) => invoker.call(root, input) },
      storageKey(project),
    );
    errorSpy.mockRestore();
    logSpy.mockRestore();
    const history = listFunctionInvocations(db, agentProjectKey(project), "revenue_by_week");
    expect(history[0]?.kind).toBe("artifact");
    expect(`${history[0]?.status}:${history[0]?.code}:${result.last_error_code}`).toBe("succeeded:null:null");
    const dumped = JSON.stringify({
      result,
      history,
      logs,
      rows: db.prepare(`SELECT * FROM artifact_snapshots`).all(),
      rest: result,
      cli: formatArtifactRefresh(result),
      mcp: { ...result, truncated: false },
    });
    expect(dumped).not.toContain(SECRET);
    expect(JSON.stringify(result.snapshots[0]?.value)).not.toContain(SECRET);
    expect(String(fixture.requests[0]?.headers.authorization)).toContain(SECRET);
  });

  it("serializes concurrent refreshes of one key", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    let active = 0;
    let max = 0;
    const invoke = async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return okView();
    };
    await Promise.all([
      refreshArtifact(db, { projectRoot: project, invoke }, storageKey(project)),
      refreshArtifact(db, { projectRoot: project, invoke }, storageKey(project)),
    ]);
    expect(max).toBe(1);
  });

  it("hides an eval-origin live publish", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const now = "2026-11-24T00:00:00.000Z";
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at, origin)
       VALUES ('run-eval', 'sales', 'id: t\ngoal: g\n', 'succeeded', ?, ?, 'eval')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, ?, ?)`,
    ).run(agentProjectKey(project), now, now);
    await writeAgent(project, ["revenue_by_week"]);
    db.prepare(
      `INSERT INTO agent_sessions (
         session_id, project_key, agent_id, revision, backend, status, source, created_at, updated_at
       ) VALUES ('sess-eval', ?, 'helper', 1, 'pi', 'closed', 'eval', ?, ?)`,
    ).run(agentProjectKey(project), now, now);
    const roots = await catalogRootsForArtifacts(store);
    const stage = await publishSessionArtifact(
      { db, roots },
      {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        source: { runId: "run-eval", stageId: "summarize", attempt: 1 },
      },
      { id: "weekly", kind: "live.declarative", title: "Weekly", bytes: Buffer.from("card\n"), manifest: manifest() },
    );
    expect(stage.key.startsWith("eval:")).toBe(true);
    const hidden = db.prepare(`SELECT hidden FROM artifacts WHERE id = 'weekly'`).get() as { hidden: number };
    expect(hidden.hidden).toBe(1);
    expect(listArtifacts(db, { limit: 10 }, roots).artifacts).toHaveLength(0);
    const agent = await publishSessionArtifact(
      { db, roots },
      { owner: { kind: "agent", agent: "helper" }, projectRoot: project, source: { sessionId: "sess-eval" } },
      { id: "board", kind: "live.declarative", title: "Board", bytes: Buffer.from("card\n"), manifest: manifest() },
    );
    expect(agent.key.startsWith("eval:")).toBe(true);
  });
});

describe("live artifact routes and tools", () => {
  function request(body?: unknown): IncomingMessage {
    if (body === undefined) return {} as IncomingMessage;
    const payload = Buffer.from(JSON.stringify(body));
    return {
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
    } as unknown as IncomingMessage;
  }

  function captureResponse() {
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = { writeHead() {}, end() {} } as unknown as ServerResponse;
    return { res, sent };
  }

  async function call(store: RunStore, method: string, pathname: string, body?: unknown) {
    const { res, sent } = captureResponse();
    const url = new URL(pathname, "http://127.0.0.1");
    await handleArtifactRoutes(request(body), method, url.pathname, url, store, res, (response, status, payload) => {
      json(response, status, payload);
      sent.status = status;
      sent.body = payload as Record<string, unknown>;
    });
    return sent;
  }

  it("publishes, refreshes, and reads data, including ambiguity and 404", async () => {
    const { store, project } = await openStore();
    const otherDir = await mkdtemp(path.join(tmpdir(), "sf-live-other-"));
    cleanups.push(() => rm(otherDir, { recursive: true, force: true }));
    const other = await store.ensureProject(otherDir);
    for (const root of [project, other]) {
      await writeFunction(root, "revenue_by_week", toolSource("{ network: [] }"));
      await writeStage(root, ["revenue_by_week"]);
    }
    const body = {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "weekly",
      kind: "live.declarative",
      title: "Weekly",
      content: "card rows\n",
      manifest: manifest(),
    };
    expect((await call(store, "POST", "/api/artifacts", { ...body, project_root: project })).status).toBe(200);
    expect((await call(store, "POST", "/api/artifacts", { ...body, project_root: other })).status).toBe(200);
    const missing = await call(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/missing/refresh?project_root=${encodeURIComponent(project)}`,
      {},
    );
    expect(missing.status).toBe(404);
    expect(missing.body?.code).toBe("artifact.not_found");
    const ambiguous = await call(store, "GET", "/api/artifacts/stage:sales:summarize/weekly/data");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body?.code).toBe("artifact.ambiguous");
    const db = sqliteConnectionFromStore(store)!;
    const service = new FunctionService({ store: new FunctionStore(db) });
    await service.get(project, "revenue_by_week");
    const refreshed = await call(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(project)}`,
      {},
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(`${String(refreshed.body?.status)}:${String(refreshed.body?.last_error_code)}`).toBe("fresh:null");
    const data = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/data?project_root=${encodeURIComponent(project)}`,
    );
    expect(data.status).toBe(200);
    expect((data.body?.snapshots as unknown[]).length).toBe(1);
    const ambiguousRefresh = await call(store, "POST", "/api/artifacts/stage:sales:summarize/weekly/refresh", {});
    expect(ambiguousRefresh.status).toBe(409);
    expect(ambiguousRefresh.body?.code).toBe("artifact.ambiguous");
    const emptyDir = await mkdtemp(path.join(tmpdir(), "sf-live-empty-"));
    cleanups.push(() => rm(emptyDir, { recursive: true, force: true }));
    const empty = await store.ensureProject(emptyDir);
    const foreign = await call(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(empty)}`,
      {},
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body?.code).toBe("artifact.not_found");
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'file_missing' WHERE project_root_id = ? AND id = 'weekly'`).run(
      project,
    );
    const expired = await call(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/weekly/refresh?project_root=${encodeURIComponent(project)}`,
      {},
    );
    expect(expired.status).toBe(404);
    expect(expired.body?.code).toBe("artifact.content_unavailable");
    const expiredData = await call(
      store,
      "GET",
      `/api/artifacts/stage:sales:summarize/weekly/data?project_root=${encodeURIComponent(project)}`,
    );
    expect(expiredData.status).toBe(404);
    expect(expiredData.body?.code).toBe("artifact.content_unavailable");
    const staticSaved = await call(store, "POST", "/api/artifacts", {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      project_root: project,
      id: "note",
      kind: "static.text",
      title: "Note",
      content: "hello",
    });
    expect(staticSaved.status).toBe(200);
    const staticRefresh = await call(
      store,
      "POST",
      `/api/artifacts/stage:sales:summarize/note/refresh?project_root=${encodeURIComponent(project)}`,
      {},
    );
    expect(staticRefresh.status).toBe(404);
    expect(staticRefresh.body?.code).toBe("artifact.not_live");
  });

  it("stage and agent tools accept live.declarative", async () => {
    const { store, project } = await openStore();
    await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }"));
    await writeStage(project, ["revenue_by_week"]);
    const db = sqliteConnectionFromStore(store)!;
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'helper', 1, 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    await writeAgent(project, ["revenue_by_week"]);
    const roots = await catalogRootsForArtifacts(store);
    const stageBody = await publishBodyFromToolParams(
      {
        id: "weekly",
        kind: "live.declarative",
        title: "Weekly",
        content: "card rows\n",
        format: "openui-lang",
        library: { name: "stageflow", version: "1.0.0" },
        bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
        refresh: { ttl_seconds: 30 },
      },
      async () => Buffer.from(""),
    );
    const stage = await publishSessionArtifact(
      { db, roots },
      { owner: { kind: "stage", pipeline: "sales", stage: "summarize" }, projectRoot: project, source: {} },
      stageBody,
    );
    expect(stage.version).toBe(1);
    const tool = createAgentPublishArtifactTool({
      agentId: "helper",
      projectRoot: project,
      stageflowHome: path.join(project, "home"),
      publish: (body) =>
        publishSessionArtifact(
          { db, roots },
          { owner: { kind: "agent", agent: "helper" }, projectRoot: project, source: { sessionId: "sess-1" } },
          body,
        ),
    });
    const agent = await tool.execute("call-1", {
      id: "board",
      kind: "live.declarative",
      title: "Board",
      content: "card rows\n",
      format: "openui-lang",
      library: { name: "stageflow", version: "1.0.0" },
      bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
    });
    expect(agent.isError).toBeUndefined();
    expect(JSON.parse(agent.content[0]!.text).key).toBe("agent:helper/board");
  });
});

describe("live artifact fix pass", () => {
  it("runs the revision that was checked when the file changes before the call", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const invoker = createFunctionInvoker({
      db,
      stageflowHome: path.join(project, "home"),
      lookup: async () => ["203.0.113.10"],
    });
    const result = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async (root, input) => {
          expect(input.revision).toBeGreaterThan(0);
          await writeFunction(
            project,
            "revenue_by_week",
            toolSource(
              '{ network: [{ origin: "https://hooks.test", effect: "action", methods: ["POST"], path: "/" }] }',
              "return { edited: true };",
            ),
          );
          return invoker.call(root, input);
        },
      },
      storageKey(project),
    );
    expect(result.errors).toEqual([]);
    expect(result.snapshots[0]?.value).toEqual({ weeks: 12 });
    expect(JSON.stringify(result)).not.toContain("edited");
  });

  it("rejects an empty binding list and scores status from every binding", async () => {
    const { store, project } = await setup();
    const both = {
      ...manifest(),
      bindings: [
        { id: "rows", function: "revenue_by_week", args: { weeks: 12 } },
        { id: "cols", function: "revenue_by_week", args: { weeks: 4 } },
      ],
    };
    await publishLive(store, project, { manifest: both });
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    await expect(refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key, { bindingIds: [] })).rejects.toMatchObject({
      code: "artifact.invalid_shape",
      status: 400,
    });
    const subset = await refreshArtifact(
      db,
      { projectRoot: project, invoke: async () => okView({ weeks: 12 }) },
      key,
      { bindingIds: ["rows"] },
    );
    expect(subset.status).toBe("stale");
    expect(subset.last_refreshed_at).toEqual(expect.any(String));
    expect(subset.errors).toEqual([]);
    expect(subset.snapshots.map((row) => row.binding_id)).toEqual(["rows"]);
    const partial = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async (_root, input) => {
          const args = (input.input as { input?: { weeks?: number } }).input;
          if (args?.weeks === 4) return { ...okView(), ok: false, value: undefined, code: "timeout", status: "failed" };
          return okView({ weeks: 12 });
        },
      },
      key,
    );
    expect(partial.status).toBe("stale");
    expect(partial.last_error_code).toBe("timeout");
    expect(partial.last_refreshed_at).toEqual(expect.any(String));
    expect(partial.snapshots.map((row) => row.binding_id).sort()).toEqual(["rows"]);
  });

  it("drops snapshots that are not in a new manifest and leaves an unchanged republish alone", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    await refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key);
    db.prepare(
      `INSERT INTO artifact_snapshots (
         artifact_key, binding_id, args_hash, value_json, fetched_at, duration_ms, status
       ) VALUES (?, 'rows', 'old-hash', '{"n":1}', '2020-01-01T00:00:00.000Z', 1, 'ok')`,
    ).run(key);
    await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: 3 }) }, key);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(key)).toEqual({ c: 1 });
    const same = await publishLive(store, project, { title: "Weekly renamed" });
    expect(same.unchanged).toBe(true);
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "fresh" });
    const next = await publishLive(store, project, {
      bytes: Buffer.from("other card\n"),
      manifest: manifest("revenue_by_week", { weeks: 4 }),
    });
    expect(next.version).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(key)).toEqual({ c: 0 });
    expect(db.prepare(`SELECT live_status, last_error_code, last_refreshed_at FROM artifacts WHERE key = ?`).get(key)).toEqual({
      live_status: null,
      last_error_code: null,
      last_refreshed_at: null,
    });
  });

  it("discards a refresh when the artifact is deleted or republished while the function runs", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const key = storageKey(project);
    await expect(
      refreshArtifact(
        db,
        {
          projectRoot: project,
          invoke: async () => {
            await deletePublishedArtifact(db, "stage:sales:summarize", "weekly", project, roots);
            return okView({ weeks: 99 });
          },
        },
        key,
      ),
    ).rejects.toMatchObject({ code: "artifact.not_found" });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots`).get()).toEqual({ c: 0 });
    const again = await publishLive(store, project);
    expect(again.version).toBe(1);
    expect(readArtifact(db, "stage:sales:summarize", "weekly", project, roots).live?.status ?? null).toBeNull();

    await publishLive(store, project);
    const replaced = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async () => {
          await publishLive(store, project, { bytes: Buffer.from("card rows next\n") });
          return okView({ stale: true });
        },
      },
      storageKey(project),
    );
    expect(replaced.status).toBeNull();
    expect(JSON.stringify(replaced.snapshots)).not.toContain("stale");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(storageKey(project))).toEqual({
      c: 0,
    });
  });

  it("leaves a terminal status when refresh throws, and recovers a refreshing row at startup", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    let thrown = false;
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("live_status = @status") && !thrown) {
        thrown = true;
        throw new Error("db down");
      }
      return realPrepare(sql);
    }) as typeof db.prepare);
    await expect(refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key)).rejects.toThrow(/db down/);
    spy.mockRestore();
    expect(db.prepare(`SELECT live_status, last_error_code FROM artifacts WHERE key = ?`).get(key)).toEqual({
      live_status: "error",
      last_error_code: "artifact.refresh_failed",
    });
    db.prepare(`UPDATE artifacts SET live_status = 'refreshing', last_error_code = NULL WHERE key = ?`).run(key);
    expect(recoverRefreshingArtifacts(db)).toBe(1);
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "error" });
    db.prepare(
      `UPDATE artifacts SET live_status = 'refreshing', updated_at = '2020-01-01T00:00:00.000Z' WHERE key = ?`,
    ).run(key);
    await repairMissingIndexed(db, () => project, "2026-11-24T00:00:00.000Z", 10, "");
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "error" });
    const deep = await refreshArtifact(
      db,
      {
        projectRoot: project,
        invoke: async () => {
          let value: unknown = { ok: true };
          for (let index = 0; index < 5000; index += 1) value = { child: value };
          return okView(value);
        },
      },
      key,
    );
    expect(deep.last_error_code).toBe("artifact.refresh_failed");
    expect(deep.status).not.toBe("refreshing");
    const wide = await refreshArtifact(
      db,
      { projectRoot: project, invoke: async () => okView({ items: new Array(1_000_000).fill(1) }) },
      key,
    );
    expect(wide.last_error_code).toBe("artifact.snapshot_too_large");
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).not.toEqual({ live_status: "refreshing" });
    expect(SNAPSHOT_MAX_DEPTH).toBe(64);
  });

  it("scrubs secret-named fields without changing the JSON shape", () => {
    const value = scrubSnapshotValue({
      rows: [1, 2, 3],
      password: "hunter2",
      api_key: "k",
      authorization: "Bearer x",
      token: { nested: true },
      note: "token=zebra-corpus-ticket-7781",
      count: 2,
      ok: true,
      empty: null,
      items: [{ label: "keep", password: "nope" }],
    });
    expect(value).toEqual({
      rows: [1, 2, 3],
      password: "[redacted]",
      api_key: "[redacted]",
      authorization: "[redacted]",
      token: "[redacted]",
      note: expect.stringContaining("[redacted]"),
      count: 2,
      ok: true,
      empty: null,
      items: [{ label: "keep", password: "[redacted]" }],
    });
    expect(JSON.parse(JSON.stringify(value))).toMatchObject({ rows: [1, 2, 3], count: 2, ok: true, empty: null });
  });

  it("checks output_schema and passes only the attachment grants", async () => {
    const { store, project } = await setup();
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource("{ network: [] }"),
      `output_schema:
  type: object
  properties:
    weeks:
      type: integer
  required: [weeks]
  additionalProperties: false
`,
    );
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    const good = await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: 12 }) }, key);
    expect(good.status).toBe("fresh");
    const bad = await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ weeks: "no" }) }, key);
    expect(bad.status).toBe("stale");
    expect(bad.last_error_code).toBe("invalid_output");
    expect(bad.snapshots[0]?.value).toEqual({ weeks: 12 });
    await writeFunction(project, "revenue_by_week", toolSource("{ network: [] }"));
    const open = await refreshArtifact(db, { projectRoot: project, invoke: async () => okView({ extra: true }) }, key);
    expect(open.status).toBe("fresh");
    await writeFunction(
      project,
      "revenue_by_week",
      toolSource('{ network: [{ origin: "https://allowed.test", effect: "read", methods: ["GET"], path: "/v1" }] }'),
    );
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales
stages:
  - id: summarize
    tools:
      functions:
        - id: revenue_by_week
          grants: []
`,
    );
    const narrowed = vi.fn(async () => okView());
    await refreshArtifact(db, { projectRoot: project, invoke: narrowed }, key);
    expect(narrowed.mock.calls[0]?.[1].grants).toEqual([]);
    await writeStage(project, ["revenue_by_week"], { revenue_by_week: "api_allowed_test" });
    const granted = vi.fn(async () => okView());
    await refreshArtifact(db, { projectRoot: project, invoke: granted }, key);
    expect(granted.mock.calls[0]?.[1].grants).toEqual([{ id: "api_allowed_test" }]);
  });

  it("names why an owner does not hold a function", async () => {
    const { store, project } = await setup();
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const attempt = () =>
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "weekly",
        kind: "live.declarative",
        title: "Weekly",
        bytes: Buffer.from("card\n"),
        manifest: manifest(),
        publishSource: "api",
        roots,
      });
    await rm(path.join(project, "stageflow.yaml"));
    await expect(attempt()).rejects.toThrow(/no stageflow\.yaml/);
    await writeFile(
      path.join(project, "stageflow.yaml"),
      "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines: []\n  tasks: []\n",
    );
    await expect(attempt()).rejects.toThrow(/catalog\.pipelines/);
    await writeStage(project, ["revenue_by_week"]);
    await writeFile(path.join(project, "sales.pipeline.yaml"), "id: other\nstages:\n  - id: summarize\n");
    await expect(attempt()).rejects.toThrow(/not found in the catalog/);
    await writeFile(
      path.join(project, "stageflow.yaml"),
      "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  exclude:\n    - sales.pipeline.yaml\n  tasks: []\n",
    );
    await writeStage(project, ["revenue_by_week"]);
    await writeFile(
      path.join(project, "stageflow.yaml"),
      "version: 1\nmodel: openrouter/openai/gpt-4o-mini\ncatalog:\n  pipelines:\n    - .\n  exclude:\n    - sales.pipeline.yaml\n  tasks: []\n",
    );
    await expect(attempt()).rejects.toThrow(/excluded from the catalog/);
    await writeStage(project, ["revenue_by_week"]);
    await writeFile(path.join(project, "sales.pipeline.yaml"), "id: sales\nstages:\n  - id: other\n");
    await expect(attempt()).rejects.toThrow(/Stage summarize was not found/);
    await writeFile(path.join(project, "broken.stage.yaml"), ":\n  - [");
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales
stages:
  - id: summarize
    uses: broken.stage.yaml
    tools:
      functions:
        - id: revenue_by_week
`,
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(attempt()).rejects.toThrow(/could not be parsed/);
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
    await writeFile(
      path.join(project, "sales.pipeline.yaml"),
      `id: sales
stages:
  - id: other
    uses: broken.stage.yaml
  - id: summarize
    tools:
      functions:
        - id: revenue_by_week
`,
    );
    const continued = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const published = await attempt();
    continued.mockRestore();
    expect(published.version).toBe(1);
    await writeFile(
      path.join(project, "a.pipeline.yaml"),
      `id: sales
stages:
  - id: summarize
    tools:
      functions: []
`,
    );
    await expect(
      publishArtifact(db, {
        owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
        projectRoot: project,
        id: "second",
        kind: "live.declarative",
        title: "Second",
        bytes: Buffer.from("card\n"),
        manifest: manifest(),
        publishSource: "api",
        roots,
      }),
    ).rejects.toThrow(/only a\.pipeline\.yaml is the pipeline/);
    await writeFile(
      path.join(project, "a.pipeline.yaml"),
      `id: sales
stages:
  - id: summarize
    tools:
      functions:
        - id: revenue_by_week
`,
    );
    const fromCanonical = await publishArtifact(db, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: project,
      id: "third",
      kind: "live.declarative",
      title: "Third",
      bytes: Buffer.from("card\n"),
      manifest: manifest(),
      publishSource: "api",
      roots,
    });
    expect(fromCanonical.version).toBe(1);
    db.prepare(
      `INSERT INTO agent_definitions (project_key, agent_id, current_revision, archived, created_at, updated_at)
       VALUES (?, 'missing', 1, 0, '2026-11-24T00:00:00.000Z', '2026-11-24T00:00:00.000Z')`,
    ).run(agentProjectKey(project));
    await expect(
      publishArtifact(db, {
        owner: { kind: "agent", agent: "missing" },
        projectRoot: project,
        id: "board",
        kind: "live.declarative",
        title: "Board",
        bytes: Buffer.from("card\n"),
        manifest: manifest(),
        publishSource: "api",
        roots,
      }),
    ).rejects.toThrow(/Agent missing was not found/);
  });

  it("refuses another waiter past 32 and removes snapshots when an indexed row is deleted", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const invoke = async () => {
      started();
      await gate;
      return okView();
    };
    const first = refreshArtifact(db, { projectRoot: project, invoke }, key);
    await entered;
    const waiting = Array.from({ length: 32 }, () => refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key));
    await expect(refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key)).rejects.toMatchObject({
      code: "artifact.resource_limit",
    });
    release();
    await Promise.all([first, ...waiting]);
    const now = "2026-11-24T00:00:00.000Z";
    db.prepare(
      `INSERT INTO runs (run_id, pipeline_id, task_yaml, status, created_at, updated_at)
       VALUES ('run-idx', 'sales', 'id: t\ngoal: g\n', 'succeeded', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO artifacts (
         key, owner_kind, owner_pipeline, owner_stage, project_root_id, id, title, tags_json,
         kind, origin, current_version, hidden, created_at, updated_at, source_run_id, source_stage_id, source_attempt
       ) VALUES (
         'indexed-live', 'stage', 'sales', 'summarize', ?, 'indexedid', 'Indexed', '[]',
         'static.text', 'indexed', 1, 0, ?, ?, 'run-idx', 'summarize', 1
       )`,
    ).run(project, now, now);
    db.prepare(
      `INSERT INTO artifact_snapshots (
         artifact_key, binding_id, args_hash, value_json, fetched_at, duration_ms, status
       ) VALUES ('indexed-live', 'rows', 'h', '{"n":1}', ?, 1, 'ok')`,
    ).run(now);
    await indexDeclaredDeliverables({
      db,
      store,
      runId: "run-idx",
      stageId: "summarize",
      attempt: 1,
      envelope: { status: "failed", artifacts: [] } as never,
    });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = 'indexed-live'`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE key = 'indexed-live'`).get()).toEqual({ c: 0 });
  });

  it("refuses an expired artifact and a key from another project", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'file_missing' WHERE key = ?`).run(key);
    await expect(refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key)).rejects.toMatchObject({
      status: 404,
      code: "artifact.content_unavailable",
    });
    db.prepare(`UPDATE artifacts SET status = 'available', expired_reason = NULL WHERE key = ?`).run(key);
    const other = await mkdtemp(path.join(tmpdir(), "sf-live-other-"));
    cleanups.push(() => rm(other, { recursive: true, force: true }));
    await expect(refreshArtifact(db, { projectRoot: other, invoke: async () => okView() }, key)).rejects.toMatchObject({
      code: "artifact.not_found",
    });
  });

  it("lets delete and publish queue past the refresh waiter cap", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const roots = await catalogRootsForArtifacts(store);
    const key = storageKey(project);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slowInvoke = async () => {
      started();
      await gate;
      return okView();
    };
    const slow = refreshArtifact(db, { projectRoot: project, invoke: slowInvoke }, key);
    await entered;
    const waiting = Array.from({ length: 32 }, () =>
      refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key).catch((error) => error),
    );
    await expect(refreshArtifact(db, { projectRoot: project, invoke: async () => okView() }, key)).rejects.toMatchObject({
      code: "artifact.resource_limit",
    });
    const publishUnderLoad = publishLive(store, project, { title: "Under load" });
    const deletePromise = deletePublishedArtifact(db, "stage:sales:summarize", "weekly", project, roots);
    release();
    const settled = await Promise.all([publishUnderLoad, deletePromise, slow]);
    expect(settled[0]).toMatchObject({ version: expect.any(Number) });
    expect(settled[1]).toMatchObject({ key: expect.any(String) });
    expect(settled[2]).toMatchObject({ status: expect.any(String) });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM artifact_snapshots WHERE artifact_key = ?`).get(key)).toEqual({ c: 0 });
    for (const outcome of await Promise.all(waiting)) {
      expect(outcome).toMatchObject({ code: "artifact.not_found" });
    }
  });

  it("rejects a huge snapshot before scrubbing", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    const huge = "x".repeat(50 * 1024 * 1024);
    const started = Date.now();
    const result = await refreshArtifact(
      db,
      { projectRoot: project, invoke: async () => okView(huge) },
      key,
    );
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.last_error_code).toBe("artifact.snapshot_too_large");
  });

  it("sweep recovery skips in-flight refresh and resets only stale refreshing rows", async () => {
    const { store, project } = await setup();
    await publishLive(store, project);
    const db = sqliteConnectionFromStore(store)!;
    const key = storageKey(project);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = refreshArtifact(db, {
      projectRoot: project,
      invoke: async () => {
        started();
        await gate;
        return okView();
      },
    }, key);
    await entered;
    db.prepare(`UPDATE artifacts SET updated_at = '2020-01-01T00:00:00.000Z' WHERE key = ?`).run(key);
    expect(recoverRefreshingArtifacts(db, "sweep", Date.parse("2026-11-24T00:00:00.000Z"))).toBe(0);
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "refreshing" });
    release();
    await slow;
    db.prepare(`DELETE FROM artifact_snapshots WHERE artifact_key = ?`).run(key);
    db.prepare(`UPDATE artifacts SET live_status = 'refreshing', updated_at = '2020-01-01T00:00:00.000Z' WHERE key = ?`).run(key);
    expect(recoverRefreshingArtifacts(db, "sweep", Date.parse("2026-11-24T00:00:00.000Z"))).toBe(1);
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "error" });
    db.prepare(`UPDATE artifacts SET live_status = 'refreshing', updated_at = '2020-01-01T00:00:00.000Z' WHERE key = ?`).run(key);
    expect(recoverRefreshingArtifacts(db)).toBe(1);
    expect(db.prepare(`SELECT live_status FROM artifacts WHERE key = ?`).get(key)).toEqual({ live_status: "error" });
  });
});

describe("migration 029", () => {
  it("adds snapshots on a fresh store and on a store at version 28", async () => {
    const fresh = await openStore();
    const freshDb = sqliteConnectionFromStore(fresh.store)!;
    expect(freshDb.pragma("user_version", { simple: true })).toBe(29);
    expect(freshDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'artifact_snapshots'`).get()).toBeTruthy();
    const cols = freshDb.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toEqual(expect.arrayContaining(["live_status", "last_refreshed_at", "last_error_code"]));

    const home = await mkdtemp(path.join(tmpdir(), "sf-live-v28-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    const db = new Database(path.join(home, "state.db"));
    applySchemaThrough(db, 28);
    db.prepare(
      `INSERT INTO function_invocations (
         id, project_key, function_id, revision, source_hash, kind, status, duration_ms, created_at
       ) VALUES ('old', 'proj', 'revenue_by_week', 1, 'abc', 'tool', 'succeeded', 3, '2026-11-24T00:00:00.000Z')`,
    ).run();
    db.close();
    cleanups.push(async () => {
      await rm(home, { recursive: true, force: true });
    });
    const migrated = createRunStore({ rootDir: home });
    cleanups.push(() => migrated.close());
    const migratedDb = sqliteConnectionFromStore(migrated)!;
    expect(migratedDb.pragma("user_version", { simple: true })).toBe(29);
    expect(migratedDb.prepare(`SELECT kind FROM function_invocations WHERE id = 'old'`).get()).toEqual({ kind: "tool" });
    migratedDb.prepare(
      `INSERT INTO function_invocations (
         id, project_key, function_id, revision, source_hash, kind, status, duration_ms, created_at
       ) VALUES ('new', 'proj', 'revenue_by_week', 1, 'abc', 'artifact', 'succeeded', 4, '2026-11-24T00:00:01.000Z')`,
    ).run();
    expect(() =>
      migratedDb.prepare(
        `INSERT INTO function_invocations (
           id, project_key, function_id, revision, source_hash, kind, status, duration_ms, created_at
         ) VALUES ('bad', 'proj', 'revenue_by_week', 1, 'abc', 'nope', 'succeeded', 4, '2026-11-24T00:00:02.000Z')`,
      ).run(),
    ).toThrow(/CHECK/);
  });
});
