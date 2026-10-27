import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/agents/errors.js";
import type { AgentService } from "../src/agents/service.js";
import type { ChannelService } from "../src/channels/service.js";
import { FakeEngine } from "../src/evals/engine/index.js";
import { EvalRunManager } from "../src/evals/manager.js";
import { buildRunDetail } from "../src/evals/read/runs.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import type { RunCaseResult } from "../src/evals/types.js";
import { buildGuideUi, createShowUiTool, GUIDE_UI_TOOL_NAMES } from "../src/guide/showUi.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { createMemoryHost } from "../src/memory/host.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import type { RunManager } from "../src/runtime/runManager.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const PIPELINE = `id: flow
model: test/model
memories: [notes]
stages:
  - id: draft
    entry: true
    uses: ../stages/draft.yaml
    route:
      - to: review
      - to: publish
  - id: review
    system_prompt: "Review the draft.\\nThen list issues."
    gate_kinds: [free_text]
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
    route:
      - to: publish
      - type: loop
        to: draft
        max_replays: 2
        on_max_replays: wait_for_human
        replay_session: new_session
  - id: publish
    system_prompt: Publish it.
    channels:
      - connection: ops-slack
        to: C0123
        operations: [send]
    io:
      input:
        schema:
          type: object
      output:
        schema:
          type: object
`;

const DRAFT_STAGE = `id: draft
system_prompt: Write a first draft.
model: other/model
verify:
  - run: "true"
    when: [after]
io:
  input:
    schema:
      type: object
  output:
    schema:
      type: object
