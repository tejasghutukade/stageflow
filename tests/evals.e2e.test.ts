import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalCommand } from "../src/cli/evalCommand.js";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { alreadyUp } from "./helpers/testInProcessService.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

type Api = { status: number; body: any };
type Script = (caseId: string, repeat: number) => "pass" | "bad_verdict" | "false_alarm" | "stage_failure";

const EXPECTED_ISSUES: Record<string, string[]> = {
  c001: ["expir"],
  c002: ["paginat"],
  c003: [],
  c004: ["backoff", "limit"],
  c005: ["measur"],
  c006: ["size", "format"],
  c007: ["conflict"],
  c008: [],
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function scriptedRunner(state: { script: Script }): StageCaseRunner {
  return {
    async runCase(_plan: EvalPlan, req): Promise<RunCaseResult> {
      const outcome = state.script(req.caseId, req.repeatIndex);
      const stageRunId = `sr_${req.evalRunId}_${req.caseId}_${req.repeatIndex}`;
      if (outcome === "stage_failure") {
        return { ok: false, code: "EVAL_STAGE_FAILED", message: "stage failed", stageRunId, latencyMs: 10, costUsd: 0.01 };
      }
      const found = EXPECTED_ISSUES[req.caseId] ?? [];
      const issues = (outcome === "false_alarm" ? ["invented"] : found).map((text) => ({ severity: "high", text: `Problem: ${text}` }));
      return {
        ok: true,
        stageRunId,
        output: {
          kind: "envelope",
          status: "success",
          summary: "done",
          payload: {
            verdict: outcome === "bad_verdict" ? "bogus" : issues.length > 0 ? "needs_work" : "ok",
            issues,
          },
          artifacts: [],
        },
        latencyMs: 10,
        costUsd: 0.01,
        tokensIn: 5,
        tokensOut: 2,
      };
    },
    async cancelAll() {},
    spend: () => 0,
    addSpend() {},
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-eval-e2e-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-eval-e2e-home-"));
  bindStageflowHomeForTests(home);
  for (const dir of ["pipelines", "evals", "datasets"]) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\nmodel: anthropic/claude-sonnet-4-5\ncatalog:\n  pipelines:\n    - pipelines\n  evals:\n    - evals\n  datasets:\n    - datasets\n  tasks: []\n",
  );
  const store: RunStore = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  const state: { script: Script } = { script: () => "pass" };
  const manager = new EvalRunManager({
    store,
    stageRunner: scriptedRunner(state),
    engines: () => new FakeEngine(),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
  });
  const deletedRuns: string[] = [];
  const deps: EvalRoutesDeps = {
    cwd: root,
    store,
    manager: {
      deleteRun: async (runId: string) => {
        deletedRuns.push(runId);
        return { ok: true, runId };
      },
    } as unknown as RunManager,
    evalRunManager: manager,
    json,
    readJsonBody: readBody,
    auditLog: { info: () => undefined } as unknown as EvalRoutesDeps["auditLog"],
    engineStatus: () => ({
      installed: true,
      version: "0.124.0",
      pinned: "0.124.0",
      node: "22.22.0",
      nodeOk: true,
      path: "/engine",
      installCommand: "sf eval engine install",
    }),
    isKnownModel: async () => true,
    sampleSourceDir: path.resolve(FIXTURES_ROOT, "..", "..", "examples", "evals"),
  };
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/projects") {
      readBody(req).then((body) => json(res, 200, { project_root: body.project_root }));
      return;
    }
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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  return { root, origin, state, manager, store, deletedRuns, call };
}

type World = Awaited<ReturnType<typeof setup>>;

async function installSample(w: World): Promise<void> {
  const installed = await w.call("POST", "/api/evals/sample", { project_root: w.root });
  expect(installed.status).toBe(201);
  expect(installed.body.eval_id).toBe("critique-sample");
}

const RUN_ONE: Script = (caseId, repeat) =>
  caseId === "c004" ? "stage_failure" : caseId === "c002" && repeat === 1 ? "bad_verdict" : caseId === "c003" && repeat === 0 ? "false_alarm" : "pass";

