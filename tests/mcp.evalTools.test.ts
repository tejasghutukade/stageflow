import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { handleMcpHttpRequest } from "../src/mcp/server.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const EVAL_TOOLS = [
  "list_evals",
  "get_eval",
  "validate_eval",
  "run_eval",
  "get_eval_run",
  "list_eval_runs",
  "get_eval_results",
  "get_eval_result",
  "cancel_eval_run",
  "compare_eval_runs",
];

function evalYaml(id = "review"): string {
  return `version: 1
id: ${id}
type: capability
target:
  kind: stage
  pipeline: ../pipelines/feature-ship.pipeline.yaml
  stage: review
dataset: ../datasets/review.dataset.jsonl
task:
  goal: Review the change.
defaults:
  repeats: 2
  pass_threshold: 0.7
  max_cost_usd: 5
  concurrency: 1
  judge: anthropic/claude-sonnet-4-5
graders:
  - id: verdict-ok
    type: field
    checks:
      - { path: "payload.verdict", op: equals, value: ok }
`;
}

function fakeRunner(state: { verdict: string; delayMs: number }) {
  const cancelled = new Set<string>();
  const wakers = new Set<() => void>();
  const runner: StageCaseRunner & { state: typeof state } = {
    state,
    async runCase(_plan: EvalPlan, req): Promise<RunCaseResult> {
      if (cancelled.has(req.evalRunId)) return { ok: false, code: "EVAL_CANCELLED", message: "cancelled" };
      if (state.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            wakers.delete(done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, state.delayMs);
          wakers.add(done);
        });
        if (cancelled.has(req.evalRunId)) return { ok: false, code: "EVAL_CANCELLED", message: "cancelled" };
      }
      return {
        ok: true,
        stageRunId: `sr_${req.evalRunId}_${req.caseId}_${req.repeatIndex}`,
        output: {
          kind: "envelope",
          status: "success",
          summary: "done",
          payload: { verdict: state.verdict },
          artifacts: [],
        },
        latencyMs: 10,
        costUsd: 0.01,
        tokensIn: 5,
        tokensOut: 2,
      };
    },
    async cancelAll(evalRunId) {
      cancelled.add(evalRunId);
      for (const wake of [...wakers]) wake();
    },
    spend: () => 0,
    addSpend: () => undefined,
  };
  return runner;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function setup(opts: { withManager?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-evals-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-evals-home-"));
  bindStageflowHomeForTests(home);
  for (const dir of ["pipelines", "stages", "evals", "datasets"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(
    path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"),
    path.join(root, "pipelines", "feature-ship.pipeline.yaml"),
  );
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
  );
  const cases = [
    { id: "c1", title: "null deref", input: { diff: "diff c1" }, tags: ["smoke"] },
    { id: "c2", input: { diff: "diff c2" } },
    { id: "c3", input: { diff: "diff c3" } },
  ];
  await writeFile(
    path.join(root, "datasets", "review.dataset.jsonl"),
    cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );
  await writeFile(path.join(root, "evals", "review.eval.yaml"), evalYaml());

  const store = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  const runner = fakeRunner({ verdict: "ok", delayMs: 0 });
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: runner,
    engines: () => new FakeEngine(),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
  });
  const engine = {
    installed: true,
    version: "0.124.0",
    pinned: "0.124.0",
    node: "22.22.0",
    nodeOk: true,
    path: "/engine",
    installCommand: "sf eval engine install",
  };
  const apiDeps: EvalRoutesDeps = {
    cwd: root,
    store,
    manager: {} as unknown as RunManager,
    evalRunManager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => engine,
  };
  const mcpDeps = {
    manager: {} as unknown as RunManager,
    store,
    cwd: root,
    ...(opts.withManager === false ? {} : { evalRunManager }),
    evalEngineStatus: () => engine,
  };
  const server: Server = createServer((req, res) => {
    const handle = req.url?.startsWith("/mcp")
      ? handleMcpHttpRequest(req, res, mcpDeps).then(() => true)
      : handleEvalRoutes(req, res, apiDeps);
    handle.then(
      (handled) => {
        if (!handled) json(res, 404, { error: "Not found" });
      },
      () => json(res, 500, { error: "unhandled" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const api = async (urlPath: string) => (await fetch(`${base}${urlPath}`)).json() as Promise<any>;
  const tool = (name: string, args: Record<string, unknown> = {}) => mcpCall(base, name, args);
  return { base, root, store, runner, manager: evalRunManager, engine, api, tool, q: `project_root=${encodeURIComponent(root)}` };
}

describe("MCP eval tools", () => {
  it("registers all ten tools with descriptions that state cost", async () => {
    const h = await setup();
    const res = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    const tools = data.result.tools as Array<{ name: string; description: string }>;
    for (const name of EVAL_TOOLS) expect(tools.map((t) => t.name)).toContain(name);
    const runEval = tools.find((t) => t.name === "run_eval")!;
    expect(runEval.description).toMatch(/calls models/i);
    expect(runEval.description).toMatch(/money/i);
    expect(runEval.description).toMatch(/wait false/i);
  });

  it("run_eval wait:false returns only the id fast; get_eval_run equals the API", async () => {
    const h = await setup();
    const started = await h.tool("run_eval", { eval_id: "review", project_root: h.root });
    expect(started.isError).toBe(false);
    expect(Object.keys(started.payload)).toEqual(["eval_run_id"]);
    const id = started.payload.eval_run_id as string;
    await h.manager.awaitFinished(id, 15_000);
    const viaMcp = await h.tool("get_eval_run", { eval_run_id: id });
    expect(viaMcp.payload).toEqual(await h.api(`/api/eval-runs/${id}`));
    expect(viaMcp.payload.status).toBe("completed");
  });

  it("run_eval wait:true returns the finished detail", async () => {
    const h = await setup();
    const res = await h.tool("run_eval", { eval_id: "review", project_root: h.root, wait: true, repeats: 1, label: "via mcp" });
    expect(res.isError).toBe(false);
    expect(res.payload.status).toBe("completed");
    expect(res.payload).toEqual(await h.api(`/api/eval-runs/${res.payload.eval_run_id}`));
    const row = await h.store.getEvalRun(res.payload.eval_run_id);
    expect(row?.startedVia).toBe("mcp");
  });

  it("run_eval with a short timeout returns status timeout, then cancel_eval_run stops it", async () => {
    const h = await setup();
    h.runner.state.delayMs = 5000;
    const res = await h.tool("run_eval", { eval_id: "review", project_root: h.root, wait: true, timeout_ms: 30 });
    expect(res.isError).toBe(false);
    expect(res.payload).toEqual({ eval_run_id: expect.any(String), status: "timeout" });
    const cancelled = await h.tool("cancel_eval_run", { eval_run_id: res.payload.eval_run_id });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.payload.status).toBe("cancelled");
    expect(cancelled.payload).toEqual(await h.api(`/api/eval-runs/${res.payload.eval_run_id}`));
  });

  it("run_eval on an invalid eval returns an error result with findings", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "evals", "broken.eval.yaml"), "version: 1\nid: broken\n");
    const res = await h.tool("run_eval", { eval_id: "broken", project_root: h.root });
    expect(res.isError).toBe(true);
    expect(res.payload.code).toBe("EVAL_INVALID");
    expect(Array.isArray(res.payload.findings)).toBe(true);
    expect(res.payload.findings.length).toBeGreaterThan(0);
  });

  it("run_eval fails when the engine is unavailable", async () => {
    const h = await setup();
    h.engine.installed = false;
    const res = await h.tool("run_eval", { eval_id: "review", project_root: h.root });
    expect(res.isError).toBe(true);
    expect(res.payload.code).toBe("EVAL_ENGINE_UNAVAILABLE");
  });

  it("read tools return the same objects as the API", async () => {
    const h = await setup();
    const a = await h.tool("run_eval", { eval_id: "review", project_root: h.root, wait: true });
    const b = await h.tool("run_eval", { eval_id: "review", project_root: h.root, wait: true });
    const idA = a.payload.eval_run_id as string;
    const idB = b.payload.eval_run_id as string;

    const list = await h.tool("list_evals", { project_root: h.root });
    expect(list.payload).toEqual({ items: (await h.api(`/api/evals?${h.q}`)).items });
    expect(list.payload.items[0].id).toBe("review");

    const detail = await h.tool("get_eval", { eval_id: "review", project_root: h.root });
    expect(detail.payload).toEqual(await h.api(`/api/evals/review?${h.q}`));

    const runs = await h.tool("list_eval_runs", { eval_id: "review", status: "completed", limit: 10 });
    const apiRuns = await h.api(`/api/eval-runs?eval_id=review&status=completed&limit=10`);
    expect(runs.payload).toEqual({ items: apiRuns.items });
    expect(runs.payload.items).toHaveLength(2);

    const results = await h.tool("get_eval_results", { eval_run_id: idA, limit: 2 });
    const apiResults = await h.api(`/api/eval-runs/${idA}/results?limit=2`);
    expect(results.payload).toEqual({ items: apiResults.items, next_cursor: apiResults.next_cursor });
    expect(results.payload.next_cursor).not.toBeNull();
    const page2 = await h.tool("get_eval_results", { eval_run_id: idA, limit: 2, cursor: results.payload.next_cursor });
    expect(page2.payload.items).toHaveLength(1);

    const one = await h.tool("get_eval_result", { eval_run_id: idA, case_id: "c1" });
    expect(one.payload).toEqual(await h.api(`/api/eval-runs/${idA}/results/c1`));
    expect(one.payload.repeats).toHaveLength(2);

    const compare = await h.tool("compare_eval_runs", { a: idA, b: idB });
    expect(compare.isError).toBe(false);
    expect(compare.payload).toEqual(await h.api(`/api/eval-compare?a=${idA}&b=${idB}`));
  });

  it("validate_eval by id and by yaml returns findings and writes no files", async () => {
    const h = await setup();
    const before = await readdir(path.join(h.root, "evals"));
    const byId = await h.tool("validate_eval", { eval_id: "review", project_root: h.root });
    expect(byId.isError).toBe(false);
    expect(byId.payload.findings.every((f: any) => f.severity !== "error")).toBe(true);
    const bad = await h.tool("validate_eval", { yaml: "version: 1\nid: nope\n", project_root: h.root });
    expect(bad.isError).toBe(false);
    expect(bad.payload.findings.length).toBeGreaterThan(0);
    const good = await h.tool("validate_eval", { yaml: await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8"), project_root: h.root });
    expect(good.payload).toEqual(byId.payload);
    const neither = await h.tool("validate_eval", { project_root: h.root });
    expect(neither.isError).toBe(true);
    expect(neither.content.map((block) => block.text ?? "").join("\n")).toMatch(/Invalid input/);
    expect(await readdir(path.join(h.root, "evals"))).toEqual(before);
  });

  it("unknown ids give EVAL_NOT_FOUND and EVAL_RUN_NOT_FOUND", async () => {
    const h = await setup();
    for (const [name, args, code] of [
      ["get_eval", { eval_id: "nope", project_root: h.root }, "EVAL_NOT_FOUND"],
      ["validate_eval", { eval_id: "nope", project_root: h.root }, "EVAL_NOT_FOUND"],
      ["run_eval", { eval_id: "nope", project_root: h.root }, "EVAL_NOT_FOUND"],
      ["get_eval_run", { eval_run_id: "er_nope" }, "EVAL_RUN_NOT_FOUND"],
      ["get_eval_results", { eval_run_id: "er_nope" }, "EVAL_RUN_NOT_FOUND"],
      ["get_eval_result", { eval_run_id: "er_nope", case_id: "c1" }, "EVAL_RUN_NOT_FOUND"],
      ["cancel_eval_run", { eval_run_id: "er_nope" }, "EVAL_RUN_NOT_FOUND"],
      ["compare_eval_runs", { a: "er_nope", b: "er_nope2" }, "EVAL_RUN_NOT_FOUND"],
    ] as const) {
      const res = await h.tool(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.payload.code, name).toBe(code);
    }
  });

  it("answers EVAL_ENGINE_UNAVAILABLE when the host has no eval manager", async () => {
    const h = await setup({ withManager: false });
    const res = await h.tool("list_evals", { project_root: h.root });
    expect(res.isError).toBe(true);
    expect(res.payload.code).toBe("EVAL_ENGINE_UNAVAILABLE");
  });
});
