import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { AgentError } from "../src/agents/errors.js";
import type { AgentService } from "../src/agents/service.js";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import type { SuggestionInput } from "../src/evals/triage/types.js";
import { registerEvalTools } from "../src/mcp/evalTools.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { buildExport } from "../src/evals/read/runs.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NEW_TOOLS = [
  "create_eval",
  "update_eval",
  "create_dataset",
  "update_dataset_cases",
  "convert_dataset",
  "install_eval_sample",
  "try_eval_case",
  "get_eval_run_export",
  "put_eval_review",
  "accept_eval_failure_suggestions",
  "dismiss_eval_failure_suggestions",
  "delete_eval_run",
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

function fakeRunner(state: { verdict: string | ((caseId: string) => string); delayMs: number }) {
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
      const verdict = typeof state.verdict === "function" ? state.verdict(req.caseId) : state.verdict;
      return {
        ok: true,
        stageRunId: `sr_${req.evalRunId}_${req.caseId}_${req.repeatIndex}`,
        output: {
          kind: "envelope",
          status: "success",
          summary: "done",
          payload: { verdict },
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

const suggestion = (caseId: string, overrides: Partial<SuggestionInput> = {}): SuggestionInput => ({
  caseId,
  repeatIndex: 0,
  source: "jev",
  bucket: "agent_wrong",
  failureType: "tone",
  confidence: 0.9,
  bucketProbabilities: { agent_wrong: 0.9, grader_wrong: 0.1, case_wrong: 0, unclear: 0 },
  graderFalseAlarms: [],
  model: "jev-1.13.0",
  promptVersion: 1,
  batchId: "sb_1",
  costUsd: 0.01,
  stateTruncated: false,
  ...overrides,
});

async function setup(opts: { withManager?: boolean; agents?: AgentService } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-eval-write-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-mcp-eval-write-home-"));
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
  const deletedRuns: string[] = [];
  const manager = {
    deleteRun: async (id: string) => {
      deletedRuns.push(id);
      return { ok: true };
    },
  } as unknown as RunManager;
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
  const deps: McpToolDeps = {
    manager,
    store,
    cwd: root,
    ...(opts.withManager === false ? {} : { evalRunManager }),
    evalEngineStatus: () => engine,
    ...(opts.agents !== undefined ? { agentService: opts.agents } : {}),
  };
  const tools: Array<{ name: string; inputSchema?: ZodType; handler: (args: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> }> = [];
  registerEvalTools(
    {
      registerTool(name: string, config: { inputSchema?: ZodType }, handler: (args: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>) {
        tools.push({ name, inputSchema: config.inputSchema, handler });
      },
    } as never,
    deps,
  );
  cleanups.push(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
    const result = await tool.handler(parsed);
    const text = result.content?.[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) as any };
  };
  return { root, store, runner, manager: evalRunManager, engine, deletedRuns, tools, call };
}

describe("MCP eval write tools", () => {
  it("registers the write tools on a local recorder", async () => {
    const h = await setup();
    const names = h.tools.map((t) => t.name);
    for (const name of NEW_TOOLS) expect(names, name).toContain(name);
  });

  it("creates an eval, refuses a duplicate, and rejects an invalid definition without writing it", async () => {
    const h = await setup();
    const detail = await h.call("get_eval", { eval_id: "review", project_root: h.root });
    const created = await h.call("create_eval", {
      project_root: h.root,
      definition: { ...detail.payload.definition, id: "second" },
    });
    expect(created.isError).toBe(false);
    expect(created.payload).toMatchObject({ id: "second", path: "evals/second.eval.yaml" });
    expect(await readFile(path.join(h.root, "evals", "second.eval.yaml"), "utf8")).toContain("id: second");

    const dup = await h.call("create_eval", {
      project_root: h.root,
      definition: { ...detail.payload.definition, id: "second" },
    });
    expect(dup.isError).toBe(true);
    expect(dup.payload.code).toBe("EVAL_EXISTS");

    const invalid = await h.call("create_eval", {
      project_root: h.root,
      definition: { ...detail.payload.definition, id: "third", dataset: "../datasets/missing.dataset.jsonl" },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.payload.code).toBe("EVAL_INVALID");
    expect(invalid.payload.findings.some((f: { severity: string }) => f.severity === "error")).toBe(true);
    expect(JSON.stringify(invalid.payload)).not.toMatch(/api_key|sk-|authorization/i);
    expect((await readdir(path.join(h.root, "evals"))).includes("third.eval.yaml")).toBe(false);
  });

  it("updates an eval from definition or yaml and returns FILE_CHANGED with the current hash", async () => {
    const h = await setup();
    const detail = await h.call("get_eval", { eval_id: "review", project_root: h.root });
    const definition = { ...detail.payload.definition, description: "Edited" };
    const updated = await h.call("update_eval", {
      eval_id: "review",
      project_root: h.root,
      base_hash: detail.payload.file_hash,
      definition,
    });
    expect(updated.isError).toBe(false);
    expect(updated.payload.yaml).toContain("description: Edited");

    const stale = await h.call("update_eval", {
      eval_id: "review",
      project_root: h.root,
      base_hash: detail.payload.file_hash,
      definition,
    });
    expect(stale.payload).toMatchObject({ code: "FILE_CHANGED", current_hash: updated.payload.file_hash });

    await expect(
      h.call("update_eval", {
        eval_id: "review",
        project_root: h.root,
        base_hash: updated.payload.file_hash,
        definition,
        yaml: "version: 1\nid: review\n",
      }),
    ).rejects.toThrow(/yaml|definition/);

    const badYaml = await h.call("update_eval", {
      eval_id: "review",
      project_root: h.root,
      base_hash: updated.payload.file_hash,
      yaml: "version: 1\nid: review\n",
    });
    expect(badYaml.payload.code).toBe("EVAL_INVALID");
    expect(await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8")).toContain("description: Edited");
  });

  it("validate_eval accepts dataset_cases and path and writes nothing", async () => {
    const h = await setup();
    const before = await readdir(path.join(h.root, "evals"));
    const yaml = (await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8")).replace(
      "id: review",
      "id: draft",
    ).replace("dataset: ../datasets/review.dataset.jsonl", "dataset: ../datasets/not-written-yet.dataset.jsonl");
    const missing = await h.call("validate_eval", { yaml, path: "evals/draft.eval.yaml", project_root: h.root });
    expect(missing.payload.findings.map((f: { code: string }) => f.code)).toContain("eval.dataset_unresolved");

    const inline = await h.call("validate_eval", {
      yaml,
      path: "evals/draft.eval.yaml",
      project_root: h.root,
      dataset_cases: [
        { id: "d1", input: { diff: "change" } },
        { id: "bad", input: { other: 1 } },
      ],
    });
    const codes = inline.payload.findings.map((f: { code: string }) => f.code);
    expect(codes).not.toContain("eval.dataset_unresolved");
    expect(codes).toContain("eval.cases_skipped");

    const byId = await h.call("validate_eval", {
      eval_id: "review",
      project_root: h.root,
      dataset_cases: [{ id: "bad", input: { other: 1 } }],
    });
    expect(byId.payload.findings.map((f: { code: string }) => f.code)).toContain("eval.no_valid_cases");

    const reviewYaml = await readFile(path.join(h.root, "evals", "review.eval.yaml"), "utf8");
    const atHome = await h.call("validate_eval", { yaml: reviewYaml, path: "evals/review.eval.yaml", project_root: h.root });
    expect(atHome.payload.findings.filter((f: { severity: string }) => f.severity === "error")).toEqual([]);
    const moved = await h.call("validate_eval", { yaml: reviewYaml, path: "a/b/review.eval.yaml", project_root: h.root });
    expect(moved.payload.findings.map((f: { code: string }) => f.code)).toContain("eval.dataset_unresolved");

    const outside = await h.call("validate_eval", { yaml: reviewYaml, path: "../outside.eval.yaml", project_root: h.root });
    expect(outside.payload.code).toBe("path_outside_project_root");
    expect(await readdir(path.join(h.root, "evals"))).toEqual(before);
    expect(await readFile(path.join(h.root, "datasets", "review.dataset.jsonl"), "utf8")).toContain("diff c1");
  });

  it("run_eval only_failed_from reruns the cases that failed", async () => {
    const h = await setup();
    h.runner.state.verdict = (caseId) => (caseId === "c2" ? "bad" : "ok");
    const first = await h.call("run_eval", { eval_id: "review", project_root: h.root, wait: true, repeats: 1 });
    expect(first.payload.status).toBe("completed");
    const second = await h.call("run_eval", {
      eval_id: "review",
      project_root: h.root,
      wait: true,
      repeats: 1,
      only_failed_from: first.payload.eval_run_id,
    });
    expect(second.isError).toBe(false);
    expect(second.payload.progress.cases_total).toBe(1);
    expect(second.payload.config.overrides.only_failed_from).toBe(first.payload.eval_run_id);
    const results = await h.call("get_eval_results", { eval_run_id: second.payload.eval_run_id });
    expect(results.payload.items.map((r: { case_id: string }) => r.case_id)).toEqual(["c2"]);

    const unknown = await h.call("run_eval", {
      eval_id: "review",
      project_root: h.root,
      only_failed_from: "er_missing",
    });
    expect(unknown.payload.code).toBe("EVAL_INVALID");
  });

  it("creates, appends, replaces, and edits dataset cases through the write functions", async () => {
    const h = await setup();
    const target = { pipeline_path: "pipelines/feature-ship.pipeline.yaml", stage_id: "review" };
    const created = await h.call("create_dataset", {
      project_root: h.root,
      name: "mine",
      cases: [{ input: { diff: "a" } }, { input: { diff: "b" }, tags: ["t"] }],
    });
    expect(created.isError).toBe(false);
    expect(created.payload).toMatchObject({ id: "mine", path: "datasets/mine.dataset.jsonl", cases_total: 2, editable: true });
    expect(created.payload.cases.map((c: { id: string }) => c.id)).toEqual(["c001", "c002"]);

    const dup = await h.call("create_dataset", { project_root: h.root, name: "mine", cases: [{ input: { diff: "a" } }] });
    expect(dup.payload.code).toBe("DATASET_EXISTS");

    const appended = await h.call("create_dataset", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "append",
      base_hash: created.payload.hash,
      cases: [{ input: { diff: "c" } }],
    });
    expect(appended.payload.cases.map((c: { id: string }) => c.id)).toEqual(["c001", "c002", "c003"]);

    const stale = await h.call("create_dataset", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "replace",
      base_hash: created.payload.hash,
      cases: [{ input: { diff: "z" } }],
    });
    expect(stale.payload.code).toBe("FILE_CHANGED");

    const replaced = await h.call("create_dataset", {
      project_root: h.root,
      dataset_id: "mine",
      mode: "replace",
      base_hash: appended.payload.hash,
      cases: [{ input: { diff: "z" } }],
    });
    expect(replaced.payload.cases_total).toBe(1);

    const sampleMismatch = await h.call("create_dataset", {
      project_root: h.root,
      name: "sample-copy",
      source: "sample",
      target,
    });
    expect(sampleMismatch.payload.code).toBe("DATASET_INVALID");
    expect((await readdir(path.join(h.root, "datasets"))).includes("sample-copy.dataset.jsonl")).toBe(false);

    const noRuns = await h.call("create_dataset", {
      project_root: h.root,
      name: "from-runs",
      source: "runs",
      target,
      run_ids: ["missing-run"],
    });
    expect(noRuns.payload.code).toBe("DATASET_CASE_OP_INVALID");

    const sessions = await h.call("create_dataset", {
      project_root: h.root,
      name: "from-sessions",
      source: "sessions",
      target: { agent_id: "support" },
      session_ids: ["s1"],
    });
    expect(sessions.payload.code).toBe("EVAL_ENGINE_UNAVAILABLE");

    const loaded = await loadDatasetFile(path.join(h.root, "datasets", "review.dataset.jsonl"), { root: h.root });
    const patched = await h.call("update_dataset_cases", {
      project_root: h.root,
      dataset_id: "review",
      base_hash: loaded.contentHash,
      ops: [
        { op: "add", case: { input: { diff: "new" }, title: "added" } },
        { op: "update", id: "c2", case: { input: { diff: "edited" } } },
        { op: "set_tags", id: "c3", tags: ["wip"] },
        { op: "delete", id: "c1" },
      ],
    });
    expect(patched.isError).toBe(false);
    expect(patched.payload.cases_total).toBe(3);
    expect(patched.payload.cases.find((c: { id: string }) => c.id === "c3").tags).toEqual(["wip"]);
    expect(patched.payload.cases.some((c: { id: string }) => c.id === "c1")).toBe(false);

    const atomic = await h.call("update_dataset_cases", {
      project_root: h.root,
      dataset_id: "review",
      base_hash: patched.payload.hash,
      ops: [{ op: "delete", id: "c2" }, { op: "delete", id: "ghost" }],
    });
    expect(atomic.payload.code).toBe("DATASET_CASE_OP_INVALID");
    expect(patched.payload.cases_total).toBe(3);
    const after = await loadDatasetFile(path.join(h.root, "datasets", "review.dataset.jsonl"), { root: h.root });
    expect(after.cases).toHaveLength(3);

    await writeFile(path.join(h.root, "datasets", "solo.dataset.csv"), "id,input.diff:json\nc001,1\n");
    const csv = await loadDatasetFile(path.join(h.root, "datasets", "solo.dataset.csv"), { root: h.root });
    const converted = await h.call("convert_dataset", {
      project_root: h.root,
      dataset_id: "solo",
      base_hash: csv.contentHash,
    });
    expect(converted.isError, JSON.stringify(converted.payload)).toBe(false);
    expect(converted.payload).toMatchObject({ id: "solo", format: "jsonl", editable: true });
    expect(await readFile(path.join(h.root, "datasets", "solo.dataset.csv"), "utf8")).toContain("c001");
  });

  it("installs the stage sample, copies its cases, and refuses an agent sample without the agent service", async () => {
    const h = await setup();
    const first = await h.call("install_eval_sample", { project_root: h.root });
    expect(first.isError, JSON.stringify(first.payload)).toBe(false);
    expect(first.payload.eval_id).toBe("critique-sample");
    const again = await h.call("install_eval_sample", { project_root: h.root });
    expect(again.payload.code).toBe("SAMPLE_EXISTS");

    const copied = await h.call("create_dataset", {
      project_root: h.root,
      name: "sample-copy",
      source: "sample",
      target: { pipeline_path: "pipelines/eval-sample.pipeline.yaml", stage_id: "critique" },
    });
    expect(copied.isError, JSON.stringify(copied.payload)).toBe(false);
    expect(copied.payload.cases_total).toBeGreaterThan(0);

    const agent = await h.call("install_eval_sample", { project_root: h.root, kind: "agent" });
    expect(agent.payload.code).toBe("SAMPLE_AGENTS_UNAVAILABLE");
  });

  it("installs the agent sample through the agent service", async () => {
    const calls: string[] = [];
    const agents = {
      async get() {
        throw new AgentError("agent.not_found", "missing");
      },
      async create(_projectRoot: string, raw: { web_chat?: { enabled?: boolean } }) {
        calls.push(`create:${raw.web_chat?.enabled}`);
        return {};
      },
      async setEnabled() {
        calls.push("enable");
        return {};
      },
    } as unknown as AgentService;
    const h = await setup({ agents });
    await writeFile(
      path.join(h.root, "stageflow.yaml"),
      "version: 1\nmodel: anthropic/claude-sonnet-4-5\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
    );
    const installed = await h.call("install_eval_sample", { project_root: h.root, kind: "agent" });
    expect(installed.isError, JSON.stringify(installed.payload)).toBe(false);
    expect(installed.payload.eval_id).toBe("support-sample");
    expect(calls).toEqual(["create:false", "enable"]);
    expect(await readFile(path.join(h.root, "evals", "support-sample.eval.yaml"), "utf8")).toContain("support-sample");
  });

  it("tries one case from an eval or an unsaved definition and passes allow_real_tools through", async () => {
    const h = await setup();
    const seen: Array<Record<string, unknown>> = [];
    const original = h.manager.tryOne.bind(h.manager);
    h.manager.tryOne = async (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      return original(input);
    };
    const byId = await h.call("try_eval_case", { project_root: h.root, eval_id: "review", case_id: "c1" });
    expect(byId.isError).toBe(false);
    expect(byId.payload.result).toMatchObject({ case_id: "c1", repeat_index: 0, status: "completed", passed: true, review: null, subject_ref: null });
    expect(byId.payload.result.grades[0]).toMatchObject({ grader_id: "verdict-ok", passed: true, error_code: null });
    expect(byId.payload.result.cost_usd).toBeCloseTo(0.01, 6);
    expect(byId.payload.cost_usd).toBe(0);
    expect(seen[0]).not.toHaveProperty("allowRealTools");

    const detail = await h.call("get_eval", { eval_id: "review", project_root: h.root });
    const draft = await h.call("try_eval_case", {
      project_root: h.root,
      definition: { ...detail.payload.definition, id: "draft" },
      case: { input: { diff: "inline" } },
    });
    expect(draft.payload.result.passed).toBe(true);
    expect((await readdir(path.join(h.root, "evals"))).includes("draft.eval.yaml")).toBe(false);

    const inline = await h.call("try_eval_case", {
      project_root: h.root,
      eval_id: "review",
      dataset_cases: [{ input: { diff: "a" } }, { input: { diff: "b" } }],
      case_id: "c002",
      allow_real_tools: true,
    });
    expect(inline.payload.result.case_id).toBe("c002");
    expect(seen.at(-1)).toMatchObject({ allowRealTools: true });

    await expect(h.call("try_eval_case", { project_root: h.root, eval_id: "review" })).rejects.toThrow(/case_id|case/);
    expect((await h.store.listEvalRuns({ limit: 10 })).items).toEqual([]);
  });

  it("try_eval_case reports the engine unavailable when the manager is missing", async () => {
    const h = await setup({ withManager: false });
    const res = await h.call("try_eval_case", { project_root: h.root, eval_id: "review", case_id: "c1" });
    expect(res.isError).toBe(true);
    expect(res.payload.code).toBe("EVAL_ENGINE_UNAVAILABLE");
    expect(res.payload.error).toMatch(/not available/i);
  });

  it("exports a run, reviews a failed result, and accepts or dismisses suggestions", async () => {
    const h = await setup();
    h.runner.state.verdict = (caseId) => (caseId === "c2" ? "bad" : "ok");
    const run = await h.call("run_eval", { eval_id: "review", project_root: h.root, wait: true, repeats: 1 });
    const id = run.payload.eval_run_id as string;
    const row = await h.store.getEvalRun(id);
    const exported = await h.call("get_eval_run_export", { eval_run_id: id });
    expect(exported.isError).toBe(false);
    expect(exported.payload).toEqual(await buildExport({ store: h.store, row: row!, what: "results" }));
    expect(exported.payload.filename).toBe("review-run-1-results.json");
    expect(exported.payload.body.results).toHaveLength(3);
    const config = await h.call("get_eval_run_export", { eval_run_id: id, what: "config" });
    expect(config.payload).toEqual(await buildExport({ store: h.store, row: row!, what: "config" }));
    expect(JSON.stringify(exported.payload) + JSON.stringify(config.payload)).not.toMatch(/api_key|sk-|authorization/i);

    const tagged = await h.call("put_eval_review", {
      eval_run_id: id,
      case_id: "c2",
      repeat_index: 0,
      label: "fail",
      note: "wrong verdict",
      tags: ["Missed issue"],
    });
    expect(tagged.payload).toEqual({ label: "fail", note: "wrong verdict", tags: ["Missed issue"] });
    const onPassed = await h.call("put_eval_review", {
      eval_run_id: id,
      case_id: "c1",
      repeat_index: 0,
      label: "pass",
      tags: ["x"],
    });
    expect(onPassed.payload.code).toBe("EVAL_TAGS_ON_PASSED_RESULT");
    const badLabel = await h.call("put_eval_review", { eval_run_id: id, case_id: "c1", repeat_index: 0, label: "maybe" });
    expect(badLabel.payload.code).toBe("invalid_request");

    const rows = await h.store.upsertEvalSuggestions(id, [
      suggestion("c2"),
      suggestion("c3", { bucket: "unclear", failureType: null, confidence: 0.4 }),
    ]);
    const low = await h.call("accept_eval_failure_suggestions", { eval_run_id: id, min_confidence: 2 });
    expect(low.payload.code).toBe("invalid_request");
    const dismissed = await h.call("dismiss_eval_failure_suggestions", { eval_run_id: id, ids: [rows[1]!.id] });
    expect(dismissed.payload).toEqual({ dismissed: 1 });
    const accepted = await h.call("accept_eval_failure_suggestions", { eval_run_id: id, ids: [rows[0]!.id] });
    expect(accepted.payload).toEqual({ accepted: 1, tagged: 1 });
    const detail = await h.call("get_eval_result", { eval_run_id: id, case_id: "c2" });
    expect(detail.payload.repeats[0].tags).toEqual(expect.arrayContaining(["Missed issue", "tone"]));
    const listed = await h.call("get_eval_failure_suggestions", { eval_run_id: id });
    expect(listed.payload.items.map((s: { status: string }) => s.status).sort()).toEqual(["accepted", "dismissed"]);
  });

  it("deletes a finished run and its stage runs, and refuses a running run", async () => {
    const h = await setup();
    const finished = await h.call("run_eval", { eval_id: "review", project_root: h.root, wait: true, repeats: 1 });
    const id = finished.payload.eval_run_id as string;
    const stageRunIds = [...new Set((await h.store.listEvalResults(id)).map((r) => r.stageRunId).filter((v): v is string => v != null))];
    const del = await h.call("delete_eval_run", { eval_run_id: id });
    expect(del.payload).toEqual({ deleted: true });
    expect([...h.deletedRuns].sort()).toEqual([...stageRunIds].sort());
    expect((await h.call("get_eval_run", { eval_run_id: id })).payload.code).toBe("EVAL_RUN_NOT_FOUND");

    h.runner.state.delayMs = 10_000;
    const started = await h.call("run_eval", { eval_id: "review", project_root: h.root, wait: false });
    const running = started.payload.eval_run_id as string;
    const refused = await h.call("delete_eval_run", { eval_run_id: running });
    expect(refused.payload.code).toBe("EVAL_RUN_ACTIVE");
    await h.call("cancel_eval_run", { eval_run_id: running });
  });
});
