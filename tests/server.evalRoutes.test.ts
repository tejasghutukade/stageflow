import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalEngine, EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { startTestService } from "./helpers/testInProcessService.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

type Api = { status: number; body: any; headers: Headers; text: string };

type Harness = {
  root: string;
  store: RunStore;
  manager: EvalRunManager;
  runner: ReturnType<typeof fakeRunner>;
  deletedRuns: string[];
  call: (method: string, urlPath: string, body?: unknown) => Promise<Api>;
  get: (urlPath: string) => Promise<Api>;
  post: (urlPath: string, body?: unknown) => Promise<Api>;
  setEngine: (status: Partial<EngineStatusShape>) => void;
  setEngineFactory: (engine: () => EvalEngine) => void;
};

type EngineStatusShape = {
  installed: boolean;
  version: string | null;
  pinned: string;
  node: string;
  nodeOk: boolean;
  path: string | null;
  installCommand: string;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function evalYaml(id = "review", extra: { type?: string; rubric?: string } = {}): string {
  return `version: 1
id: ${id}
type: ${extra.type ?? "capability"}
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
${extra.rubric ?? ""}`;
}

function fakeRunner(state: { verdict: (caseId: string, repeat: number) => string; delayMs: number }) {
  const spend = new Map<string, number>();
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
      spend.set(req.evalRunId, (spend.get(req.evalRunId) ?? 0) + 0.01);
      return {
        ok: true,
        stageRunId: `sr_${req.evalRunId}_${req.caseId}_${req.repeatIndex}`,
        output: {
          kind: "envelope",
          status: "success",
          summary: "done",
          payload: { verdict: state.verdict(req.caseId, req.repeatIndex) },
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
    spend: (evalRunId) => spend.get(evalRunId) ?? 0,
    addSpend(evalRunId, usd) {
      spend.set(evalRunId, (spend.get(evalRunId) ?? 0) + usd);
    },
  };
  return runner;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function setup(opts: { sampleSourceDir?: string } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-eval-routes-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-eval-routes-home-"));
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
    { id: "c4", input: { diff: "diff c4" } },
    { id: "c5", input: { diff: "diff c5" } },
    { id: "bad", input: { nope: 1 } },
  ];
  await writeFile(
    path.join(root, "datasets", "review.dataset.jsonl"),
    cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
  );
  await writeFile(path.join(root, "evals", "review.eval.yaml"), evalYaml());

  const store = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  const runner = fakeRunner({ verdict: () => "ok", delayMs: 0 });
  let engineFactory: () => EvalEngine = () => new FakeEngine();
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: runner,
    engines: () => engineFactory(),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
  });
  const deletedRuns: string[] = [];
  const status: EngineStatusShape = {
    installed: true,
    version: "0.124.0",
    pinned: "0.124.0",
    node: "22.22.0",
    nodeOk: true,
    path: "/engine",
    installCommand: "sf eval engine install",
  };
  const deps: EvalRoutesDeps = {
    cwd: root,
    store,
    manager: {
      deleteRun: async (runId: string) => {
        deletedRuns.push(runId);
        return { ok: true, runId };
      },
    } as unknown as RunManager,
    evalRunManager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => status,
    isKnownModel: async () => true,
    sampleSourceDir: opts.sampleSourceDir ?? path.join(FIXTURES_ROOT, "evals", "sample"),
  };
  const server: Server = createServer((req, res) => {
    handleEvalRoutes(req, res, deps).then(
      (handled) => {
        if (!handled) json(res, 404, { error: "Not found" });
      },
      () => json(res, 500, { error: "unhandled" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const call = async (method: string, urlPath: string, body?: unknown): Promise<Api> => {
    const res = await fetch(`${origin}${urlPath}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  return {
    root,
    store,
    manager: evalRunManager,
    runner,
    deletedRuns,
    call,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    setEngine: (patch) => Object.assign(status, patch),
    setEngineFactory: (f) => {
      engineFactory = f;
    },
  };
}

const q = (h: Harness, extra = ""): string => `project_root=${encodeURIComponent(h.root)}${extra}`;

async function startRun(h: Harness, id: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.post(`/api/evals/${id}/runs`, { project_root: h.root, ...body });
  expect(res.status).toBe(202);
  await h.manager.awaitFinished(res.body.eval_run_id, 15_000);
  return res.body.eval_run_id as string;
}

describe("eval routes: evals", () => {
  it("lists evals in three states with banner, trend, delta and footer", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "evals", "steady.eval.yaml"), evalYaml("steady", { type: "regression" }));
    await writeFile(path.join(h.root, "evals", "idle.eval.yaml"), evalYaml("idle"));
    await writeFile(path.join(h.root, "evals", "broken.eval.yaml"), "version: 1\nid: broken\n");

    await startRun(h, "review");
    h.runner.state.verdict = () => "bad";
    await startRun(h, "review");
    h.runner.state.verdict = () => "ok";
    await startRun(h, "steady");

    const res = await h.get(`/api/evals?${q(h)}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.items.map((i: any) => [i.id, i]));
    expect(byId.review.status).toBe("regressed");
    expect(byId.steady.status).toBe("passing");
    expect(byId.idle.status).toBe("never_run");
    expect(byId.broken.valid).toBe(false);
    expect(byId.review.valid).toBe(true);
    expect(byId.review.dataset_cases).toBe(6);
    expect(byId.review.grader_count).toBe(1);
    expect(byId.review.repeats).toBe(2);
    expect(byId.review.target).toMatchObject({ kind: "stage", stage_id: "review", pipeline_path: "pipelines/feature-ship.pipeline.yaml" });
    expect(byId.review.last_run_delta_pts).toBeCloseTo(-100, 5);
    expect(byId.review.trend.map((t: any) => t.run_number)).toEqual([1, 2]);
    expect(byId.review.trend.map((t: any) => t.passed)).toEqual([true, false]);
    expect(byId.review.last_run).toMatchObject({ run_number: 2, passed: false, eval_id: "review" });
    expect(byId.idle.last_run).toBeNull();
    expect(res.body.banner).toMatchObject({
      eval_id: "review",
      previous_pass_rate: 1,
      last_pass_rate: 0,
      criteria_dropped: 1,
      last_run_number: 2,
      previous_run_number: 1,
    });
    expect(res.body.footer.evals).toBe(4);
    expect(res.body.footer.datasets).toBe(1);
    expect(res.body.footer.cost_last_7_days).toBeGreaterThan(0);

    const byStage = await h.get(`/api/evals?${q(h, "&target_stage=review&target_pipeline=pipelines/feature-ship.pipeline.yaml")}`);
    expect(byStage.body.items.map((i: any) => i.id).sort()).toEqual(["idle", "review", "steady"]);
    const none = await h.get(`/api/evals?${q(h, "&target_stage=other")}`);
    expect(none.body.items).toEqual([]);
    const search = await h.get(`/api/evals?${q(h, "&q=STEADY")}`);
    expect(search.body.items.map((i: any) => i.id)).toEqual(["steady"]);
    const bySet = await h.get(`/api/evals?${q(h, "&q=review.dataset")}`);
    expect(bySet.body.items).toEqual([]);
    const byDataset = await h.get(`/api/evals?${q(h, "&q=review")}`);
    expect(byDataset.body.items.length).toBeGreaterThanOrEqual(3);
  });

  it("gets one eval with file hash, yaml, definition and 404 for a missing id", async () => {
    const h = await setup();
    await startRun(h, "review");
    const res = await h.get(`/api/evals/review?${q(h)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "review",
      path: "evals/review.eval.yaml",
      runs_count: 1,
      definition: { id: "review", type: "capability" },
    });
    expect(res.body.file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.yaml).toContain("id: review");
    expect(res.body.last_run.run_number).toBe(1);
    expect(typeof res.body.target_model).toBe("string");
    expect(res.body).toHaveProperty("judge_default");
    const missing = await h.get(`/api/evals/nope?${q(h)}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("EVAL_NOT_FOUND");
  });

  it("validates a definition and a yaml body without writing anything", async () => {
    const h = await setup();
    const before = await readdir(path.join(h.root, "evals"));
    const detail = await h.get(`/api/evals/review?${q(h)}`);
    const definition = { ...detail.body.definition, name: "Renamed" };

    const byDefinition = await h.post("/api/evals/validate", { project_root: h.root, definition, path: "evals/review.eval.yaml" });
    expect(byDefinition.status).toBe(200);
    expect(byDefinition.body.derived_yaml).toContain("name: Renamed");
    expect(byDefinition.body.definition).toMatchObject({ id: "review", name: "Renamed" });
    expect(byDefinition.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);

    const byYaml = await h.post("/api/evals/validate", { project_root: h.root, yaml: evalYaml("review").replace("repeats: 2", "repeats: 99"), path: "evals/review.eval.yaml" });
    expect(byYaml.status).toBe(200);
    expect(byYaml.body.derived_yaml).toContain("repeats: 99");
    expect(byYaml.body.findings.some((f: any) => f.severity === "error")).toBe(true);

    const fresh = await h.post("/api/evals/validate", { project_root: h.root, definition: { ...definition, id: "fresh", name: undefined } });
    expect(fresh.body.derived_yaml).toContain("id: fresh");

    const both = await h.post("/api/evals/validate", { project_root: h.root, definition, yaml: "x: 1" });
    expect(both.status).toBe(400);

    expect(await readdir(path.join(h.root, "evals"))).toEqual(before);
    expect(await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8")).toBe(evalYaml());
  });

  it("creates an eval, refuses duplicates, and rejects invalid definitions with findings", async () => {
    const h = await setup();
    const detail = await h.get(`/api/evals/review?${q(h)}`);
    const definition = { ...detail.body.definition, id: "second" };
    const created = await h.post("/api/evals", { project_root: h.root, definition });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "second", path: "evals/second.eval.yaml" });
    expect(await readFile(path.join(h.root, "evals", "second.eval.yaml"), "utf8")).toContain("id: second");

    const dup = await h.post("/api/evals", { project_root: h.root, definition });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("EVAL_EXISTS");

    const invalid = await h.post("/api/evals", {
      project_root: h.root,
      definition: { ...definition, id: "third", dataset: "../datasets/missing.dataset.jsonl" },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("EVAL_INVALID");
    expect(invalid.body.findings.some((f: any) => f.severity === "error")).toBe(true);
    expect((await readdir(path.join(h.root, "evals"))).includes("third.eval.yaml")).toBe(false);
  });

  it("updates an eval with base_hash and returns FILE_CHANGED with the current hash when stale", async () => {
    const h = await setup();
    const detail = await h.get(`/api/evals/review?${q(h)}`);
    const definition = { ...detail.body.definition, description: "Edited" };
    const ok = await call(h, "PUT", "/api/evals/review", { project_root: h.root, definition, base_hash: detail.body.file_hash });
    expect(ok.status).toBe(200);
    expect(ok.body.yaml).toContain("description: Edited");
    expect(ok.body.file_hash).not.toBe(detail.body.file_hash);

    const stale = await call(h, "PUT", "/api/evals/review", { project_root: h.root, definition, base_hash: detail.body.file_hash });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "FILE_CHANGED", current_hash: ok.body.file_hash });

    const bad = await call(h, "PUT", "/api/evals/review", {
      project_root: h.root,
      yaml: "version: 1\nid: review\n",
      base_hash: ok.body.file_hash,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("EVAL_INVALID");
    expect(bad.body.findings.length).toBeGreaterThan(0);
    expect(await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8")).toContain("description: Edited");

    const missing = await call(h, "PUT", "/api/evals/nope", { project_root: h.root, definition, base_hash: "x" });
    expect(missing.status).toBe(404);
  });

  it("installs the sample once and answers SAMPLE_EXISTS after", async () => {
    const h = await setup();
    const first = await h.post("/api/evals/sample", { project_root: h.root });
    expect(first.status).toBe(201);
    expect(first.body.eval_id).toBe("critique-sample");
    const again = await h.post("/api/evals/sample", { project_root: h.root });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SAMPLE_EXISTS");
  });

  describe("without project_root", () => {
    it("lists a sample installed to the workspace root", async () => {
      const h = await setup();
      const real = await realpath(h.root);
      const before = await h.get("/api/evals");
      expect(before.body.items.map((i: any) => i.id)).toEqual(["review"]);
      expect(before.body.items[0].project_root).toBe(real);
      const installed = await h.post("/api/evals/sample", {});
      expect(installed.status).toBe(201);
      const list = await h.get("/api/evals");
      expect(list.body.items.map((i: any) => i.id).sort()).toEqual(["critique-sample", "review"]);
      const sample = list.body.items.find((i: any) => i.id === "critique-sample");
      expect(sample.project_root).toBe("workspace");
      expect(list.body.footer.evals).toBe(2);
      const detail = await h.get("/api/evals/critique-sample");
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe("critique-sample");
      const datasets = await h.get("/api/datasets");
      expect(datasets.body.items.map((i: any) => `${i.project_root}:${i.id}`).sort()).toEqual([
        `workspace:critique-sample`,
        `${real}:review`,
      ].sort());
      const scoped = await h.get(`/api/evals?project_root=${encodeURIComponent(h.root)}`);
      expect(scoped.body.items.map((i: any) => i.id)).toEqual(["review"]);
      expect(scoped.body.footer.evals).toBe(1);
    });

    it("answers EVAL_AMBIGUOUS with project_roots and scopes with an explicit project_root", async () => {
      const h = await setup();
      const real = await realpath(h.root);
      await h.post("/api/evals/sample", {});
      const ws = (await h.get("/api/evals")).body.items.find((i: any) => i.id === "critique-sample");
      expect(ws.project_root).toBe("workspace");
      const dup = await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8");
      await writeFile(path.join(h.root, "evals", "critique-sample.eval.yaml"), dup.replace("id: review", "id: critique-sample"));

      const ambiguous = await h.get("/api/evals/critique-sample");
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body.code).toBe("EVAL_AMBIGUOUS");
      expect([...ambiguous.body.project_roots].sort()).toEqual(["workspace", real].sort());
      expect((await h.get("/api/evals/critique-sample/runs/estimate")).body.code).toBe("EVAL_AMBIGUOUS");

      const scoped = await h.get(`/api/evals/critique-sample?project_root=${encodeURIComponent("workspace")}`);
      expect(scoped.status).toBe(200);
      const other = await h.get(`/api/evals/critique-sample?project_root=${encodeURIComponent(h.root)}`);
      expect(other.status).toBe(200);
      expect(other.body.path).toBe("evals/critique-sample.eval.yaml");

      const missing = await h.get("/api/evals/nope");
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("EVAL_NOT_FOUND");
    });

    it("finds an eval in a registered root for id routes and flags ambiguous datasets", async () => {
      const h = await setup();
      const real = await realpath(h.root);
      const detail = await h.get("/api/evals/review");
      expect(detail.status).toBe(200);
      await h.post("/api/evals/sample", {});
      const wsPath = (await h.get("/api/evals")).body.items.find((i: any) => i.id === "critique-sample").path;
      expect(wsPath).toContain("critique-sample");
      const ds = await h.get("/api/datasets/review");
      expect(ds.status).toBe(200);
      const none = await h.get("/api/datasets/zzz");
      expect(none.status).toBe(404);
      expect(none.body.code).toBe("DATASET_NOT_FOUND");
    });
  });

  it("tries one case from an eval, an unsaved definition with an inline case, and refuses while a run is active", async () => {
    const h = await setup();
    const byId = await h.post("/api/evals/try", { project_root: h.root, eval_id: "review", case_id: "c1" });
    expect(byId.status).toBe(200);
    expect(byId.body.result).toMatchObject({ case_id: "c1", repeat_index: 0, status: "completed", passed: true, review: null });
    expect(byId.body.result.grades[0]).toMatchObject({ grader_id: "verdict-ok", passed: true });
    expect(typeof byId.body.stage_run_id).toBe("string");
    expect(byId.body.cost_usd).toBeCloseTo(0.01, 6);

    const detail = await h.get(`/api/evals/review?${q(h)}`);
    const draft = await h.post("/api/evals/try", {
      project_root: h.root,
      definition: { ...detail.body.definition, id: "draft" },
      case: { input: { diff: "inline" } },
    });
    expect(draft.status).toBe(200);
    expect(draft.body.result.passed).toBe(true);
    expect((await readdir(path.join(h.root, "evals"))).includes("draft.eval.yaml")).toBe(false);
    expect(await h.store.listEvalRuns({ limit: 10 })).toMatchObject({ items: [] });

    const both = await h.post("/api/evals/try", { project_root: h.root, eval_id: "review", definition: {}, case_id: "c1" });
    expect(both.status).toBe(400);
    const neither = await h.post("/api/evals/try", { project_root: h.root, eval_id: "review" });
    expect(neither.status).toBe(400);

    h.runner.state.delayMs = 300;
    const started = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(started.status).toBe(202);
    const blocked = await h.post("/api/evals/try", { project_root: h.root, eval_id: "review", case_id: "c1" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("EVAL_RUN_ACTIVE");
    await h.post(`/api/eval-runs/${started.body.eval_run_id}/cancel`);
  });

  describe("draft with inline dataset cases", () => {
    const inlineCases = [
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `d${n}`, input: { diff: `change ${n}` } })),
      { id: "bad", input: { other: 1 } },
    ];
    const draftDefinition = async (h: Harness) => {
      const detail = await h.get(`/api/evals/review?${q(h)}`);
      return { ...detail.body.definition, id: "draft", dataset: "../datasets/not-written-yet.dataset.jsonl" };
    };

    it("validates without reading the dataset file and reports skipped cases", async () => {
      const h = await setup();
      const definition = await draftDefinition(h);
      const missing = await h.post("/api/evals/validate", { project_root: h.root, definition });
      expect(missing.body.findings.map((f: any) => f.code)).toContain("eval.dataset_unresolved");

      const res = await h.post("/api/evals/validate", { project_root: h.root, definition, dataset_cases: inlineCases });
      expect(res.status).toBe(200);
      const codes = res.body.findings.map((f: any) => f.code);
      expect(codes).not.toContain("eval.dataset_unresolved");
      expect(codes).toContain("eval.cases_skipped");
      expect(res.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);

      const none = await h.post("/api/evals/validate", {
        project_root: h.root,
        definition,
        dataset_cases: [{ id: "bad", input: { other: 1 } }],
      });
      expect(none.body.findings.map((f: any) => f.code)).toContain("eval.no_valid_cases");

      const shape = await h.post("/api/evals/validate", {
        project_root: h.root,
        definition,
        dataset_cases: [{ id: "x" }],
      });
      expect(shape.body.findings.map((f: any) => f.code)).toContain("eval.dataset_invalid");

      const noIds = await h.post("/api/evals/validate", {
        project_root: h.root,
        definition,
        dataset_cases: [1, 2, 3, 4, 5].map((n) => ({ input: { diff: `change ${n}` } })),
      });
      expect(noIds.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);
      const tried = await h.post("/api/evals/try", {
        project_root: h.root,
        definition,
        dataset_cases: [{ input: { diff: "a" } }, { input: { diff: "b" } }],
        case_id: "c002",
      });
      expect(tried.status).toBe(200);
      expect(tried.body.result).toMatchObject({ case_id: "c002" });

      const notArray = await h.post("/api/evals/validate", { project_root: h.root, definition, dataset_cases: {} });
      expect(notArray.status).toBe(400);
    });

    it("tries a case by id from the inline cases", async () => {
      const h = await setup();
      const definition = await draftDefinition(h);
      const tried = await h.post("/api/evals/try", {
        project_root: h.root,
        definition,
        dataset_cases: inlineCases,
        case_id: "d2",
      });
      expect(tried.status).toBe(200);
      expect(tried.body.result).toMatchObject({ case_id: "d2", status: "completed", passed: true });
      expect(await readdir(path.join(h.root, "datasets"))).not.toContain("not-written-yet.dataset.jsonl");
    });

    it("estimates a draft from stage history without a previous run", async () => {
      const h = await setup();
      const definition = await draftDefinition(h);
      const res = await h.post("/api/evals/runs/estimate", {
        project_root: h.root,
        definition,
        dataset_cases: inlineCases,
        repeats: 3,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        results_total: 15,
        stage_calls: 15,
        judge_calls: 0,
        judge_included: true,
        based_on_run_number: null,
      });
      const defaultRepeats = await h.post("/api/evals/runs/estimate", {
        project_root: h.root,
        definition,
        dataset_cases: inlineCases,
      });
      expect(defaultRepeats.body.results_total).toBe(10);
      const missing = await h.post("/api/evals/runs/estimate", { project_root: h.root, definition });
      expect(missing.status).toBe(422);
      const noDefinition = await h.post("/api/evals/runs/estimate", { project_root: h.root });
      expect(noDefinition.status).toBe(400);
    });
  });

  it("exposes the directories a new eval and dataset would be written to", async () => {
    const h = await setup();
    const list = await h.get(`/api/evals?${q(h)}`);
    expect(list.body.write_roots).toMatchObject({ evals_dir: "evals", datasets_dir: "datasets" });
    expect(list.body.write_roots.project_root.endsWith(path.basename(h.root))).toBe(true);
    const bare = await h.get("/api/evals");
    expect(typeof bare.body.write_roots.project_root).toBe("string");
  });
});

async function call(h: Harness, method: string, urlPath: string, body?: unknown) {
  return h.call(method, urlPath, body);
}

describe("eval routes: eval runs", () => {
  it("starts a run, shows progress while running, stats when finished, and folds results per case", async () => {
    const h = await setup();
    h.runner.state.delayMs = 40;
    h.runner.state.verdict = (caseId, repeat) => (caseId === "c3" ? (repeat === 0 ? "ok" : "bad") : caseId === "c4" ? "bad" : "ok");
    const started = await h.post("/api/evals/review/runs", { project_root: h.root, label: "first" });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "queued", run_number: 1 });
    const id = started.body.eval_run_id as string;

    const mid = await h.get(`/api/eval-runs/${id}`);
    expect(mid.status).toBe(200);
    expect(["queued", "running"]).toContain(mid.body.status);
    expect(mid.body.progress).toMatchObject({ results_total: 10, cases_total: 5 });
    expect(mid.body.current).toMatchObject({ stage_version_hash: expect.any(String), dataset_hash: expect.any(String) });
    await h.manager.awaitFinished(id, 15_000);

    const done = await h.get(`/api/evals/review/runs/1?${q(h)}`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ eval_run_id: id, status: "completed", eval_id: "review", run_number: 1, label: "first", started_via: "console" });
    expect(done.body.live).toBeUndefined();
    expect(done.body.progress.results_done).toBe(10);
    expect(done.body.stats).toMatchObject({ results_executed: 10, results_passed: 7 });
    expect(done.body.stats.flaky_cases).toEqual(["c3"]);
    expect(done.body.current.grader_hashes["verdict-ok"]).toBe(done.body.config.graders[0].hash);
    expect(done.body.current.stage_version_hash).toBe(done.body.config.target.stage_version_hash);

    const all = await h.get(`/api/eval-runs/${id}/results`);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(5);
    expect(all.body.counts).toEqual({ all: 5, passed: 3, failed: 2, errored: 0, flaky: 1 });
    const c3 = all.body.items.find((r: any) => r.case_id === "c3");
    expect(c3).toMatchObject({ pass_fraction: 0.5, failed_graders: ["verdict-ok"] });
    expect(c3.repeats.map((r: any) => r.passed)).toEqual([true, false]);
    expect(all.body.items.find((r: any) => r.case_id === "c1")).toMatchObject({ title: "null deref", tags: ["smoke"], pass_fraction: 1 });
    expect(all.body.items[0].case_id).toBe("c1");

    const failed = await h.get(`/api/eval-runs/${id}/results?status=failed`);
    expect(failed.body.items.map((r: any) => r.case_id)).toEqual(["c3", "c4"]);
    const flaky = await h.get(`/api/eval-runs/${id}/results?status=flaky`);
    expect(flaky.body.items.map((r: any) => r.case_id)).toEqual(["c3"]);
    const byGrader = await h.get(`/api/eval-runs/${id}/results?grader=verdict-ok`);
    expect(byGrader.body.items).toHaveLength(2);
    const search = await h.get(`/api/eval-runs/${id}/results?q=null`);
    expect(search.body.items.map((r: any) => r.case_id)).toEqual(["c1"]);
    const byTag = await h.get(`/api/eval-runs/${id}/results?tag=smoke`);
    expect(byTag.body.items.map((r: any) => r.case_id)).toEqual(["c1"]);
    const paged = await h.get(`/api/eval-runs/${id}/results?limit=2`);
    expect(paged.body.items).toHaveLength(2);
    expect(typeof paged.body.next_cursor).toBe("string");
    const page2 = await h.get(`/api/eval-runs/${id}/results?limit=2&cursor=${paged.body.next_cursor}`);
    expect(page2.body.items.map((r: any) => r.case_id)).toEqual(["c3", "c4"]);
    const last = await h.get(`/api/eval-runs/${id}/results?limit=2&cursor=${page2.body.next_cursor}`);
    expect(last.body.items).toHaveLength(1);
    expect(last.body.next_cursor).toBeNull();
    expect((await h.get(`/api/eval-runs/${id}/results?status=weird`)).status).toBe(400);
    expect((await h.get(`/api/eval-runs/${id}/results?cursor=%25%25`)).status).toBe(400);

    expect((await h.get(`/api/evals/review/runs/9?${q(h)}`)).status).toBe(404);
    expect((await h.get(`/api/eval-runs/er_nope`)).body.code).toBe("EVAL_RUN_NOT_FOUND");
  });

  it("returns result detail, stores reviews, rejects tags on passed results, and lists failure types", async () => {
    const h = await setup();
    h.runner.state.verdict = (caseId) => (caseId === "c2" ? "bad" : "ok");
    const id = await startRun(h, "review");

    const detail = await h.get(`/api/eval-runs/${id}/results/c2`);
    expect(detail.status).toBe(200);
    expect(detail.body.case).toMatchObject({ id: "c2", input: { diff: "diff c2" } });
    expect(detail.body.repeats).toHaveLength(2);
    expect(detail.body.repeats[0]).toMatchObject({ repeat_index: 0, status: "completed", passed: false, review: null, tags: [] });
    expect(detail.body.repeats[0].output).toMatchObject({ payload: { verdict: "bad" } });
    expect(detail.body.repeats[0].grades[0]).toMatchObject({ grader_id: "verdict-ok", passed: false });
    expect((await h.get(`/api/eval-runs/${id}/results/nope`)).status).toBe(404);

    const tagged = await call(h, "PUT", `/api/eval-runs/${id}/results/c2/0/review`, {
      label: "fail",
      note: "wrong verdict",
      tags: ["Missed issue"],
    });
    expect(tagged.status).toBe(200);
    expect(tagged.body).toEqual({ label: "fail", note: "wrong verdict", tags: ["Missed issue"] });
    const reread = await h.get(`/api/eval-runs/${id}/results/c2`);
    expect(reread.body.repeats[0].review).toEqual({ label: "fail", note: "wrong verdict" });
    expect(reread.body.repeats[0].tags).toEqual(["Missed issue"]);
    const rows = await h.get(`/api/eval-runs/${id}/results?tag=Missed%20issue`);
    expect(rows.body.items.map((r: any) => r.case_id)).toEqual(["c2"]);
    expect(rows.body.items[0].failure_tags).toEqual(["Missed issue"]);

    const onPassed = await call(h, "PUT", `/api/eval-runs/${id}/results/c1/0/review`, { label: "pass", tags: ["x"] });
    expect(onPassed.status).toBe(400);
    expect(onPassed.body.code).toBe("EVAL_TAGS_ON_PASSED_RESULT");
    const okPassed = await call(h, "PUT", `/api/eval-runs/${id}/results/c1/0/review`, { label: "pass", note: null });
    expect(okPassed.status).toBe(200);

    expect((await call(h, "PUT", `/api/eval-runs/${id}/results/c1/0/review`, { label: "maybe" })).status).toBe(400);
    expect((await call(h, "PUT", `/api/eval-runs/${id}/results/c1/0/review`, { note: "x".repeat(501) })).status).toBe(400);
    expect((await call(h, "PUT", `/api/eval-runs/${id}/results/zz/0/review`, { label: "pass" })).status).toBe(404);

    const types = await h.get(`/api/evals/review/failure-types?${q(h)}`);
    expect(types.body.items).toEqual(["Missed issue"]);

    const withStats = await h.get(`/api/eval-runs/${id}`);
    expect(withStats.body.stats.failure_types.by_tag).toEqual({ "Missed issue": 1 });
  });

  it("selects failed cases with only_failed_from and answers EVAL_RUN_ACTIVE for a second start", async () => {
    const h = await setup();
    h.runner.state.verdict = (caseId) => (caseId === "c2" || caseId === "c5" ? "bad" : "ok");
    const first = await startRun(h, "review");
    const second = await startRun(h, "review", { only_failed_from: first });
    const run = await h.get(`/api/eval-runs/${second}`);
    expect(run.body.progress.cases_total).toBe(2);
    expect(run.body.config.overrides.only_failed_from).toBe(first);
    const cases = await h.get(`/api/eval-runs/${second}/results`);
    expect(cases.body.items.map((r: any) => r.case_id)).toEqual(["c2", "c5"]);

    const unknown = await h.post("/api/evals/review/runs", { project_root: h.root, only_failed_from: "er_missing" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe("EVAL_INVALID");

    const mixed = await h.post("/api/evals/review/runs", { project_root: h.root, case_ids: ["c1"], tags: ["smoke"] });
    expect(mixed.status).toBe(422);

    h.runner.state.delayMs = 200;
    const running = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(running.status).toBe(202);
    const clash = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("EVAL_RUN_ACTIVE");
    await h.post(`/api/eval-runs/${running.body.eval_run_id}/cancel`);
  });

  it("validates start bodies and answers 503 when the engine is missing or Node is too old", async () => {
    const h = await setup();
    expect((await h.post("/api/evals/review/runs", { project_root: h.root, repeats: "3" })).status).toBe(400);
    expect((await h.post("/api/evals/review/runs", { project_root: h.root, started_via: "web" })).status).toBe(400);
    expect((await h.post("/api/evals/review/runs", { project_root: h.root, label: "x".repeat(81) })).status).toBe(400);
    expect((await h.post("/api/evals/review/runs", { project_root: h.root, repeats: 50 })).status).toBe(422);
    expect((await h.post("/api/evals/ghost/runs", { project_root: h.root })).status).toBe(404);

    h.setEngine({ installed: false });
    const missing = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe("EVAL_ENGINE_UNAVAILABLE");
    expect(missing.body.error).toContain("sf eval engine install");
    h.setEngine({ installed: true, nodeOk: false, node: "20.0.0" });
    const old = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(old.status).toBe(503);
    expect(old.body.code).toBe("EVAL_NODE_TOO_OLD");
    h.setEngine({ nodeOk: true });
  });

  it("never leaks secrets, urls or stack traces from a forced engine failure", async () => {
    const h = await setup();
    h.setEngineFactory(() => {
      throw new Error("boom https://api.example.com/v1?key=sk-secret-123\n    at secretFn (/srv/app.js:1:1)");
    });
    const res = await h.post("/api/evals/review/runs", { project_root: h.root });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain("sk-secret");
    expect(res.text).not.toContain("example.com");
    expect(res.text).not.toContain("secretFn");
    expect(res.body.code).toBe("internal_error");

    const tried = await h.post("/api/evals/try", { project_root: h.root, eval_id: "review", case_id: "c1" });
    expect(tried.status).toBe(500);
    expect(tried.text).not.toContain("sk-secret");
  });

  it("estimates a run from the previous run and from stage history", async () => {
    const h = await setup();
    const none = await h.get(`/api/evals/review/runs/estimate?${q(h)}`);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      results_total: 10,
      stage_calls: 10,
      judge_calls: 0,
      estimate_usd: null,
      estimate_seconds: null,
      judge_included: true,
      based_on_run_number: null,
    });
    await startRun(h, "review");
    const est = await h.get(`/api/evals/review/runs/estimate?${q(h, "&repeats=4&case_ids=c1,c2")}`);
    expect(est.status).toBe(200);
    expect(est.body.results_total).toBe(8);
    expect(est.body.based_on_run_number).toBe(1);
    expect(est.body.estimate_usd).toBeCloseTo(0.08, 6);
    const bad = await h.get(`/api/evals/review/runs/estimate?${q(h, "&repeats=99")}`);
    expect(bad.status).toBe(422);
    const rubric = await h.get(`/api/evals/review/runs/estimate?${q(h, "&tags=smoke")}`);
    expect(rubric.body.results_total).toBe(2);
  });

  it("reports the active run on the list and detail reads while a run is queued or running", async () => {
    const h = await setup();
    h.runner.state.delayMs = 300;
    const idle = await h.get(`/api/evals/review?${q(h)}`);
    expect(idle.body.active_run).toBeNull();

    const started = await h.post("/api/evals/review/runs", { project_root: h.root });
    const id = started.body.eval_run_id as string;

    const detail = await h.get(`/api/evals/review?${q(h)}`);
    expect(detail.body.runs_count).toBe(1);
    expect(detail.body.last_run).toBeNull();
    expect(detail.body.active_run).toMatchObject({ run_number: 1, eval_run_id: id, results_total: 10 });
    expect(["queued", "running"]).toContain(detail.body.active_run.status);

    const list = await h.get(`/api/evals?${q(h)}`);
    const item = list.body.items.find((i: any) => i.id === "review");
    expect(item.status).toBe("running");
    expect(item.active_run).toMatchObject({ run_number: 1, eval_run_id: id });

    const runs = await h.get(`/api/eval-runs?eval_id=review&${q(h)}`);
    expect(runs.body.items[0]).toMatchObject({ run_number: 1, results_total: 10 });

    await h.manager.awaitFinished(id, 15_000);
    const after = await h.get(`/api/evals/review?${q(h)}`);
    expect(after.body.active_run).toBeNull();
    const listAfter = await h.get(`/api/evals?${q(h)}`);
    const itemAfter = listAfter.body.items.find((i: any) => i.id === "review");
    expect(itemAfter.status).not.toBe("running");
    expect(itemAfter.active_run).toBeNull();
  });

  it("lists eval runs with filters, pagination and the stage_run_id filter", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "evals", "other.eval.yaml"), evalYaml("other"));
    const a = await startRun(h, "review");
    const b = await startRun(h, "review");
    const c = await startRun(h, "other");

    const all = await h.get("/api/eval-runs");
    expect(all.body.items.map((i: any) => i.eval_run_id)).toEqual([c, b, a]);
    const scoped = await h.get(`/api/eval-runs?eval_id=review&${q(h)}`);
    expect(scoped.body.items.map((i: any) => i.run_number)).toEqual([2, 1]);
    const paged = await h.get("/api/eval-runs?limit=2");
    expect(paged.body.items).toHaveLength(2);
    const next = await h.get(`/api/eval-runs?limit=2&cursor=${paged.body.next_cursor}`);
    expect(next.body.items.map((i: any) => i.eval_run_id)).toEqual([a]);
    expect((await h.get("/api/eval-runs?status=bogus")).status).toBe(400);
    expect((await h.get("/api/eval-runs?status=completed")).body.items).toHaveLength(3);
    expect((await h.get("/api/eval-runs?status=running")).body.items).toEqual([]);

    const results = await h.store.listEvalResults(b);
    const stageRunId = results[0]!.stageRunId as string;
    const byStage = await h.get(`/api/eval-runs?stage_run_id=${stageRunId}`);
    expect(byStage.body.items).toHaveLength(1);
    expect(byStage.body.items[0]).toMatchObject({ eval_run_id: b, result: { case_id: results[0]!.caseId } });
    expect((await h.get("/api/eval-runs?stage_run_id=sr_none")).body.items).toEqual([]);
  });

  it("cancels a running run, is idempotent when finished, and refuses to delete a running run", async () => {
    const h = await setup();
    h.runner.state.delayMs = 300;
    const started = await h.post("/api/evals/review/runs", { project_root: h.root });
    const id = started.body.eval_run_id as string;
    const running = await h.get(`/api/eval-runs/${id}`);
    expect(["queued", "running"]).toContain(running.body.status);
    const refused = await call(h, "DELETE", `/api/eval-runs/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EVAL_RUN_ACTIVE");

    const cancelled = await h.post(`/api/eval-runs/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const again = await h.post(`/api/eval-runs/${id}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("cancelled");
    expect((await h.post("/api/eval-runs/er_ghost/cancel")).status).toBe(404);
  });

  it("deletes a finished run with its eval stage runs", async () => {
    const h = await setup();
    const id = await startRun(h, "review");
    const stageRuns = [...new Set((await h.store.listEvalResults(id)).map((r) => r.stageRunId))];
    const del = await call(h, "DELETE", `/api/eval-runs/${id}`);
    expect(del.status).toBe(204);
    expect((await h.get(`/api/eval-runs/${id}`)).status).toBe(404);
    expect([...h.deletedRuns].sort()).toEqual([...stageRuns].sort());
    expect((await call(h, "DELETE", `/api/eval-runs/${id}`)).status).toBe(404);
  });

  it("compares two runs, rejects different evals, and exports results and config", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "evals", "other.eval.yaml"), evalYaml("other"));
    const a = await startRun(h, "review");
    h.runner.state.verdict = (caseId) => (caseId === "c1" ? "bad" : "ok");
    const b = await startRun(h, "review");
    const other = await startRun(h, "other");

    const cmp = await h.get(`/api/eval-compare?a=${a}&b=${b}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.shared_cases).toBe(5);
    expect(cmp.body.cases[0]).toMatchObject({ case_id: "c1", change: "regressed" });
    expect(cmp.body.verdict).toBeDefined();

    const mismatch = await h.get(`/api/eval-compare?a=${a}&b=${other}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("EVAL_COMPARE_MISMATCH");
    expect((await h.get(`/api/eval-compare?a=${a}`)).status).toBe(400);
    expect((await h.get(`/api/eval-compare?a=${a}&b=er_ghost`)).status).toBe(404);

    const results = await h.get(`/api/eval-runs/${b}/export`);
    expect(results.status).toBe(200);
    expect(results.headers.get("content-type")).toContain("application/json");
    expect(results.headers.get("content-disposition")).toBe("attachment; filename=review-run-2-results.json");
    expect(results.body.eval_run_id).toBe(b);
    expect(results.body.results).toHaveLength(10);
    expect(results.body.results[0].grades).toBeDefined();
    const config = await h.get(`/api/eval-runs/${b}/export?what=config`);
    expect(config.headers.get("content-disposition")).toBe("attachment; filename=review-run-2-config.json");
    expect(config.body.snapshot_version).toBe(1);
    expect(config.body.eval.id).toBe("review");
    expect((await h.get(`/api/eval-runs/${b}/export?what=other`)).status).toBe(400);
  });

  it("reports engine status", async () => {
    const h = await setup();
    const res = await h.get("/api/eval-engine");
    expect(res.body).toEqual({
      installed: true,
      version: "0.124.0",
      pinned: "0.124.0",
      node: "22.22.0",
      node_ok: true,
      install_command: "sf eval engine install",
    });
  });
});

describe("eval routes: datasets", () => {
  it("lists datasets and shows detail with input_check, fields, filters and paging", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "datasets", "extra.dataset.json"), JSON.stringify([{ id: "x1", input: { diff: "d" } }]));
    const list = await h.get(`/api/datasets?${q(h)}`);
    expect(list.status).toBe(200);
    const review = list.body.items.find((d: any) => d.id === "review");
    expect(review).toMatchObject({ path: "datasets/review.dataset.jsonl", format: "jsonl", cases: 6, editable: true, used_by: ["review"] });
    expect(review.hash).toMatch(/^[0-9a-f]{64}$/);
    const extra = list.body.items.find((d: any) => d.id === "extra");
    expect(extra).toMatchObject({ editable: false, used_by: [] });

    const detail = await h.get(`/api/datasets/review?${q(h)}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: "review",
      cases_total: 6,
      invalid_total: 1,
      tagged_total: 1,
      tags: { smoke: 1 },
      input_fields: [{ name: "diff", required: true, type: "string" }],
      used_by: ["review"],
    });
    const bad = detail.body.cases.find((c: any) => c.id === "bad");
    expect(bad.input_check.valid).toBe(false);
    expect(typeof bad.input_check.message).toBe("string");
    expect(detail.body.cases.find((c: any) => c.id === "c1").input_check).toEqual({ valid: true });

    expect((await h.get(`/api/datasets/review?${q(h, "&filter=invalid")}`)).body.cases.map((c: any) => c.id)).toEqual(["bad"]);
    expect((await h.get(`/api/datasets/review?${q(h, "&filter=tagged")}`)).body.cases.map((c: any) => c.id)).toEqual(["c1"]);
    expect((await h.get(`/api/datasets/review?${q(h, "&q=null%20deref")}`)).body.cases.map((c: any) => c.id)).toEqual(["c1"]);
    expect((await h.get(`/api/datasets/review?${q(h, "&q=diff%20c3")}`)).body.cases.map((c: any) => c.id)).toEqual(["c3"]);
    expect((await h.get(`/api/datasets/review?${q(h, "&tag=smoke")}`)).body.cases.map((c: any) => c.id)).toEqual(["c1"]);
    const paged = await h.get(`/api/datasets/review?${q(h, "&offset=2&limit=2")}`);
    expect(paged.body.cases.map((c: any) => c.id)).toEqual(["c3", "c4"]);
    expect(paged.body.matched_total).toBe(6);
    expect((await h.get(`/api/datasets/review?${q(h, "&filter=odd")}`)).status).toBe(400);

    const orphan = await h.get(`/api/datasets/extra?${q(h)}`);
    expect(orphan.body.cases[0].input_check).toBeNull();
    const withEval = await h.get(`/api/datasets/extra?${q(h, "&eval_id=review")}`);
    expect(withEval.body.cases[0].input_check).toEqual({ valid: true });
    expect(withEval.body.input_fields).toEqual([{ name: "diff", required: true, type: "string" }]);
    expect((await h.get(`/api/datasets/nope?${q(h)}`)).body.code).toBe("DATASET_NOT_FOUND");
  });

  it("previews a CSV with a mapping into ready and skipped rows", async () => {
    const h = await setup();
    const csv = "patch,note,extra\nfirst diff,a,1\n,b,2\nthird diff,c,3\n";
    const res = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "csv",
      content: csv,
      mapping: { "input.diff": { column: "patch" }, "expected.notes": { column: "note", split: ";" } },
      target: { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" },
    });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(["patch", "note", "extra"]);
    expect(res.body.counts).toEqual({ ready: 2, skipped: 1 });
    expect(res.body.rows.map((r: any) => r.status)).toEqual(["ready", "skipped", "ready"]);
    expect(res.body.rows[0].case).toMatchObject({ id: "c001", input: { diff: "first diff" }, expected: { notes: ["a"] } });
    expect(res.body.rows[1].reason).toEqual(expect.any(String));
    expect(res.body.rows[2].case.id).toBe("c002");

    const auto = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "csv",
      content: "diff\none\ntwo\n",
      target: { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" },
    });
    expect(auto.body.counts).toEqual({ ready: 2, skipped: 0 });

    const jsonl = await h.post("/api/datasets/preview", {
      project_root: h.root,
      format: "jsonl",
      content: '{"input":{"diff":"a"}}\n{"nope":1}\nnot json\n',
      target: { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" },
    });
    expect(jsonl.body.counts).toEqual({ ready: 1, skipped: 1 });
    expect(jsonl.body.findings).toHaveLength(1);

    const free = await h.post("/api/datasets/preview", { project_root: h.root, format: "csv", content: "a,b\n1,2\n" });
    expect(free.body.rows[0]).toMatchObject({ status: "ready", case: { input: { a: "1", b: "2" } } });
    expect((await h.post("/api/datasets/preview", { project_root: h.root, format: "xml", content: "" })).status).toBe(400);
    expect((await h.post("/api/datasets/preview", { project_root: h.root, format: "csv", content: "a\n1\n", target: { file: "../x.yaml" } })).status).toBe(422);
  });

  it("creates datasets from cases, the sample and past runs, and appends or replaces", async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), "sf-eval-sample-"));
    cleanups.push(() => rm(sampleDir, { recursive: true, force: true }));
    for (const file of ["critique-sample.eval.yaml", "eval-sample.pipeline.yaml"]) {
      await cp(path.join(FIXTURES_ROOT, "evals", "sample", file), path.join(sampleDir, file));
    }
    await writeFile(
      path.join(sampleDir, "critique-sample.dataset.jsonl"),
      ["a", "b"].map((id) => JSON.stringify({ id, input: { diff: `sample ${id}` } })).join("\n") + "\n",
    );
    const h = await setup({ sampleSourceDir: sampleDir });
    const target = { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" };
    const created = await h.post("/api/datasets", {
      project_root: h.root,
      name: "mine",
      cases: [{ input: { diff: "a" } }, { input: { diff: "b" }, tags: ["t"] }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "mine", path: "datasets/mine.dataset.jsonl", cases_total: 2, editable: true });
    expect(created.body.cases.map((c: any) => c.id)).toEqual(["c001", "c002"]);

    const dup = await h.post("/api/datasets", { project_root: h.root, name: "mine", cases: [{ input: { diff: "a" } }] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DATASET_EXISTS");
    const badName = await h.post("/api/datasets", { project_root: h.root, name: "Bad Name", cases: [{ input: { diff: "a" } }] });
    expect(badName.status).toBe(400);

    const appended = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "append",
      base_hash: created.body.hash,
      cases: [{ input: { diff: "c" } }],
    });
    expect(appended.status).toBe(201);
    expect(appended.body.cases.map((c: any) => c.id)).toEqual(["c001", "c002", "c003"]);
    const stale = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "replace",
      base_hash: created.body.hash,
      cases: [{ input: { diff: "z" } }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("FILE_CHANGED");
    const replaced = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "replace",
      base_hash: appended.body.hash,
      cases: [{ input: { diff: "z" } }],
    });
    expect(replaced.body.cases_total).toBe(1);

    const fromSample = await h.post("/api/datasets", { project_root: h.root, name: "sample-copy", source: "sample", target });
    expect(fromSample.status, fromSample.text).toBe(201);
    expect(fromSample.body).toMatchObject({ id: "sample-copy", path: "datasets/sample-copy.dataset.jsonl", cases_total: 2 });

    const noRuns = await h.post("/api/datasets", { project_root: h.root, name: "from-runs", source: "runs", target, run_ids: ["missing-run"] });
    expect(noRuns.status).toBe(422);
    expect(noRuns.body.code).toBe("DATASET_CASE_OP_INVALID");

    const appendNoRuns = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "append",
      source: "runs",
      target,
      run_ids: ["missing-run"],
      base_hash: replaced.body.hash,
    });
    expect(appendNoRuns.status).toBe(422);
    expect(appendNoRuns.body.code).toBe("DATASET_CASE_OP_INVALID");
    const appendBadMode = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "replace",
      source: "runs",
      target,
      run_ids: ["x"],
      base_hash: replaced.body.hash,
    });
    expect(appendBadMode.status).toBe(400);
    const appendNoIds = await h.post("/api/datasets", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "append",
      source: "runs",
      target,
      base_hash: replaced.body.hash,
    });
    expect(appendNoIds.status).toBe(400);
  });

  it("gives the jsonl file the bare id and other files with the same stem <stem>.<ext>", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "datasets", "legacy.dataset.csv"), "id,input.diff:json\nc001,1\n");
    await writeFile(path.join(h.root, "datasets", "legacy.dataset.jsonl"), JSON.stringify({ id: "a", input: { diff: "1" } }) + "\n");
    const list = await h.get(`/api/datasets?${q(h)}`);
    const byPath = Object.fromEntries(list.body.items.map((d: any) => [d.path, d.id]));
    expect(byPath["datasets/legacy.dataset.jsonl"]).toBe("legacy");
    expect(byPath["datasets/legacy.dataset.csv"]).toBe("legacy.csv");
    expect((await h.get(`/api/datasets/legacy?${q(h)}`)).body.format).toBe("jsonl");
    const csv = await h.get(`/api/datasets/legacy.csv?${q(h)}`);
    expect(csv.body).toMatchObject({ id: "legacy.csv", format: "csv", editable: false });
  });

  it("converts a lone csv to jsonl and returns the jsonl detail under the bare id", async () => {
    const h = await setup();
    await writeFile(path.join(h.root, "datasets", "solo.dataset.csv"), "id,input.diff:json\nc001,1\n");
    const before = await h.get(`/api/datasets/solo?${q(h)}`);
    expect(before.body.format).toBe("csv");
    const converted = await h.post("/api/datasets/solo/convert", { project_root: h.root, base_hash: before.body.hash });
    expect(converted.status, converted.text).toBe(201);
    expect(converted.body).toMatchObject({ id: "solo", format: "jsonl", editable: true });
    expect((await h.get(`/api/datasets/solo.csv?${q(h)}`)).body.format).toBe("csv");
  });

  it("refuses the sample dataset when its cases do not match the stage input", async () => {
    const sampleDir = await mkdtemp(path.join(tmpdir(), "sf-eval-sample-"));
    cleanups.push(() => rm(sampleDir, { recursive: true, force: true }));
    await writeFile(path.join(sampleDir, "critique-sample.dataset.jsonl"), JSON.stringify({ id: "a", input: { other: 1 } }) + "\n");
    const h = await setup({ sampleSourceDir: sampleDir });
    const res = await h.post("/api/datasets", {
      project_root: h.root,
      name: "sample-copy",
      source: "sample",
      target: { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DATASET_INVALID");
    expect((await readdir(path.join(h.root, "datasets"))).includes("sample-copy.dataset.jsonl")).toBe(false);
  });

  it("applies case ops atomically, is read-only for non-jsonl, converts to jsonl, and lists candidates", async () => {
    const h = await setup();
    await writeFile(
      path.join(h.root, "datasets", "csvset.dataset.json"),
      JSON.stringify([{ id: "a", input: { diff: "1" } }, { id: "b", input: { diff: "2" } }]),
    );
    const detail = await h.get(`/api/datasets/review?${q(h)}`);
    const hash = detail.body.hash as string;
    const patched = await call(h, "PATCH", "/api/datasets/review/cases", {
      project_root: h.root,
      base_hash: hash,
      ops: [
        { op: "add", case: { input: { diff: "new" }, title: "added" } },
        { op: "update", id: "c2", case: { input: { diff: "edited" } } },
        { op: "set_tags", id: "c3", tags: ["wip"] },
        { op: "delete", id: "c4" },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.cases_total).toBe(6);
    expect(patched.body.cases.find((c: any) => c.id === "c3").tags).toEqual(["wip"]);
    expect(patched.body.cases.some((c: any) => c.id === "c4")).toBe(false);
    expect(patched.body.hash).not.toBe(hash);

    const stale = await call(h, "PATCH", "/api/datasets/review/cases", {
      project_root: h.root,
      base_hash: hash,
      ops: [{ op: "delete", id: "c1" }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "FILE_CHANGED", current_hash: patched.body.hash });

    const atomic = await call(h, "PATCH", "/api/datasets/review/cases", {
      project_root: h.root,
      base_hash: patched.body.hash,
      ops: [{ op: "delete", id: "c1" }, { op: "delete", id: "ghost" }],
    });
    expect(atomic.status).toBe(422);
    expect(atomic.body.code).toBe("DATASET_CASE_OP_INVALID");
    expect((await h.get(`/api/datasets/review?${q(h)}`)).body.cases_total).toBe(6);
    expect((await call(h, "PATCH", "/api/datasets/review/cases", { project_root: h.root, base_hash: "x", ops: "no" })).status).toBe(400);

    const json = await h.get(`/api/datasets/csvset?${q(h)}`);
    expect(json.body.editable).toBe(false);
    const readOnly = await call(h, "PATCH", "/api/datasets/csvset/cases", {
      project_root: h.root,
      base_hash: json.body.hash,
      ops: [{ op: "delete", id: "a" }],
    });
    expect(readOnly.status).toBe(409);
    expect(readOnly.body.code).toBe("DATASET_READ_ONLY");
    const converted = await h.post("/api/datasets/csvset/convert", { project_root: h.root, base_hash: json.body.hash });
    expect(converted.status).toBe(201);
    expect(converted.body).toMatchObject({ path: "datasets/csvset.dataset.jsonl", format: "jsonl", editable: true });
    expect(converted.body.hash).toBe(json.body.hash);
    const again = await h.post("/api/datasets/csvset/convert", { project_root: h.root, base_hash: json.body.hash });
    expect(again.status).toBe(422);
    const existing = await h.post("/api/datasets/csvset.json/convert", { project_root: h.root, base_hash: json.body.hash });
    expect(existing.status).toBe(409);
    expect(existing.body.code).toBe("DATASET_EXISTS");

    const cands = await h.get(`/api/datasets/candidates?${q(h, "&pipeline_path=pipelines/feature-ship.pipeline.yaml&stage_id=review")}`);
    expect(cands.status).toBe(200);
    expect(cands.body.items).toEqual([]);
    expect((await h.get(`/api/datasets/candidates?${q(h)}`)).status).toBe(422);
  });
});

describe("eval routes: route table", () => {
  it("answers every documented route (no route is a bare 404)", async () => {
    const h = await setup();
    const id = await startRun(h, "review");
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/api/evals?${q(h)}`],
      ["GET", `/api/evals/review?${q(h)}`],
      ["POST", "/api/evals/validate", { project_root: h.root, yaml: evalYaml() }],
      ["POST", "/api/evals", { project_root: h.root, definition: {} }],
      ["PUT", "/api/evals/review", { project_root: h.root, yaml: "x: 1", base_hash: "nope" }],
      ["POST", "/api/evals/sample", { project_root: h.root }],
      ["POST", "/api/evals/try", { project_root: h.root, eval_id: "review", case_id: "c1" }],
      ["GET", `/api/datasets?${q(h)}`],
      ["GET", `/api/datasets/review?${q(h)}`],
      ["POST", "/api/datasets/preview", { project_root: h.root, format: "jsonl", content: "" }],
      ["POST", "/api/datasets", { project_root: h.root, name: "tbl", cases: [{ input: { diff: "a" } }] }],
      ["PATCH", "/api/datasets/review/cases", { project_root: h.root, base_hash: "x", ops: [] }],
      ["POST", "/api/datasets/review/convert", { project_root: h.root, base_hash: "x" }],
      ["GET", `/api/datasets/candidates?${q(h, "&stage_id=review&pipeline_path=pipelines/feature-ship.pipeline.yaml")}`],
      ["POST", "/api/evals/review/runs", { project_root: h.root, repeats: "x" }],
      ["GET", `/api/evals/review/runs/estimate?${q(h)}`],
      ["GET", `/api/evals/review/runs/1?${q(h)}`],
      ["GET", "/api/eval-runs"],
      ["GET", `/api/eval-runs/${id}`],
      ["GET", `/api/eval-runs/${id}/results`],
      ["GET", `/api/eval-runs/${id}/results/c1`],
      ["PUT", `/api/eval-runs/${id}/results/c1/0/review`, { label: "pass" }],
      ["GET", `/api/evals/review/failure-types?${q(h)}`],
      ["POST", `/api/eval-runs/${id}/cancel`],
      ["GET", `/api/eval-compare?a=${id}&b=${id}`],
      ["GET", `/api/eval-runs/${id}/export`],
      ["GET", "/api/eval-engine"],
      ["DELETE", `/api/eval-runs/${id}`],
    ];
    for (const [method, urlPath, body] of routes) {
      const res = await h.call(method, urlPath, body);
      const bareNotFound = res.status === 404 && res.body.code === undefined;
      expect(bareNotFound, `${method} ${urlPath} -> ${res.status} ${res.text}`).toBe(false);
      expect(res.status, `${method} ${urlPath}`).toBeLessThan(500);
    }
    expect((await h.get("/api/evals/internal/run-case")).status).toBe(404);
  });
});

describe("eval routes: registered on the Host", () => {
  it("serves the eval routes from the operator route surface", async () => {
    const h = await setup();
    const service = await startTestService(h.store, scriptedFakeAgent([]), h.root);
    cleanups.push(() => service.stop());
    const list = await fetch(`${service.baseUrl}/api/evals?${q(h)}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(["review"]);
    const engine = await fetch(`${service.baseUrl}/api/eval-engine`);
    expect(engine.status).toBe(200);
    expect(Object.keys((await engine.json()) as object).sort()).toEqual(
      ["install_command", "installed", "node", "node_ok", "pinned", "version"],
    );
    expect((await fetch(`${service.baseUrl}/api/datasets?${q(h)}`)).status).toBe(200);
    expect((await fetch(`${service.baseUrl}/api/eval-runs`)).status).toBe(200);
  });
});