`;

async function pipelineProject(): Promise<string> {
  const root = await tempDir("sf-guide-ui-");
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await writeFile(path.join(root, "pipelines", "flow.pipeline.yaml"), PIPELINE);
  await writeFile(path.join(root, "stages", "draft.yaml"), DRAFT_STAGE);
  await writeFile(
    path.join(root, "tasks", "launch.task.yaml"),
    "id: launch\ngoal: Ship the launch post\ncontext: Weekly\n",
  );
  return root;
}

function baseDeps(root: string, extra: Partial<McpToolDeps> = {}): McpToolDeps {
  return { manager: {} as unknown as RunManager, store: {} as unknown as RunStore, cwd: root, ...extra };
}

function uiOf(result: { ok: boolean; content: unknown }): any {
  expect(result.ok).toBe(true);
  return (result.content as { ui: unknown }).ui;
}

describe("show_ui", () => {
  it("is one tool named show_ui", () => {
    expect(GUIDE_UI_TOOL_NAMES).toEqual(["show_ui"]);
    expect(createShowUiTool(baseDeps(process.cwd())).name).toBe("show_ui");
  });

  it("builds the pipeline card from the files on disk, not from the model", async () => {
    const root = await pipelineProject();
    const deps = baseDeps(root);
    const ui = uiOf(
      await buildGuideUi(deps, {
        component: "pipeline",
        path: "pipelines/flow.pipeline.yaml",
        task_path: "tasks/launch.task.yaml",
        stages: [{ id: "invented" }],
      }),
    );
    expect(ui).toMatchObject({
      component: "pipeline",
      title: "flow",
      pipeline: {
        id: "flow",
        path: "pipelines/flow.pipeline.yaml",
        model: "test/model",
        memories: ["notes"],
        task: { id: "launch", goal: "Ship the launch post" },
      },
      link: { kind: "pipeline", id: "flow", path: "pipelines/flow.pipeline.yaml", projectRoot: root },
    });
    expect(ui.pipeline.stages).toEqual([
      { id: "draft", summary: "Write a first draft.", model: "other/model", needs: [], gates: [], channels: [], hasVerify: true },
      { id: "review", summary: "Review the draft.", needs: ["draft"], gates: ["free_text"], channels: [], hasVerify: false },
      { id: "publish", summary: "Publish it.", needs: ["draft", "review"], gates: [], channels: ["ops-slack"], hasVerify: false },
    ]);
    expect(ui.validation.ok).toBe(false);
    expect(ui.validation.errors).toBeGreaterThan(0);
    expect(ui.validation.messages.length).toBeGreaterThan(0);
    expect(ui.validation.messages.length).toBeLessThanOrEqual(5);

    await writeFile(path.join(root, "stages", "draft.yaml"), DRAFT_STAGE.replace("Write a first draft.", "Write it again."));
    const again = uiOf(await buildGuideUi(deps, { component: "pipeline", path: "pipelines/flow.pipeline.yaml", title: "Launch" }));
    expect(again.title).toBe("Launch");
    expect(again.pipeline.stages[0].summary).toBe("Write it again.");
    expect(again.pipeline.task).toBeUndefined();
  });

  it("returns an error code for a missing pipeline or bad args", async () => {
    const root = await pipelineProject();
    const deps = baseDeps(root);
    expect(await buildGuideUi(deps, { component: "pipeline", path: "pipelines/none.pipeline.yaml" })).toMatchObject({
      ok: false,
      error: "guide.ui_not_found",
    });
    expect(await buildGuideUi(deps, { component: "pipeline", path: "../outside.pipeline.yaml" })).toMatchObject({
      ok: false,
      error: "guide.ui_read_failed",
    });
    expect(await buildGuideUi(deps, { component: "pipeline" })).toMatchObject({ ok: false, error: "guide.ui_invalid_args" });
    expect(await buildGuideUi(deps, { component: "chart" })).toEqual({
      ok: false,
      content: { ok: false, error: "guide.ui_unknown_component" },
      error: "guide.ui_unknown_component",
    });
  });

  it("shows a memory from the memory host", async () => {
    const home = await tempDir("sf-guide-ui-mem-");
    const memories = createMemoryHost(home);
    await memories.create({ id: "notes", description: "Release notes" });
    await memories.addCard("notes", "v1.2", "Shipped");
    const deps = baseDeps(home, { memories });
    const ui = uiOf(await buildGuideUi(deps, { component: "resource", kind: "memory", id: "notes" }));
    expect(ui).toEqual({
      component: "resource",
      title: "notes",
      kind: "memory",
      fields: [
        { label: "Description", value: "Release notes" },
        { label: "Cards", value: "1" },
      ],
      link: { kind: "memory", id: "notes" },
    });
    expect(await buildGuideUi(deps, { component: "resource", kind: "memory", id: "missing" })).toMatchObject({
      ok: false,
      error: "guide.ui_not_found",
    });
    expect(await buildGuideUi(baseDeps(home), { component: "resource", kind: "memory", id: "notes" })).toMatchObject({
      ok: false,
      error: "guide.ui_unavailable",
    });
  });

  it("shows a connection without any secret", async () => {
    const secret = "test-bot-token-not-a-real-credential";
    const channels = {
      list: () => ({
        connections: [
          {
            id: "ops-slack",
            scope: "local",
            provider: "slack",
            displayName: "Ops Slack",
            enabled: true,
            secrets: { botToken: "store" },
            config: { botToken: secret },
            health: { state: "ok", checkedAt: "2026-01-01T00:00:00.000Z" },
          },
        ],
        limits: { channelsPerStage: 1 },
      }),
    } as unknown as ChannelService;
    const result = await buildGuideUi(baseDeps(process.cwd(), { channels }), {
      component: "resource",
      kind: "connection",
      id: "ops-slack",
    });
    const ui = uiOf(result);
    expect(ui).toMatchObject({
      kind: "connection",
      title: "Ops Slack",
      status: "enabled",
      link: { kind: "connection", id: "ops-slack", label: "Ops Slack" },
    });
    expect(ui.fields).toEqual([
      { label: "Name", value: "Ops Slack" },
      { label: "Provider", value: "slack" },
      { label: "Last check", value: "ok" },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("botToken");
  });

  it("shows an agent through the agent service", async () => {
    const agentService = {
      async get(_root: string, id: string) {
        if (id !== "support") throw new AgentError("agent.not_found");
        return {
          agent: {
            id: "support",
            name: "Support",
            description: "Answers customers",
            enabled: false,
            revision: 3,
            model: { backend: "pi", id: "anthropic/claude-sonnet-4-5", thinking: "medium" },
            tools: { builtin: ["read"], builtinTools: [], mcpServers: [], skills: [], browser: false },
            scheduleCron: null,
            channelConnection: null,
            subAgents: [],
          },
        };
      },
    } as unknown as AgentService;
    const deps = baseDeps(process.cwd(), { agentService });
    const ui = uiOf(await buildGuideUi(deps, { component: "resource", kind: "agent", id: "support" }));
    expect(ui).toEqual({
      component: "resource",
      title: "Support",
      kind: "agent",
      fields: [
        { label: "Name", value: "Support" },
        { label: "Description", value: "Answers customers" },
        { label: "Model", value: "anthropic/claude-sonnet-4-5" },
        { label: "Revision", value: "3" },
        { label: "Tools", value: "read" },
      ],
      status: "disabled",
      link: { kind: "agent", id: "support", label: "Support" },
    });
    expect(await buildGuideUi(deps, { component: "resource", kind: "agent", id: "nobody" })).toMatchObject({
      ok: false,
      error: "guide.ui_not_found",
    });
  });

  it("shows a task by path and refuses an unsupported kind", async () => {
    const root = await pipelineProject();
    const deps = baseDeps(root);
    const ui = uiOf(await buildGuideUi(deps, { component: "resource", kind: "task", id: "tasks/launch.task.yaml" }));
    expect(ui).toMatchObject({
      kind: "task",
      title: "launch",
      fields: [
        { label: "Goal", value: "Ship the launch post" },
        { label: "Context", value: "Weekly" },
        { label: "Path", value: "tasks/launch.task.yaml" },
      ],
      link: { kind: "task", id: "launch", path: "tasks/launch.task.yaml" },
    });
    expect(await buildGuideUi(deps, { component: "resource", kind: "run", id: "r1" })).toMatchObject({
      ok: false,
      error: "guide.ui_unsupported_kind",
    });
  });

  it("checks plan, choices, and links and caps their size", async () => {
    const deps = baseDeps(process.cwd());
    expect(
      uiOf(
        await buildGuideUi(deps, {
          component: "plan",
          title: "Set up releases",
          steps: [
            { title: "Write the pipeline", status: "done" },
            { title: "Add a trigger", detail: "Every Friday", status: "current" },
          ],
        }),
      ),
    ).toEqual({
      component: "plan",
      title: "Set up releases",
      steps: [
        { title: "Write the pipeline", status: "done" },
        { title: "Add a trigger", detail: "Every Friday", status: "current" },
      ],
    });
    expect(
      uiOf(
        await buildGuideUi(deps, {
          component: "plan",
          title: "Daily digest",
          steps: JSON.stringify([
            { title: "Summarize", status: "todo" },
            { title: "Email", status: "todo" },
          ]),
        }),
      ),
    ).toMatchObject({ component: "plan", title: "Daily digest", steps: [{ title: "Summarize", status: "todo" }, { title: "Email", status: "todo" }] });
    const tooMany = Array.from({ length: 13 }, (_, i) => ({ title: `Step ${i}`, status: "todo" }));
    expect(await buildGuideUi(deps, { component: "plan", title: "Too long", steps: tooMany })).toMatchObject({
      ok: false,
      error: "guide.ui_invalid_args",
    });
    expect(
      await buildGuideUi(deps, { component: "plan", title: "x".repeat(301), steps: [{ title: "a", status: "todo" }] }),
    ).toMatchObject({ ok: false, error: "guide.ui_invalid_args" });

    expect(
      uiOf(
        await buildGuideUi(deps, {
          component: "choices",
          question: "How should it start?",
          options: [
            { id: "clock", label: "On a schedule" },
            { id: "manual", label: "When I click", description: "From the console" },
          ],
          allow_other: true,
        }),
      ),
    ).toEqual({
      component: "choices",
      question: "How should it start?",
      options: [
        { id: "clock", label: "On a schedule" },
        { id: "manual", label: "When I click", description: "From the console" },
      ],
      allowOther: true,
    });
    expect(
      uiOf(
        await buildGuideUi(deps, {
          component: "choices",
          question: "How should it start?",
          options: JSON.stringify([
            { id: "clock", label: "On a schedule" },
            { id: "manual", label: "When I click", description: "From the console" },
          ]),
          allow_other: "false",
        }),
      ),
    ).toEqual({
      component: "choices",
      question: "How should it start?",
      options: [
        { id: "clock", label: "On a schedule" },
        { id: "manual", label: "When I click", description: "From the console" },
      ],
      allowOther: false,
    });
    const sevenOptions = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(await buildGuideUi(deps, { component: "choices", question: "Pick", options: sevenOptions })).toMatchObject({
      ok: false,
      error: "guide.ui_invalid_args",
    });

    expect(
      uiOf(
        await buildGuideUi(deps, {
          component: "links",
          links: [
            { kind: "pipeline", id: "flow", path: "pipelines/flow.pipeline.yaml", project_root: "/tmp/p" },
            { kind: "run", id: "run-1", label: "Last run" },
          ],
        }),
      ),
    ).toEqual({
      component: "links",
      links: [
        { kind: "pipeline", id: "flow", path: "pipelines/flow.pipeline.yaml", projectRoot: "/tmp/p" },
        { kind: "run", id: "run-1", label: "Last run" },
      ],
    });
    expect(await buildGuideUi(deps, { component: "links", links: [{ kind: "website", id: "x" }] })).toMatchObject({
      ok: false,
      error: "guide.ui_invalid_args",
    });
    const nine = Array.from({ length: 9 }, (_, i) => ({ kind: "run", id: `r${i}` }));
    expect(await buildGuideUi(deps, { component: "links", links: nine })).toMatchObject({
      ok: false,
      error: "guide.ui_invalid_args",
    });
  });
});

const EVAL_YAML = `version: 1
id: review
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