async function startAndWait(w: World, body: Record<string, unknown> = {}): Promise<string> {
  const res = await w.call("POST", "/api/evals/critique-sample/runs", { project_root: w.root, ...body });
  expect(res.status).toBe(202);
  await w.manager.awaitFinished(res.body.eval_run_id, 20_000);
  return res.body.eval_run_id as string;
}

describe("evals end to end (in-process Host, fake engine, scripted stage runner)", () => {
  it("installs the sample, runs, compares after a prompt edit, reviews, edits the eval and deletes a run", async () => {
    const w = await setup();
    await installSample(w);

    const validated = await w.call("POST", "/api/evals/validate", {
      project_root: w.root,
      path: "evals/critique-sample.eval.yaml",
      yaml: await readFile(path.join(w.root, "evals", "critique-sample.eval.yaml"), "utf8"),
    });
    expect(validated.status).toBe(200);
    expect(validated.body.findings.filter((f: any) => f.severity === "error")).toEqual([]);

    const list = await w.call("GET", `/api/evals?project_root=${encodeURIComponent(w.root)}`);
    const row = list.body.items.find((i: any) => i.id === "critique-sample");
    expect(row).toMatchObject({ valid: true, dataset_cases: 8, grader_count: 4, repeats: 2, status: "never_run" });

    // Run 1: 8 cases x 2 repeats = 16 results. c002 repeat 1 has a bad verdict, c003 repeat 0 raises a false alarm
    // (both flaky), c004 fails in the stage twice; the other 12 results pass. 12 / 16 = 0.75, below the 0.8 threshold.
    w.state.script = RUN_ONE;
    const first = await startAndWait(w, { label: "baseline" });
    const run1 = (await w.call("GET", `/api/eval-runs/${first}`)).body;
    expect(run1).toMatchObject({ status: "completed", run_number: 1, label: "baseline", passed: false });
    expect(run1.stats).toMatchObject({
      cases_counted: 8,
      results_executed: 16,
      results_passed: 12,
      pass_rate: 0.75,
      flaky_cases: ["c002", "c003"],
    });
    expect(run1.stats.cost_stage).toBeCloseTo(0.16, 10);
    const rows1 = (await w.call("GET", `/api/eval-runs/${first}/results`)).body;
    expect(rows1.counts).toMatchObject({ all: 8, passed: 5, failed: 3, flaky: 2 });
    const byCase = Object.fromEntries(rows1.items.map((r: any) => [r.case_id, r.pass_fraction]));
    expect(byCase).toEqual({ c001: 1, c002: 0.5, c003: 0.5, c004: 0, c005: 1, c006: 1, c007: 1, c008: 1 });

    // Edit the stage prompt in the installed pipeline, then run 2 where c002 is stable.
    const pipelineFile = path.join(w.root, "pipelines", "eval-sample.pipeline.yaml");
    const pipelineText = await readFile(pipelineFile, "utf8");
    expect(pipelineText).toContain("Do not invent problems.");
    await writeFile(pipelineFile, pipelineText.replace("Do not invent problems.", "Do not invent problems. Cite the draft."));
    w.state.script = (caseId) => (caseId === "c004" ? "stage_failure" : "pass");
    // Run 2: only c004 still fails, 14 / 16 = 0.875, above the threshold.
    const second = await startAndWait(w, { label: "after prompt edit" });
    const run2 = (await w.call("GET", `/api/eval-runs/${second}`)).body;
    expect(run2).toMatchObject({ status: "completed", run_number: 2, passed: true });
    expect(run2.stats).toMatchObject({ results_executed: 16, results_passed: 14, pass_rate: 0.875, flaky_cases: [] });

    const cmp = (await w.call("GET", `/api/eval-compare?a=${first}&b=${second}`)).body;
    expect(cmp.shared_cases).toBe(8);
    expect(cmp.same_config).toBe(false);
    expect(cmp.stage_diff.changed_keys).toEqual(["system_prompt"]);
    expect(cmp.stage_diff.system_prompt_diff.some((l: any) => String(l.text).includes("Cite the draft."))).toBe(true);
    expect(cmp.cases.map((c: any) => [c.case_id, c.change])).toContainEqual(["c002", "improved"]);
    expect(cmp.cases.map((c: any) => [c.case_id, c.change])).toContainEqual(["c003", "improved"]);
    expect(cmp.verdict).toBe("no_clear_difference");

    // Review: tag a failed repeat of run 1.
    const tagged = await w.call("PUT", `/api/eval-runs/${first}/results/c002/1/review`, {
      label: "fail",
      note: "invented a verdict",
      tags: ["Wrong verdict"],
    });
    expect(tagged.status).toBe(200);
    expect(tagged.body.tags).toEqual(["Wrong verdict"]);
    const afterTag = (await w.call("GET", `/api/eval-runs/${first}`)).body;
    expect(afterTag.stats.failure_types.by_tag).toEqual({ "Wrong verdict": 1 });
    const types = await w.call("GET", `/api/evals/critique-sample/failure-types?project_root=${encodeURIComponent(w.root)}`);
    expect(types.body.items).toEqual(["Wrong verdict"]);

    // Edit the eval: comments survive; a stale hash conflicts.
    const evalFile = path.join(w.root, "evals", "critique-sample.eval.yaml");
    await writeFile(evalFile, `# Owner note: threshold agreed with the team\n${await readFile(evalFile, "utf8")}`);
    const detail = (await w.call("GET", `/api/evals/critique-sample?project_root=${encodeURIComponent(w.root)}`)).body;
    expect(detail.yaml).toContain("# Owner note: threshold agreed with the team");
    const definition = { ...detail.definition, description: "Edited in the e2e test" };
    const saved = await w.call("PUT", "/api/evals/critique-sample", {
      project_root: w.root,
      definition,
      base_hash: detail.file_hash,
    });
    expect(saved.status).toBe(200);
    const onDisk = await readFile(evalFile, "utf8");
    expect(onDisk).toContain("# Owner note: threshold agreed with the team");
    expect(onDisk).toContain("Edited in the e2e test");
    const stale = await w.call("PUT", "/api/evals/critique-sample", {
      project_root: w.root,
      definition,
      base_hash: detail.file_hash,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "FILE_CHANGED", current_hash: saved.body.file_hash });

    // Delete run 1 together with its eval stage runs.
    const stageRuns = [...new Set((await w.store.listEvalResults(first)).map((r) => r.stageRunId))];
    expect((await w.call("DELETE", `/api/eval-runs/${first}`)).status).toBe(204);
    expect((await w.call("GET", `/api/eval-runs/${first}`)).status).toBe(404);
    expect([...w.deletedRuns].sort()).toEqual([...stageRuns].sort());
    expect((await w.call("GET", `/api/eval-runs/${second}`)).status).toBe(200);
  });

  it("drives sf eval validate and sf eval run --json against the same Host: exit 1 below threshold, exit 0 when passing", async () => {
    const w = await setup();
    await installSample(w);
    const cli = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runEvalCommand(args, {
        cwd: w.root,
        io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) },
        hostBaseUrl: w.origin,
        ensureService: alreadyUp,
        pollIntervalMs: 5,
        stderrIsTTY: false,
      });
      return { code, out, err, doc: () => JSON.parse(out.join("\n")) };
    };

    const valid = await cli(["validate", "critique-sample", "--json"]);
    expect(valid.code, valid.out.join("\n") + valid.err.join("\n")).toBe(0);
    expect(valid.doc()).toMatchObject({ ok: true, scope: "full" });

    w.state.script = RUN_ONE;
    const below = await cli(["run", "critique-sample", "--json"]);
    expect(below.code).toBe(1);
    expect(below.doc()).toMatchObject({
      outcome: "below_threshold",
      eval_id: "critique-sample",
      pass_rate: 0.75,
      threshold: 0.8,
      results: { executed: 16, passed: 12 },
    });

    w.state.script = () => "pass";
    const passed = await cli(["run", "critique-sample", "--json", "--case", "c001", "--case", "c003"]);
    expect(passed.code).toBe(0);
    expect(passed.doc()).toMatchObject({
      outcome: "passed",
      pass_rate: 1,
      results: { executed: 4, passed: 4, errored: 0 },
    });
  });
});
