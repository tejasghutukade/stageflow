import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { EvalPlan, RunCaseResult } from "../src/evals/types.js";
import { handleMcpHttpRequest } from "../src/mcp/server.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalRoutes, type EvalRoutesDeps } from "../src/server/evalRoutes.js";
import { startUiServer } from "../src/server/http.js";
import {
  advanceGuideTurn,
  checkGuideConfirmation,
  createConfirmActionTool,
} from "../src/operatorAgent/profiles/guideConfirm.js";
import type { OperatorAgentToolContext } from "../src/operatorAgent/types.js";
import { guideConfirmationOutcome } from "../src/toolkit/modePolicy.js";
import { stageKeyedAgent } from "./helpers/stageKeyedAgent.js";
import { closeServer } from "./helpers/closeServer.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";
import { startTestService } from "./helpers/testInProcessService.js";
import { waitFor } from "./helpers/waitFor.js";
import { netPipeline, netTask } from "./helpers/fixturePaths.js";

const MODEL = "anthropic/claude-sonnet-4-5";
const STAGE_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

const envSaved: Record<string, string | undefined> = {};
const evalCleanups: Array<() => Promise<void>> = [];

function stashEnv(keys: string[]): void {
  for (const key of keys) envSaved[key] = process.env[key];
}

function restoreEnv(keys: string[]): void {
  for (const key of keys) {
    const value = envSaved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  stashEnv(["STAGEFLOW_HOME", "STAGEFLOW_GC_INTERVAL_MS"]);
  resetGlobalStageflowHomeForTests();
});

afterEach(async () => {
  restoreEnv(["STAGEFLOW_HOME", "STAGEFLOW_GC_INTERVAL_MS"]);
  resetGlobalStageflowHomeForTests();
  for (const cleanup of evalCleanups.splice(0).reverse()) await cleanup();
});

function fakeGuideCtx(): OperatorAgentToolContext & { advance(): void } {
  let context: unknown = { kind: "stageflow_guide" };
  return {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    emitProposal: () => undefined,
    advance: () => {
      context = advanceGuideTurn(context);
    },
  };
}

async function issueConfirm(
  ctx: OperatorAgentToolContext,
  tool: string,
  extra: { action?: string; id?: string } = {},
): Promise<string> {
  const result = await createConfirmActionTool().handler({ tool, summary: `Confirm ${tool}`, ...extra }, ctx);
  expect(result.ok).toBe(true);
  return (result.content as { confirmation_id: string }).confirmation_id;
}