function verdictRunner(): StageCaseRunner {
  return {
    async runCase(_plan, req): Promise<RunCaseResult> {
      return {
        ok: true,
        stageRunId: `sr_${req.evalRunId}_${req.caseId}_${req.repeatIndex}`,
        output: {
          kind: "envelope",
          status: "success",
          summary: "done",
          payload: { verdict: req.caseId === "c1" ? "ok" : "bad" },
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
    addSpend: () => undefined,
  } as StageCaseRunner;
}

async function evalProject() {
  const root = await tempDir("sf-guide-ui-evals-");
  const home = await tempDir("sf-guide-ui-evals-home-");
  bindStageflowHomeForTests(home);
  for (const dir of ["pipelines", "stages", "evals", "datasets", "tasks", "triggers"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"), path.join(root, "pipelines", "feature-ship.pipeline.yaml"));
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await cp(
    path.join(FIXTURES_ROOT, "triggers", "manual-hello-world.trigger.yaml"),
    path.join(root, "triggers", "manual-hello-world.trigger.yaml"),
  );
  await writeFile(path.join(root, "tasks", "guide-ui-hello.task.yaml"), "id: guide-ui-hello\ngoal: Say hello\n");
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks:\n    - tasks\n  triggers:\n    - triggers\n",
  );
  const cases = [
    { id: "c1", input: { diff: "a" } },
    { id: "c2", input: { diff: "b" } },
    { id: "c3", input: { diff: "c" } },
  ];
  await writeFile(path.join(root, "datasets", "review.dataset.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  await writeFile(path.join(root, "evals", "review.eval.yaml"), EVAL_YAML);
  const store = createRunStore({ rootDir: home });
  await store.ensureProject(root);
  cleanups.push(() => store.close());
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: verdictRunner(),
    engines: () => new FakeEngine(),
    engineName: "fake",
    stageflowVersion: "9.9.9",
    workDirRoot: path.join(home, "eval-runs"),
  });
  const deps: McpToolDeps = { manager: {} as unknown as RunManager, store, cwd: root, evalRunManager };
  return { root, store, evalRunManager, deps };
}

describe("show_ui with the run store", () => {
  it("reports an eval run with numbers from the read model", async () => {
    const h = await evalProject();
    const projectRoot = await realpath(h.root);
    const started = await h.evalRunManager.start({
      projectRoot,
      evalPath: path.join(projectRoot, "evals", "review.eval.yaml"),
      overrides: {},
      startedVia: "mcp",
    });
    await h.evalRunManager.awaitFinished(started.evalRunId, 15_000);

    const ui = uiOf(await buildGuideUi(h.deps, { component: "eval_report", eval_run_id: started.evalRunId }));
    const row = await h.store.getEvalRun(started.evalRunId);
    const detail = await buildRunDetail({ store: h.store, row: row! });
    expect(ui).toEqual({
      component: "eval_report",
      title: `review run #${detail.run_number}`,
      evalId: "review",
      runId: started.evalRunId,
      status: detail.status,
      passRate: detail.stats?.pass_rate ?? null,
      passed: detail.passed,
      cases: detail.progress.cases_total,
      failures: [
        { caseId: "c2", reason: "Failed verdict-ok" },
        { caseId: "c3", reason: "Failed verdict-ok" },
      ],
      costUsd: detail.stats?.cost_total ?? detail.progress.cost_usd,
      link: { kind: "eval_run", id: started.evalRunId, path: detail.eval_path },
    });
    expect(ui.passRate).not.toBeNull();

    const evalCard = uiOf(await buildGuideUi(h.deps, { component: "resource", kind: "eval", id: "review" }));
    expect(evalCard).toMatchObject({ kind: "eval", title: "review", status: "completed", link: { kind: "eval", id: "review" } });
    expect(evalCard.fields).toContainEqual({ label: "Runs", value: "1" });

    expect(await buildGuideUi(h.deps, { component: "eval_report", eval_run_id: "missing" })).toMatchObject({
      ok: false,
      error: "guide.ui_not_found",
    });
  });

  it("shows a catalog trigger and a task by id", async () => {
    const h = await evalProject();
    const trigger = uiOf(await buildGuideUi(h.deps, { component: "resource", kind: "trigger", id: "manual-hello-world" }));
    expect(trigger).toMatchObject({
      kind: "trigger",
      title: "manual-hello-world",
      status: "enabled",
      fields: [
        { label: "Pipeline", value: "hello" },
        { label: "Task", value: "my-task" },
        { label: "Kind", value: "manual" },
      ],
      link: { kind: "trigger", id: "manual-hello-world" },
    });
    const task = uiOf(await buildGuideUi(h.deps, { component: "resource", kind: "task", id: "guide-ui-hello" }));
    expect(task).toMatchObject({ kind: "task", fields: [{ label: "Goal", value: "Say hello" }, { label: "Path", value: "tasks/guide-ui-hello.task.yaml" }] });
    expect(await buildGuideUi(h.deps, { component: "resource", kind: "trigger", id: "nope" })).toMatchObject({
      ok: false,
      error: "guide.ui_not_found",
    });
  });
});