async function withRunHost(
  agent: ReturnType<typeof scriptedFakeAgent>,
  fn: (ctx: { base: string; store: RunStore; root: string }) => Promise<void>,
  cwd?: string,
) {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-consolidation-home-"));
  process.env.STAGEFLOW_HOME = storeRoot;
  process.env.STAGEFLOW_GC_INTERVAL_MS = "0";
  resetGlobalStageflowHomeForTests();
  const store = createRunStore({ rootDir: storeRoot });
  const project = cwd ?? (await initTempGitRepo()).root;
  await store.ensureProject(project);
  const started = await startUiServer({
    agent,
    cwd: project,
    rootDir: storeRoot,
    store,
    port: 0,
    uiDistDir: path.join(storeRoot, "missing-ui"),
    mcpStateless: true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ base, store, root: storeRoot });
  } finally {
    await closeServer(started.server);
    await store.close();
    await rm(storeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withFixtureCatalog(
  agent: ReturnType<typeof scriptedFakeAgent>,
  fn: (ctx: { base: string; store: RunStore; root: string }) => Promise<void>,
) {
  const repo = await initTempGitRepo();
  try {
    for (const dir of ["pipelines", "tasks", "stages"]) {
      await cp(path.join(FIXTURES_ROOT, dir), path.join(repo.root, dir), { recursive: true });
    }
    await writeFile(
      path.join(repo.root, "stageflow.yaml"),
      "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n",
    );
    clearFindProjectRootCacheForTests();
    await withRunHost(agent, (ctx) => fn({ ...ctx, project: repo.root }), repo.root);
  } finally {
    clearFindProjectRootCacheForTests();
    await repo.cleanup();
  }
}

async function seedAuthoringProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  stages:\n    - stages\n",
  );
  await mkdir(path.join(root, "pipelines", "consolidation"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await cp(path.join(FIXTURES_ROOT, "stages", "clarify.yaml"), path.join(root, "stages", "clarify.yaml"));
  await writeFile(
    path.join(root, "stages", "finish.yaml"),
    `id: finish\nsystem_prompt: Finish work\nmodel: ${MODEL}\nio:\n  input:\n    schema:\n      type: object\n  output:\n    schema:\n      type: object\n`,
  );
}

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
  repeats: 1
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

function fakeEvalRunner(verdict = "ok"): StageCaseRunner {
  return {
    async runCase(_plan: EvalPlan, req): Promise<RunCaseResult> {
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
        latencyMs: 5,
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
      };
    },
    async cancelAll() {},
    spend: () => 0,
    addSpend: () => undefined,
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withEvalHost(fn: (ctx: { base: string; root: string; store: RunStore }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-consolidation-eval-proj-"));
  const home = await mkdtemp(path.join(tmpdir(), "sf-consolidation-eval-home-"));
  bindStageflowHomeForTests(home);
  for (const dir of ["pipelines", "stages", "evals", "datasets"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(
    path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"),
    path.join(root, "pipelines", "feature-ship.pipeline.yaml"),
  );
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await writeFile(path.join(root, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n");
  await writeFile(
    path.join(root, "datasets", "review.dataset.jsonl"),
    `${JSON.stringify({ id: "c1", input: { diff: "d" } })}\n`,
  );
  await writeFile(path.join(root, "evals", "review.eval.yaml"), evalYaml());

  const store = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: fakeEvalRunner(),
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
    evalRunManager,
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
  evalCleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  await fn({ base, root, store });
}

async function seedTriggerCatalog(root: string): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "triggers"), { recursive: true });
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  await cp(path.join(FIXTURES_ROOT, "stages", "clarify.yaml"), path.join(root, "stages", "clarify.yaml"));
  await writeFile(
    path.join(root, "pipelines", "hello.pipeline.yaml"),
    "id: hello\nstages:\n  - id: clarify\n    uses: ../stages/clarify.yaml\n",
  );
  await writeFile(path.join(root, "tasks", "my-task.task.yaml"), "id: my-task\ngoal: Say hello\n");
}

describe("MCP consolidation agent-level scenarios", () => {
  it("authors a two-stage gated pipeline, runs it, answers the gate, and reads envelope plus artifact", async () => {
    const agent = scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [{ kind: "free_text", id: "prompt-1", message: "Name?" }],
          envelope: {
            status: "success",
            summary: "clarified",
            artifacts: ["out/notes.txt"],
            payload: {},
          },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "finished", artifacts: [], payload: {} },
        },
      ]);
    await withFixtureCatalog(agent, async ({ base, store, project }) => {
        const created = await mcpCall(base, "write_pipeline", {
          mode: "create",
          directory: "pipelines/consolidation",
          id: "gate-flow",
          model: MODEL,
          allow_invalid: true,
          project_root: project,
        });
        expect(created.isError).toBe(false);
        const pipelinePath = created.payload.pipelinePath as string;
        const clarifyStage = await mcpCall(base, "write_stage", {
          mode: "create",
          path: pipelinePath,
          id: "clarify",
          entry: true,
          gate_kinds: ["free_text"],
          system_prompt: "Clarify the task into crisp requirements.",
          model: MODEL,
          project_root: project,
          allow_invalid: true,
          ...STAGE_IO,
        });
        expect(clarifyStage.isError, JSON.stringify(clarifyStage.payload)).toBe(false);
        const finishStage = await mcpCall(base, "write_stage", {
          mode: "create",
          path: pipelinePath,
          id: "finish",
          system_prompt: "Finish work",
          model: MODEL,
          project_root: project,
          allow_invalid: true,
          ...STAGE_IO,
        });
        expect(finishStage.isError, JSON.stringify(finishStage.payload)).toBe(false);
        await mcpCall(base, "write_stage", {
          mode: "update",
          path: pipelinePath,
          id: "clarify",
          route: [{ to: "finish" }],
          project_root: project,
        });

        const onDisk = await mcpCall(base, "read_pipeline", { path: pipelinePath, project_root: project });
        expect(onDisk.isError, JSON.stringify(onDisk.payload)).toBe(false);
        expect(onDisk.payload.validation.summary.errors).toBe(0);
        const validated = await mcpCall(base, "validate", {
          kind: "pipeline",
          pipeline: pipelinePath,
          project_root: project,
        });
        expect(validated.isError).toBe(false);
        expect(validated.payload.summary.errors).toBe(0);

        const started = await mcpCall(base, "start_run", {
          pipeline: pipelinePath,
          task_path: netTask("sample"),
          project_root: project,
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;

        const waiting = await mcpCall(base, "wait_run", { runId, until: "waiting", timeout_ms: 15_000 });
        expect(waiting.payload.reason).toBe("waiting");
        const prompt = waiting.payload.run.stages.find((s: { stage_id: string }) => s.stage_id === "clarify")
          ?.pending_prompt as { id: string; kind: string };
        expect(prompt?.kind).toBe("free_text");

        await mcpCall(base, "answer_gate", {
          runId,
          stageId: "clarify",
          answer: { promptId: prompt.id, kind: "free_text", text: "payments" },
        });
        await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");

        const terminal = await mcpCall(base, "wait_run", { runId, until: "terminal", timeout_ms: 5_000 });
        expect(terminal.payload.run.status).toBe("succeeded");

        const envelope = await mcpCall(base, "get_stage", { view: "envelope", runId, stageId: "clarify" });
        expect(envelope.payload.envelope.summary).toBe("clarified");
        expect(envelope.payload.envelope.artifacts).toContain("out/notes.txt");

        const workspaceDir = store.getWorkspaceDir(runId);
        await mkdir(path.join(workspaceDir, "out"), { recursive: true });
        await writeFile(path.join(workspaceDir, "out/notes.txt"), "consolidated");
        const artifact = await mcpCall(base, "run_files", {
          view: "artifact",
          runId,
          path: "out/notes.txt",
        });
        expect(artifact.isError).toBe(false);
        expect(artifact.payload.content).toBe("consolidated");
    });
  });

  it("patches a pipeline stage then overwrites a standalone stage file", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedAuthoringProject(root);
      clearFindProjectRootCacheForTests();
      await withRunHost(scriptedFakeAgent([]), async ({ base }) => {
        const pkg = await mcpCall(base, "write_pipeline", {
          mode: "create",
          directory: "pipelines/consolidation",
          id: "patch-me",
          model: MODEL,
          allow_invalid: true,
          project_root: root,
        });
        expect(pkg.isError).toBe(false);
        expect(typeof pkg.payload?.pipelinePath).toBe("string");
        const pipelinePath = pkg.payload.pipelinePath as string;
        const stageAdd = await mcpCall(base, "write_stage", {
          mode: "create",
          path: pipelinePath,
          id: "alpha",
          system_prompt: "One",
          model: MODEL,
          project_root: root,
          allow_invalid: true,
          ...STAGE_IO,
        });
        expect(stageAdd.isError).toBe(false);
        const patched = await mcpCall(base, "write_stage", {
          mode: "update",
          path: pipelinePath,
          id: "alpha",
          patch: { system_prompt: "One revised" },
          project_root: root,
        });
        expect(patched.isError).toBe(false);
        const afterPatch = await mcpCall(base, "read_pipeline", { path: pipelinePath, project_root: root });
        expect(afterPatch.isError).toBe(false);
        expect(JSON.stringify(afterPatch.payload.draft)).toContain("One revised");

        const soloYaml = `id: solo\nsystem_prompt: Standalone\nmodel: ${MODEL}\nio:\n  input:\n    schema:\n      type: object\n  output:\n    schema:\n      type: object\n`;
        await writeFile(path.join(root, "stages/solo.yaml"), soloYaml);
        const overwrote = await mcpCall(base, "write_stage", {
          mode: "update",
          path: "stages/solo.yaml",
          content: soloYaml.replace("Standalone", "Overwritten"),
          project_root: root,
        });
        expect(overwrote.isError, JSON.stringify(overwrote.payload)).toBe(false);
        expect(await readFile(path.join(root, "stages/solo.yaml"), "utf8")).toContain("Overwritten");
      }, root);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("reruns and retries failed work over MCP with separate Guide confirmations", async () => {
    const retryAgent = scriptedFakeAgent([
      { type: "emit", envelope: { status: "success", summary: "clarify-ok", artifacts: [] } },
      { type: "emit", envelope: { status: "failure", summary: "design-fail", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "clarify-ok-rerun", artifacts: [] } },
      { type: "emit", envelope: { status: "failure", summary: "design-fail-rerun", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "design-ok", artifacts: [] } },
      { type: "emit", envelope: { status: "success", summary: "plan-ok", artifacts: [] } },
    ]);
    await withFixtureCatalog(retryAgent, async ({ base, store }) => {
      const failed = await mcpCall(base, "start_run", {
        pipeline: netPipeline("linear-explicit"),
        task_path: "tasks/sample.task.yaml",
      });
      const failedId = failed.payload.runId as string;
      await waitFor(async () => (await store.readRunMeta(failedId)).status === "failed");

      const rerun = await mcpCall(base, "start_run", { from_run: failedId });
      expect(rerun.isError).toBe(false);
      const rerunId = rerun.payload.runId as string;
      await waitFor(async () => (await store.readRunMeta(rerunId)).status === "failed");

      const retried = await mcpCall(base, "stage_action", {
        action: "retry",
        runId: failedId,
        stageId: "design-doc",
      });
      expect(retried.isError).toBe(false);
      await waitFor(async () => (await store.readRunMeta(failedId)).status === "succeeded");
    });

    const ctx = fakeGuideCtx();
    ctx.advance();
    expect(guideConfirmationOutcome("start_run", { from_run: "run-a" })).toBe("required");
    expect(guideConfirmationOutcome("stage_action", { action: "retry", runId: "run-a", stageId: "design" })).toBe(
      "required",
    );
    const rerunConfirm = await issueConfirm(ctx, "start_run", { action: "from_run", id: "run-a" });
    ctx.advance();
    const retryConfirm = await issueConfirm(ctx, "stage_action", { action: "retry", id: "run-b" });
    expect(retryConfirm).not.toBe(rerunConfirm);
    ctx.advance();
    expect(checkGuideConfirmation("start_run", { confirmation_id: rerunConfirm, from_run: "run-a" }, ctx)).toBeNull();
    expect(
      checkGuideConfirmation(
        "stage_action",
        { confirmation_id: retryConfirm, action: "retry", runId: "run-b", stageId: "design-doc" },
        ctx,
      ),
    ).toBeNull();
    expect(
      checkGuideConfirmation("start_run", { confirmation_id: retryConfirm, from_run: "run-a" }, ctx)?.error,
    ).toBeTruthy();
    expect(
      checkGuideConfirmation("stage_action", { confirmation_id: rerunConfirm, action: "retry", runId: "run-b" }, ctx)
        ?.error,
    ).toBeTruthy();
  });

  it("answers a feedback-loop wait with decide_feedback_loop", async () => {
    const sendBack = {
      status: "success" as const,
      summary: "send-back",
      artifacts: [] as string[],
      feedback_loop: { action: "send_back" as const, target: "implement" },
    };
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: { status: "success", summary: "plan-ok", artifacts: [] } }],
      implement: [
        { type: "emit", envelope: { status: "success", summary: "implement-1", artifacts: [] } },
        { type: "emit", envelope: { status: "success", summary: "implement-2", artifacts: [] } },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "emit", envelope: { status: "success", summary: "submit-ok", artifacts: [] } }],
    });
    await withFixtureCatalog(agent, async ({ base, store }) => {
      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("feedback-loop-wait-human"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      await waitFor(async () => (await store.readRun(runId)).active_feedback_loop?.state === "waiting_for_human");
      const listed = await mcpCall(base, "list_waiting", { runId });
      const loopId = (listed.payload.waiting as Array<{ feedback_loop_id?: string; stageId?: string }>).find(
        (w) => w.stageId === "review",
      )?.feedback_loop_id;
      expect(loopId).toBeTruthy();
      const decided = await mcpCall(base, "decide_feedback_loop", {
        runId,
        stageId: "review",
        decision: "continue",
        loopId,
        reason: "ship",
      });
      expect(decided.payload).toMatchObject({ ok: true, effect: "continued", loopId });
      await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");
    });
  });

  it("creates an agent, updates it, diffs revisions, restores, and hits a stale-base conflict", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "sf-consolidation-agent-proj-"));
    await withRunHost(scriptedFakeAgent([]), async ({ base }) => {
      const created = await mcpCall(base, "save_agent", {
        mode: "create",
        definition: { id: "helper", name: "Helper", instructions: "v1" },
      });
      expect(created.payload.agent).toMatchObject({ id: "helper", revision: 1 });
      const rev1 = created.payload.agent.revision as number;

      const updated = await mcpCall(base, "save_agent", {
        mode: "update",
        id: "helper",
        baseRevision: rev1,
        definition: { id: "helper", name: "Helper", instructions: "v2" },
      });
      expect(updated.payload.agent.revision).toBe(rev1 + 1);

      const diff = await mcpCall(base, "get_agent", {
        id: "helper",
        view: "diff",
        from: rev1,
        to: rev1 + 1,
      });
      expect(diff.payload.some((row: { text: string }) => row.text.includes("v2"))).toBe(true);

      const restored = await mcpCall(base, "save_agent", {
        mode: "update",
        id: "helper",
        baseRevision: rev1 + 1,
        revision: rev1,
      });
      expect(restored.payload.agent.revision).toBe(rev1 + 2);

      const conflict = await mcpCall(base, "save_agent", {
        mode: "update",
        id: "helper",
        baseRevision: rev1,
        definition: { id: "helper", name: "Helper", instructions: "stale" },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.payload.code).toBe("agent.conflict");
    }, project);
    await rm(project, { recursive: true, force: true });
  });

  it("disables an agent without confirmation and requires confirmation to enable", async () => {
    await withRunHost(scriptedFakeAgent([]), async ({ base }) => {
      await mcpCall(base, "save_agent", {
        mode: "create",
        definition: { id: "toggle", name: "Toggle", instructions: "x" },
      });
      expect(guideConfirmationOutcome("set_agent_enabled", { id: "toggle", enabled: false })).toBe("none");
      expect(guideConfirmationOutcome("set_agent_enabled", { id: "toggle", enabled: true })).toBe("required");
      const disabled = await mcpCall(base, "set_agent_enabled", { id: "toggle", enabled: false });
      expect(disabled.isError).toBe(false);
      const enabled = await mcpCall(base, "set_agent_enabled", { id: "toggle", enabled: true });
      expect(enabled.isError).toBe(false);
    });
    const ctx = fakeGuideCtx();
    ctx.advance();
    expect(checkGuideConfirmation("set_agent_enabled", { id: "toggle", enabled: true }, ctx)?.error).toBe(
      "guide.confirmation_required",
    );
    const id = await issueConfirm(ctx, "set_agent_enabled", { id: "toggle" });
    ctx.advance();
    expect(checkGuideConfirmation("set_agent_enabled", { confirmation_id: id, id: "toggle", enabled: true }, ctx)).toBeNull();
  });

  it("dry-runs GC then executes it via delete_runs", async () => {
    await withRunHost(scriptedFakeAgent([]), async ({ base, store, root }) => {
      const planted = await store.createRun({ pipelineId: "docs-only", taskYaml: "id: t\ngoal: g\n" });
      await store.updateRunStatus(planted.runId, "succeeded");
      const connection = (store as { connection: import("better-sqlite3").Database }).connection;
      connection
        .prepare(`UPDATE runs SET finished_at = ? WHERE run_id = ?`)
        .run(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), planted.runId);

      const dry = await mcpCall(base, "delete_runs", { gc: true });
      expect(dry.payload).toMatchObject({ slimmed: [planted.runId], purged: [], bareCachesEvicted: [] });
      expect((await store.readRunMeta(planted.runId)).slimmed_at).toBeUndefined();

      const executed = await mcpCall(base, "delete_runs", { gc: true, execute: true });
      expect(executed.payload.slimmed).toEqual([planted.runId]);
      expect((await store.readRunMeta(planted.runId)).slimmed_at).toBeDefined();
      expect(root).toBeTruthy();
    });
  });

  it("creates a trigger without confirmation and requires confirmation to enable", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await seedTriggerCatalog(root);
      clearFindProjectRootCacheForTests();
      const homeRoot = await mkdtemp(path.join(tmpdir(), "sf-consolidation-trig-"));
      bindStageflowHomeForTests(homeRoot);
      const store = createRunStore({ rootDir: homeRoot });
      await store.ensureProject(root);
      const service = await startTestService(store, scriptedFakeAgent([]), root);
      try {
        expect(
          guideConfirmationOutcome("save_trigger", {
            mode: "create",
            directory: "triggers",
            id: "off-by-default",
            pipeline: "hello",
            task: "my-task",
            kind: "manual",
            enabled: false,
          }),
        ).toBe("none");
        const created = await mcpCall(service.baseUrl, "save_trigger", {
          mode: "create",
          project_root: root,
          directory: "triggers",
          id: "off-by-default",
          pipeline: "hello",
          task: "my-task",
          kind: "manual",
          enabled: false,
        });
        expect(created.isError).toBe(false);
        expect(created.payload.enabled).toBe(false);
        expect(
          guideConfirmationOutcome("save_trigger", { mode: "update", id: "off-by-default", enabled: true, project_root: root }),
        ).toBe("required");
        const enabled = await mcpCall(service.baseUrl, "save_trigger", {
          mode: "update",
          project_root: root,
          id: "off-by-default",
          enabled: true,
        });
        expect(enabled.isError).toBe(false);
        expect(enabled.payload.enabled).toBe(true);
      } finally {
        await service.stop();
      }
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("installs the eval sample, runs it, reads results, and reviews one result", async () => {
    await withEvalHost(async ({ base, root }) => {
      const installed = await mcpCall(base, "save_eval", {
        mode: "create",
        source: "sample",
        project_root: root,
      });
      expect(installed.isError).toBe(false);
      expect(installed.payload.eval_id).toBe("critique-sample");

      const run = await mcpCall(base, "run_eval", {
        eval_id: "critique-sample",
        project_root: root,
        wait: true,
        repeats: 1,
      });
      expect(run.isError).toBe(false);
      expect(run.payload.status).toBe("completed");
      const evalRunId = run.payload.eval_run_id as string;

      const rows = await mcpCall(base, "get_eval_results", { eval_run_id: evalRunId });
      expect(rows.isError).toBe(false);
      expect(rows.payload.items.length).toBeGreaterThan(0);
      const firstCase = rows.payload.items[0].case_id as string;

      const reviewed = await mcpCall(base, "review_eval_results", {
        action: "label",
        eval_run_id: evalRunId,
        case_id: firstCase,
        repeat_index: 0,
        label: "pass",
        note: "looks good",
      });
      expect(reviewed.isError).toBe(false);
      expect(reviewed.payload).toMatchObject({ label: "pass", note: "looks good" });
    });
  });
});