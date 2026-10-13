import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { cp, mkdtemp, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StagePort } from "../src/agent/port.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { projectRunDetail } from "../src/runstore/runProjection.js";
import { startUiServer } from "../src/server/http.js";
import { projectRun } from "../src/projection/projectRun.js";
import { runResourceUri } from "../src/mcp/resources.js";
import type { RunPipelineDagSnapshot, RunStore } from "../src/runstore/port.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { RunManager } from "../src/runtime/runManager.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { mcpCall } from "./helpers/mcpCall.js";
import { closeServer } from "./helpers/closeServer.js";
import { stageKeyedAgent } from "./helpers/stageKeyedAgent.js";
import { waitFor } from "./helpers/waitFor.js";
import { withEnv } from "./helpers/withEnv.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { netPipeline } from "./helpers/fixturePaths.js";
import { seedDiamondRun } from "./helpers/seedDiamondRun.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function makeCatalogRepo() {
  const repo = await initTempGitRepo();
  for (const dir of ["pipelines", "tasks", "stages"]) {
    await cp(path.join(fixtures, dir), path.join(repo.root, dir), { recursive: true });
  }
  await writeFile(
    path.join(repo.root, "stageflow.yaml"),
    [
      "version: 1",
      "catalog:",
      "  pipelines:",
      "    - pipelines",
      "  tasks:",
      "    - tasks",
      "  patterns:",
      '    pipeline: "*.yaml"',
      '    task: "*.yaml"',
      "",
    ].join("\n"),
  );
  return repo;
}

let catalogRoot: string;
let cleanupCatalogRoot: () => Promise<void>;

beforeAll(async () => {
  const setup = await makeCatalogRepo();
  catalogRoot = await realpath(setup.root);
  cleanupCatalogRoot = setup.cleanup;
  clearFindProjectRootCacheForTests();
});

afterAll(async () => {
  clearFindProjectRootCacheForTests();
  await cleanupCatalogRoot();
});

async function waitUntilIdleHealth(base: string): Promise<void> {
  await waitFor(
    async () => (await mcpCall(base, "get_health")).payload?.activeCount === 0,
    { intervalMs: 25, message: "timeout waiting for idle health" },
  );
}

async function waitForActive(base: string, runId: string): Promise<void> {
  await waitFor(
    async () =>
      (await mcpCall(base, "get_health")).payload.activeRunIds?.includes(runId) === true,
    { intervalMs: 25, message: `timeout waiting for ${runId} to be active` },
  );
}

function successAgent(count = 12): StagePort {
  return scriptedFakeAgent(
    Array.from({ length: count }, (_, i) => ({
      type: "emit" as const,
      envelope: {
        status: "success" as const,
        summary: `s${i}`,
        artifacts: [],
        payload: { n: i },
      },
    })),
  );
}

async function withMcpServer(
  root: string,
  agent: StagePort,
  store = createRunStore({ rootDir: root }),
  opts: { maxConcurrent?: number; cwd?: string; mcpStateless?: boolean } = {},
) {
  const cwd = opts.cwd ?? catalogRoot;
  await store.ensureProject(cwd);
  const started = await startUiServer({
    agent,
    cwd,
    rootDir: root,
    store,
    port: 0,
    uiDistDir: path.join(root, "missing-ui"),
    maxConcurrent: opts.maxConcurrent,
    mcpStateless: opts.mcpStateless ?? true,
  });
  const address = started.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return {
    ...started,
    store,
    base: `http://127.0.0.1:${address.port}`,
  };
}

/** Fresh root + store (optionally seeded) + MCP server; always closed afterwards. */
async function withMcp<S = undefined, R = void>(
  agent: StagePort,
  fn: (ctx: {
    base: string;
    store: RunStore;
    root: string;
    mcpUrl: string;
    seeded: S;
  }) => Promise<R>,
  opts: {
    seed?: (store: RunStore) => Promise<S>;
    maxConcurrent?: number;
  } = {},
): Promise<R> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-"));
  const store = createRunStore({ rootDir: root });
  const seeded = (await opts.seed?.(store)) as S;
  const started = await withMcpServer(root, agent, store, {
    maxConcurrent: opts.maxConcurrent,
  });
  try {
    return await fn({
      base: started.base,
      store,
      root,
      mcpUrl: started.mcpUrl,
      seeded,
    });
  } finally {
    await closeServer(started.server);
  }
}

async function seedArtifacts(store: RunStore, files: Record<string, string | Buffer>) {
  const created = await store.createRun({
    pipelineId: "docs-only",
    taskYaml: "id: a\ngoal: g\n",
    taskId: "a",
  });
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(created.workspaceDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
  return created;
}

const hold = (id: string): Parameters<typeof scriptedFakeAgent>[0][number] => ({
  type: "wait_then_emit",
  waitRequests: [{ kind: "free_text", id: "prompt-1", message: id }],
  envelope: { status: "success", summary: id, artifacts: [] },
});

describe("MCP tools and HTTP inline task", () => {
  it("lists the catalog and starts an inline-task run whose get_run projection is lean", async () => {
    await withMcp(successAgent(), async ({ base, mcpUrl }) => {
      expect(mcpUrl).toBe(`${base}/mcp`);

      const pipelines = await mcpCall(base, "list_pipelines");
      expect(pipelines.status).toBe(200);
      expect(pipelines.isError).toBe(false);
      expect(
        pipelines.payload.pipelines.map((p: { path: string }) => p.path),
      ).toContain("pipelines/docs-only.pipeline.yaml");

      const tasks = await mcpCall(base, "list_tasks");
      expect(tasks.isError).toBe(false);
      expect(tasks.payload.tasks.map((t: { path: string }) => t.path)).toContain(
        "tasks/sample.task.yaml",
      );

      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "mcp-inline", goal: "from mcp" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;
      await waitUntilIdleHealth(base);

      const detail = await mcpCall(base, "get_run", { runId });
      expect(detail.isError).toBe(false);
      expect(detail.payload.run_id).toBe(runId);
      expect(detail.payload.status).toBe("succeeded");
      for (const stage of detail.payload.stages) {
        expect(stage.events).toBeUndefined();
        expect(stage.envelope.summary).toMatch(/^s\d+$/);
      }
      expect(detail.payload.task_yaml).toBeUndefined();
    });
  });

  it("list_pipelines/list_tasks span every project this host has recorded a run for", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-multiproj-"));
    const store = createRunStore({ rootDir: root });
    const { root: repoA, cleanup: cleanupA } = await makeCatalogRepo();
    const { root: repoB, cleanup: cleanupB } = await makeCatalogRepo();
    clearFindProjectRootCacheForTests();

    // Host is launched pointed at repoA. Both roots are registered via ensure;
    // start_run then uses catalog-relative paths + project_root (absolute wire
    // paths are refused on network surfaces).
    await store.ensureProject(repoA);
    await store.ensureProject(repoB);
    const { server } = await startUiServer({
      agent: successAgent(2),
      cwd: repoA,
      store,
      port: 0,
      uiDistDir: path.join(root, "missing-ui"),
      mcpStateless: true,
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const realRepoA = await realpath(repoA);
      const realRepoB = await realpath(repoB);

      for (const [projectRoot, id] of [
        [realRepoA, "a-task"],
        [realRepoB, "b-task"],
      ]) {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id, goal: id },
          project_root: projectRoot,
        });
        expect(started.isError).toBe(false);
        await waitUntilIdleHealth(base);
      }

      const pipelines = await mcpCall(base, "list_pipelines");
      expect(pipelines.isError).toBe(false);
      const roots = new Set(
        pipelines.payload.pipelines.map((p: { project_root: string }) => p.project_root),
      );
      expect(roots.has(realRepoA)).toBe(true);
      expect(roots.has(realRepoB)).toBe(true);

      const tasks = await mcpCall(base, "list_tasks");
      expect(tasks.isError).toBe(false);
      const taskRoots = new Set(
        tasks.payload.tasks.map((t: { project_root: string }) => t.project_root),
      );
      expect(taskRoots.has(realRepoA)).toBe(true);
      expect(taskRoots.has(realRepoB)).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await closeServer(server);
      await cleanupA();
      await cleanupB();
    }
  }, 15000);

  it("get_health reports idle capacity, version, and provider boot state without the removed inFlight field", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base }) => {
      const health = await mcpCall(base, "get_health");
      expect(health.isError).toBe(false);
      expect(health.payload).toMatchObject({
        ok: true,
        activeRunIds: [],
        activeCount: 0,
        activeStageProcesses: 0,
        version: PACKAGE_VERSION,
        stageflow_home: expect.any(String),
        boot_providers: {
          configured: expect.any(Array),
          failures: expect.any(Array),
        },
        providers_live: { note: expect.stringMatching(/list_providers/) },
      });
      expect(health.payload).not.toHaveProperty("inFlight");
      expect(health.payload.maxConcurrent).toBeGreaterThan(0);
      expect(health.payload.slotsAvailable).toBe(health.payload.maxConcurrent);
    });
  });

  it("start_run reports busy_checkout for a held checkout and busy_capacity when slots are full", async () => {
    await withEnv({ STAGEFLOW_MAX_QUEUED: "0" }, async () => {
      const checkout = await mkdtemp(path.join(tmpdir(), "sf-mcp-co-"));
      await withMcp(
        scriptedFakeAgent([hold("hold-a"), hold("hold-b")]),
        async ({ base }) => {
          const first = await mcpCall(base, "start_run", {
            pipeline: netPipeline("single"),
            task: { id: "holder", goal: "hold", checkout },
          });
          expect(first.isError).toBe(false);
          const holderId = first.payload.runId as string;
          await waitForActive(base, holderId);

          const sameCheckout = await mcpCall(base, "start_run", {
            pipeline: netPipeline("single"),
            task: { id: "same-checkout", goal: "same", checkout },
          });
          expect(sameCheckout.isError).toBe(true);
          expect(sameCheckout.payload.code).toBe("busy_checkout");
          expect(sameCheckout.payload.conflictingRunId).toBe(holderId);
          expect(sameCheckout.payload.conflictingCheckout).toBeTruthy();
          expect(sameCheckout.payload.activeRunIds).toEqual([holderId]);

          const second = await mcpCall(base, "start_run", {
            pipeline: netPipeline("single"),
            task: { id: "second", goal: "fills the last slot" },
          });
          expect(second.isError).toBe(false);
          const secondId = second.payload.runId as string;
          await waitForActive(base, secondId);

          const health = await mcpCall(base, "get_health");
          expect(health.payload).toMatchObject({
            ok: true,
            activeCount: 2,
            maxConcurrent: 2,
            slotsAvailable: 0,
          });
          expect(health.payload.activeRunIds).toHaveLength(2);

          const overCap = await mcpCall(base, "start_run", {
            pipeline: netPipeline("single"),
            task: { id: "over", goal: "no slot" },
          });
          expect(overCap.isError).toBe(true);
          expect(overCap.payload).toMatchObject({
            code: "busy_capacity",
            status: 409,
            activeCount: 2,
            maxConcurrent: 2,
          });
          expect([...overCap.payload.activeRunIds].sort()).toEqual(
            [holderId, secondId].sort(),
          );
        },
        { maxConcurrent: 2 },
      );
    });
  });

  it("projectRun drops events and task_yaml, keeps envelope payload, and mirrors pending_prompt", () => {
    const pending_prompt = {
      kind: "free_text" as const,
      id: "p1",
      message: "Name?",
    };
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "docs-only",
        created_at: "t",
        status: "running",
      },
      [
        {
          stage_id: "clarify",
          status: "succeeded",
          events: [{ event: "started" }],
          envelope: {
            status: "success",
            summary: "ok",
            artifacts: ["stages/clarify/attempts/1/artifacts/a.txt"],
            payload: { k: 1 },
          },
          artifacts: ["stages/clarify/attempts/1/artifacts/a.txt"],
        },
        {
          stage_id: "build",
          status: "waiting_for_input",
          events: [],
          envelope: null,
          artifacts: [],
          pending_prompt,
        },
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRun(detail);
    expect(projected).not.toHaveProperty("task_yaml");
    expect(projected.stages[0]).not.toHaveProperty("events");
    expect(projected.stages[0]?.envelope?.payload).toEqual({ k: 1 });
    expect(projected.stages[1]?.pending_prompt).toEqual(pending_prompt);
    expect(projected.pipeline_track.nodes.map((n) => n.stage_id)).toEqual([
      "clarify",
      "build",
    ]);
  });

  it("projectRun mirrors waiting_stage_ids for parallel waiting stages", () => {
    const waiting = (stage_id: string, id: string) => ({
      stage_id,
      status: "waiting_for_input" as const,
      events: [],
      envelope: null,
      artifacts: [],
      pending_prompt: { kind: "free_text" as const, id, message: `${id}?` },
    });
    const detail = projectRunDetail(
      {
        run_id: "r1",
        pipeline_id: "parallel-hitl-multi-wait",
        created_at: "t",
        status: "running",
      },
      [
        {
          stage_id: "clarify",
          status: "succeeded",
          events: [],
          envelope: null,
          artifacts: [],
        },
        waiting("branch-a", "a"),
        waiting("branch-b", "b"),
      ],
      "id: x\ngoal: y\n",
    );
    const projected = projectRun(detail);
    expect(projected.waiting_stage_ids).toEqual(["branch-a", "branch-b"]);
    expect(projected.pipeline_track.nodes.map((n) => n.stage_id)).toEqual([
      "clarify",
      "branch-a",
      "branch-b",
    ]);
  });
});


describe("MCP Tier 1 operator parity", () => {
  const freeTextPrompt = {
    kind: "free_text" as const,
    id: "prompt-1",
    message: "What should the module name be?",
  };
  const freeTextAnswer = {
    promptId: "prompt-1",
    kind: "free_text" as const,
    text: "payments",
  };

  it("list_waiting empty then includes waiting stage; answer_gate free_text succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-hitl-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "clarify-ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const empty = await mcpCall(base, "list_waiting");
      expect(empty.isError).toBe(false);
      expect(empty.payload.waiting).toEqual([]);

      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("single"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const listed = await mcpCall(base, "list_waiting");
      expect(listed.isError).toBe(false);
      expect(listed.payload.waiting).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            stageId: "clarify",
            waiting_kind: "free_text",
            waiting_prompt_id: "prompt-1",
            pending_prompt: freeTextPrompt,
          }),
        ]),
      );

      const answered = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(answered.isError).toBe(false);
      expect(answered.payload).toEqual({ ok: true });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const clarifyEvents = await mcpCall(base, "list_stage_events", {
        runId,
        stageId: "clarify",
      });
      expect(clarifyEvents.isError).toBe(false);
      const hitlEvents = clarifyEvents.payload.events as Array<{
        event: string;
      }>;
      expect(hitlEvents.some((e) => e.event === "operator_prompt")).toBe(true);
      expect(hitlEvents.some((e) => e.event === "operator_answer")).toBe(true);
      expect(hitlEvents.some((e) => e.event === "feedback_loop_decided")).toBe(
        false,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("list_waiting surfaces feedback_loop_decision; decide_feedback_loop continue succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-fb-dec-"));
    const sendBack: StageEnvelope = {
      status: "success",
      summary: "send-back",
      artifacts: [],
      feedback_loop: { action: "send_back", target: "implement" },
    };
    const agent = stageKeyedAgent({
      plan: [
        {
          type: "emit",
          envelope: { status: "success", summary: "plan-ok", artifacts: [] },
        },
      ],
      implement: [
        {
          type: "emit",
          envelope: { status: "success", summary: "implement-1", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "implement-2", artifacts: [] },
        },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [
        {
          type: "emit",
          envelope: { status: "success", summary: "submit-ok", artifacts: [] },
        },
      ],
    });
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("feedback-loop-wait-human"),
        task: { id: "t", goal: "g" },
      });
      expect(started.isError).toBe(false);
      const runId = started.payload.runId as string;

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.active_feedback_loop?.state === "waiting_for_human";
      });

      const listed = await mcpCall(base, "list_waiting", { runId });
      expect(listed.isError).toBe(false);
      expect(listed.payload.waiting).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            stageId: "review",
            waiting_kind: "feedback_loop_decision",
            deferred_target: "implement",
          }),
        ]),
      );
      const gates = listed.payload.waiting as Array<{
        stageId?: string;
        feedback_loop_id?: string;
      }>;
      const loopId = gates.find((g) => g.stageId === "review")?.feedback_loop_id;
      expect(loopId).toBeTruthy();

      const decided = await mcpCall(base, "decide_feedback_loop", {
        runId,
        stageId: "review",
        decision: "continue",
        loopId,
        reason: "ship the brief",
      });
      expect(decided.isError).toBe(false);
      expect(decided.payload).toEqual({
        ok: true,
        effect: "continued",
        loopId,
      });

      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.status === "succeeded";
      });

      const listedEvents = await mcpCall(base, "list_stage_events", {
        runId,
        stageId: "review",
      });
      expect(listedEvents.isError).toBe(false);
      const events = listedEvents.payload.events as Array<{
        event: string;
        decision?: string;
        loopId?: string;
        reason?: string;
      }>;
      const names = events.map((e) => e.event);
      const waitIdx = names.lastIndexOf("waiting_for_input");
      const decidedIdx = names.indexOf("feedback_loop_decided", waitIdx + 1);
      const succeededIdx = names.indexOf("succeeded", decidedIdx + 1);
      expect(decidedIdx).toBeGreaterThan(waitIdx);
      expect(succeededIdx).toBeGreaterThan(decidedIdx);
      expect(events[decidedIdx]).toMatchObject({
        event: "feedback_loop_decided",
        decision: "continue",
        loopId,
        reason: "ship the brief",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("answer_gate confirm / artifact_backed / multi_question succeed", async () => {
    const cases = [
      {
        label: "confirm",
        prompt: {
          kind: "confirm" as const,
          id: "confirm-proceed",
          message: "Proceed?",
        },
        answer: {
          promptId: "confirm-proceed",
          kind: "confirm" as const,
          decision: "accept" as const,
        },
      },
      {
        label: "artifact_backed",
        prompt: {
          kind: "artifact_backed" as const,
          id: "art-1",
          message: "Review artifact",
          artifacts: ["stages/clarify/attempts/1/artifacts/plan.md"],
        },
        answer: {
          promptId: "art-1",
          kind: "artifact_backed" as const,
          decision: "accept" as const,
        },
      },
      {
        label: "multi_question",
        prompt: {
          kind: "multi_question" as const,
          id: "mq-1",
          questions: [
            {
              id: "q-module",
              kind: "free_text" as const,
              message: "Module?",
            },
            {
              id: "q-owner",
              kind: "free_text" as const,
              message: "Owner?",
            },
          ],
        },
        answer: {
          promptId: "mq-1",
          kind: "multi_question" as const,
          answers: {
            "q-module": { kind: "free_text" as const, text: "payments" },
            "q-owner": { kind: "free_text" as const, text: "platform" },
          },
        },
      },
    ];

    for (const c of cases) {
      const root = await mkdtemp(path.join(tmpdir(), `sf-mcp-${c.label}-`));
      const agent = scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [c.prompt],
          envelope: {
            status: "success",
            summary: `${c.label}-ok`,
            artifacts: [],
          },
        },
      ]);
      const { server, base, store } = await withMcpServer(root, agent);
      try {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
        });
        const runId = started.payload.runId as string;
        await waitFor(async () => {
          const detail = await store.readRun(runId);
          return detail.stages.some((s) => s.status === "waiting_for_input");
        });
        const answered = await mcpCall(base, "answer_gate", {
          runId,
          stageId: "clarify",
          answer: c.answer,
        });
        expect(answered.isError).toBe(false);
        expect(answered.payload).toEqual({ ok: true });
        await waitFor(async () => (await store.readRun(runId)).status === "succeeded");
      } finally {
        await closeServer(server);
      }
    }
  });

  it("answer_gate malformed → 400; not waiting → 409; unknown → 404", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-ans-err-"));
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: [freeTextPrompt],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
    ]);
    const { server, base, store } = await withMcpServer(root, agent);

    try {
      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("single"),
        task: { id: "t", goal: "g" },
      });
      const runId = started.payload.runId as string;
      await waitFor(async () => {
        const detail = await store.readRun(runId);
        return detail.stages.some((s) => s.status === "waiting_for_input");
      });

      const bad = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: { promptId: "prompt-1", kind: "confirm", decision: "accept" },
      });
      expect(bad.isError).toBe(true);
      expect(bad.payload.status).toBe(400);

      const missingRun = await mcpCall(base, "answer_gate", {
        runId: "does-not-exist",
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(missingRun.isError).toBe(true);
      expect(missingRun.payload.status).toBe(404);

      const missingStage = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "no-such-stage",
        answer: freeTextAnswer,
      });
      expect(missingStage.isError).toBe(true);
      expect(missingStage.payload.status).toBe(404);

      const ok = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(ok.isError).toBe(false);
      await waitFor(async () => (await store.readRun(runId)).status === "succeeded");

      const notWaiting = await mcpCall(base, "answer_gate", {
        runId,
        stageId: "clarify",
        answer: freeTextAnswer,
      });
      expect(notWaiting.isError).toBe(true);
      expect(notWaiting.payload.status).toBe(409);
    } finally {
      await closeServer(server);
    }
  });

  it("list_stage_events and get_envelope expose recorded events, verification, and envelope", async () => {
    await withMcp(
      scriptedFakeAgent([
        {
          type: "emit",
          envelope: {
            status: "success",
            summary: "clarify-ok",
            artifacts: [],
            payload: { n: 1 },
          },
        },
      ]),
      async ({ base, store }) => {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
        });
        const runId = started.payload.runId as string;
        await waitUntilIdleHealth(base);

        await store.upsertVerificationCheckResult(runId, "clarify", {
          check_id: "handoff",
          check_type: "payload_schema",
          status: "passed",
          evidence: { kind: "payload_schema", schema_declared: true },
        });
        const verification = await mcpCall(base, "get_stage_verification", {
          runId,
          stageId: "clarify",
        });
        expect(verification.isError).toBe(false);
        expect(verification.payload.attempts[0].checks).toEqual([
          expect.objectContaining({ check_id: "handoff", status: "passed" }),
        ]);

        const events = await mcpCall(base, "list_stage_events", {
          runId,
          stageId: "clarify",
        });
        expect(events.isError).toBe(false);
        expect(events.payload.events.map((e: { event: string }) => e.event)).toContain(
          "succeeded",
        );

        const envelope = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "clarify",
        });
        expect(envelope.isError).toBe(false);
        expect(envelope.payload.envelope.summary).toBe("clarify-ok");
        expect(envelope.payload.envelope.payload).toEqual({ n: 1 });
        expect(envelope.payload).not.toHaveProperty("attempt");

        const missingRun = await mcpCall(base, "list_stage_events", {
          runId: "missing",
          stageId: "clarify",
        });
        expect(missingRun.isError).toBe(true);
        expect(missingRun.payload.status).toBe(404);

        const missingStage = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "nope",
        });
        expect(missingStage.isError).toBe(true);
        expect(missingStage.payload.status).toBe(404);
      },
    );
  });

  it("get_envelope returns the latest attempt by default and honors an explicit attempt", async () => {
    await withMcp(
      scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "attempt-1-prior", artifacts: [] },
        },
      ]),
      async ({ base, store }) => {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
        });
        const runId = started.payload.runId as string;
        await waitUntilIdleHealth(base);

        const second = await store.createStageExecution(runId, "clarify");
        expect(second.attempt).toBe(2);
        await store.writeEnvelope(
          runId,
          "clarify",
          {
            status: "success",
            summary: "attempt-2-latest",
            artifacts: [],
            payload: { n: 2 },
          },
          { attempt: 2 },
        );

        const latest = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "clarify",
        });
        expect(latest.isError).toBe(false);
        expect(latest.payload.envelope.summary).toBe("attempt-2-latest");
        expect(latest.payload).not.toHaveProperty("attempt");

        const prior = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "clarify",
          attempt: 1,
        });
        expect(prior.isError).toBe(false);
        expect(prior.payload.attempt).toBe(1);
        expect(prior.payload.envelope.summary).toBe("attempt-1-prior");

        const missingAttempt = await mcpCall(base, "get_envelope", {
          runId,
          stageId: "clarify",
          attempt: 99,
        });
        expect(missingAttempt.isError).toBe(true);
        expect(missingAttempt.payload.status).toBe(404);
      },
    );
  });

  it("retry_stage re-runs a failed stage as attempt 2 and 404s for an unknown run", async () => {
    await withMcp(
      scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "failure", summary: "design-fail", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "design-ok-retry", artifacts: [] },
        },
        {
          type: "emit",
          envelope: { status: "success", summary: "plan-ok", artifacts: [] },
        },
      ]),
      async ({ base, store }) => {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("linear-explicit"),
          task_path: "tasks/sample.task.yaml",
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;
        await waitFor(async () => (await store.readRunMeta(runId)).status === "failed");

        const missingRetry = await mcpCall(base, "retry_stage", {
          runId: "missing",
          stageId: "design-doc",
        });
        expect(missingRetry.isError).toBe(true);
        expect(missingRetry.payload.status).toBe(404);

        const retried = await mcpCall(base, "retry_stage", {
          runId,
          stageId: "design-doc",
        });
        expect(retried.isError).toBe(false);
        expect(retried.payload).toEqual({
          runId,
          stageId: "design-doc",
          attemptIndex: 2,
        });
        await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");
        const design = (await store.readRun(runId)).stages.find(
          (s) => s.stage_id === "design-doc",
        );
        expect(design?.envelope?.summary).toBe("design-ok-retry");
      },
    );
  });

  it("rerun starts a new run from the same pipeline and task", async () => {
    await withMcp(successAgent(2), async ({ base, store }) => {
      const started = await mcpCall(base, "start_run", {
        pipeline: netPipeline("single"),
        task: { id: "rerun-me", goal: "again" },
      });
      const runId = started.payload.runId as string;
      await waitFor(async () => (await store.readRunMeta(runId)).status === "succeeded");

      const rerun = await mcpCall(base, "rerun", { runId });
      expect(rerun.isError).toBe(false);
      const rerunId = rerun.payload.runId as string;
      expect(rerunId).not.toBe(runId);
      await waitFor(async () => (await store.readRunMeta(rerunId)).status === "succeeded");

      const original = await store.readRun(runId);
      const copy = await store.readRun(rerunId);
      expect(copy.pipeline_id).toBe(original.pipeline_id);
      expect(copy.task_yaml).toBe(original.task_yaml);
    });
  });

  it("abandon_stage abandons a started stage, rejects a waiting one (409), and 404s for an unknown run", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base, store }) => {
      const planted = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.appendStageEvent(planted.runId, "build", { event: "started" });
      await store.updateRunStatus(planted.runId, "running");

      const abandoned = await mcpCall(base, "abandon_stage", {
        runId: planted.runId,
        stageId: "build",
      });
      expect(abandoned.isError).toBe(false);
      expect(abandoned.payload).toEqual({
        ok: true,
        runId: planted.runId,
        stageId: "build",
      });

      const waitingPlant = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      await store.appendStageEvent(waitingPlant.runId, "clarify", { event: "started" });
      await store.appendStageEvent(waitingPlant.runId, "clarify", {
        event: "waiting_for_input",
      });
      const abandonWaiting = await mcpCall(base, "abandon_stage", {
        runId: waitingPlant.runId,
        stageId: "clarify",
      });
      expect(abandonWaiting.isError).toBe(true);
      expect(abandonWaiting.payload.status).toBe(409);

      const missingAbandon = await mcpCall(base, "abandon_stage", {
        runId: "missing",
        stageId: "build",
      });
      expect(missingAbandon.isError).toBe(true);
      expect(missingAbandon.payload.status).toBe(404);
    });
  });

  it("validate reports catalog findings and scopes to a broken pipeline", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base }) => {
      const full = await mcpCall(base, "validate", {});
      expect(full.isError).toBe(false);
      expect(full.payload).toMatchObject({
        ok: expect.any(Boolean),
        summary: expect.objectContaining({
          errors: expect.any(Number),
          warnings: expect.any(Number),
        }),
        findings: expect.any(Array),
      });

      const scoped = await mcpCall(base, "validate", {
        pipeline: netPipeline("broken"),
      });
      expect(scoped.isError).toBe(false);
      expect(scoped.payload.ok).toBe(false);
      expect(scoped.payload.findings.length).toBeGreaterThan(0);
    });
  });

  it("describe_pipeline returns the pipeline DAG and errors for a missing pipeline", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base }) => {
      const described = await mcpCall(base, "describe_pipeline", {
        pipeline: netPipeline("diamond-fan-in"),
      });
      expect(described.isError).toBe(false);
      expect(described.payload.id).toBe("diamond-fan-in");
      expect(described.payload.stages).toEqual([
        expect.objectContaining({ id: "clarify", needs: null, entry: true }),
        expect.objectContaining({ id: "research", needs: "clarify" }),
        expect.objectContaining({ id: "validation", needs: "clarify" }),
        expect.objectContaining({
          id: "synthesize",
          needs: [
            { id: "research", on: ["succeeded"] },
            { id: "validation", on: ["succeeded"] },
          ],
        }),
      ]);

      const missing = await mcpCall(base, "describe_pipeline", {
        pipeline: "pipelines/does-not-exist.pipeline.yaml",
      });
      expect(missing.isError).toBe(true);
      expect(missing.payload.error).toBeTruthy();
    });
  });

  it("get_run diamond pipeline_track has both inbound synthesize edges", async () => {
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const detail = await mcpCall(base, "get_run", { runId: seeded });
        expect(detail.isError).toBe(false);
        expect(
          detail.payload.pipeline_track.edges.filter(
            (e: { to: string }) => e.to === "synthesize",
          ),
        ).toEqual([
          { from: "research", to: "synthesize" },
          { from: "validation", to: "synthesize" },
        ]);
      },
      {
        seed: async (store) =>
          (
            await seedDiamondRun(store, "diamond-fan-in", {
              clarify: "succeeded",
              research: "succeeded",
              validation: "pending",
              synthesize: "pending",
            })
          ).runId,
      },
    );
  });

  it("get_run accepted-failure success projects succeeded, not failed", async () => {
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const detail = await mcpCall(base, "get_run", { runId: seeded });
        expect(detail.isError).toBe(false);
        expect(detail.payload.status).toBe("succeeded");
        expect(
          detail.payload.stages.find((s: { stage_id: string }) => s.stage_id === "research")
            ?.status,
        ).toBe("failed");
      },
      {
        seed: async (store) =>
          (
            await seedDiamondRun(
              store,
              "diamond-fan-in-accepted",
              {
                clarify: "succeeded",
                research: "failed",
                validation: "succeeded",
                synthesize: "succeeded",
              },
              "succeeded",
            )
          ).runId,
      },
    );
  });

  it("start_run and describe_pipeline reject an empty or whitespace pipeline", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base }) => {
      for (const blank of ["", "   "]) {
        const start = await mcpCall(base, "start_run", {
          pipeline: blank,
          task: { id: "t", goal: "g" },
        });
        expect(start.isError).toBe(true);
        expect(start.payload.error).toBe("pipeline is required");

        const describe = await mcpCall(base, "describe_pipeline", { pipeline: blank });
        expect(describe.isError).toBe(true);
        expect(describe.payload.error).toBe("pipeline is required");
        expect(describe.payload.status).toBe(400);
      }
    });
  });

  it("read_artifact maps missing artifacts to 404 and denied paths (incl. a denied png) to 400", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const deniedAuth = path.join("stages", "clarify", "attempts", "1", ".pi-agent", "auth.json");
    const deniedPng = path.join("stages", "screenshot", "attempts", "1", ".pi-agent", "page.png");
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const missingRun = await mcpCall(base, "read_artifact", {
          runId: "does-not-exist",
          path: "stages/clarify/attempts/1/artifacts/note.txt",
        });
        expect(missingRun.isError).toBe(true);
        expect(missingRun.payload.status).toBe(404);
        expect(missingRun.payload.error).toBeTruthy();

        const missingArtifact = await mcpCall(base, "read_artifact", {
          runId: seeded,
          path: "stages/clarify/attempts/1/artifacts/missing.txt",
        });
        expect(missingArtifact.isError).toBe(true);
        expect(missingArtifact.payload.status).toBe(404);
        expect(String(missingArtifact.payload.error)).toMatch(/Artifact not found/);

        for (const denied of [deniedAuth, deniedPng]) {
          const result = await mcpCall(base, "read_artifact", {
            runId: seeded,
            path: denied,
          });
          expect(result.isError).toBe(true);
          expect(result.payload.status).toBe(400);
          expect(String(result.payload.error)).toMatch(/Artifact path denied/);
          expect(result.content.map((c) => c.type)).not.toContain("image");
        }

        const escaped = await mcpCall(base, "read_artifact", {
          runId: seeded,
          path: "../outside.txt",
        });
        expect(escaped.isError).toBe(true);
        expect(escaped.payload.status).toBe(400);
        expect(String(escaped.payload.error)).toMatch(/\.\.|must not contain/);
      },
      {
        seed: async (store) =>
          (
            await seedArtifacts(store, {
              [deniedAuth]: JSON.stringify({ secret: "nope" }),
              [deniedPng]: png,
            })
          ).runId,
      },
    );
  });

  it("read_artifact returns UTF-8 text as JSON", async () => {
    const rel = path.join("stages", "clarify", "attempts", "1", "artifacts", "note.txt");
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const result = await mcpCall(base, "read_artifact", {
          runId: seeded,
          path: rel,
        });
        expect(result.isError).toBe(false);
        expect(result.payload).toEqual({
          runId: seeded,
          path: rel,
          content: "hello artifact",
        });
        expect(result.content[0]?.type).toBe("text");
      },
      {
        seed: async (store) =>
          (await seedArtifacts(store, { [rel]: "hello artifact" })).runId,
      },
    );
  });

  it("read_artifact returns MCP image content for a png", async () => {
    const rel = path.join("stages", "screenshot", "attempts", "1", "artifacts", "page.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const result = await mcpCall(base, "read_artifact", {
          runId: seeded,
          path: rel,
        });
        expect(result.isError).toBe(false);
        expect(result.content[0]).toEqual({
          type: "image",
          mimeType: "image/png",
          data: png.toString("base64"),
        });
        expect(result.payload).toEqual({
          runId: seeded,
          path: rel,
          mimeType: "image/png",
        });
        expect(result.content[1]?.text).not.toContain(png.toString("base64"));
      },
      {
        seed: async (store) => (await seedArtifacts(store, { [rel]: png })).runId,
      },
    );
  });

  it("read_artifact returns 400 for non-UTF-8 non-image bytes", async () => {
    const rel = path.join("stages", "clarify", "attempts", "1", "artifacts", "blob.zip");
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]);
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const result = await mcpCall(base, "read_artifact", {
          runId: seeded,
          path: rel,
        });
        expect(result.isError).toBe(true);
        expect(result.payload.status).toBe(400);
        expect(String(result.payload.error)).toMatch(/UTF-8|binary/i);
        expect(String(result.payload.error)).not.toContain("�");
        expect(JSON.stringify(result.payload)).not.toContain(zip.toString("base64"));
      },
      {
        seed: async (store) => (await seedArtifacts(store, { [rel]: zip })).runId,
      },
    );
  });

  it("list_runs filters by status, since, and pipeline; rejects an invalid since", async () => {
    await withMcp(
      scriptedFakeAgent([]),
      async ({ base, seeded }) => {
        const ids = (res: Awaited<ReturnType<typeof mcpCall>>) =>
          res.payload.runs.map((r: { run_id: string }) => r.run_id);

        const all = await mcpCall(base, "list_runs", {});
        expect(all.isError).toBe(false);
        expect(ids(all)).toEqual([seeded.b, seeded.a]);

        expect(ids(await mcpCall(base, "list_runs", { status: "failed" }))).toEqual([
          seeded.b,
        ]);
        expect(
          ids(await mcpCall(base, "list_runs", { since: seeded.cutoff })),
        ).toEqual([seeded.b]);
        expect(
          ids(await mcpCall(base, "list_runs", { pipeline: "docs-only" })),
        ).toEqual([seeded.a]);

        const bad = await mcpCall(base, "list_runs", { since: "not-a-date" });
        expect(bad.isError).toBe(true);
        expect(bad.payload.status).toBe(400);
        expect(bad.payload.error).toBe("since must be a valid date");
        expect(bad.payload.runs).toBeUndefined();
      },
      {
        seed: async (store) => {
          const a = await store.createRun({
            pipelineId: "docs-only",
            taskYaml: "id: t\ngoal: g\n",
            pipelinePath: path.join(catalogRoot, "pipelines", "docs-only.pipeline.yaml"),
          });
          await store.updateRunStatus(a.runId, "succeeded");
          await new Promise((r) => setTimeout(r, 5));
          const b = await store.createRun({
            pipelineId: "single",
            taskYaml: "id: t\ngoal: g\n",
            pipelinePath: path.join(catalogRoot, "pipelines", "single.pipeline.yaml"),
          });
          await store.updateRunStatus(b.runId, "failed");
          const cutoff = (await store.readRunMeta(b.runId)).created_at;
          return { a: a.runId, b: b.runId, cutoff };
        },
      },
    );
  });
});

describe("MCP Tier 2 wait_run", () => {
  const freeTextPrompt = {
    kind: "free_text" as const,
    id: "prompt-1",
    message: "What should the module name be?",
  };
  const freeTextAnswer = {
    promptId: "prompt-1",
    kind: "free_text" as const,
    text: "payments",
  };

  it("wakes on waiting with the pending prompt, then reports already for satisfied conditions", async () => {
    await withMcp(
      scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [freeTextPrompt],
          envelope: { status: "success", summary: "clarify-ok", artifacts: [] },
        },
      ]),
      async ({ base, store }) => {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
        });
        expect(started.isError).toBe(false);
        const runId = started.payload.runId as string;

        const waited = await mcpCall(base, "wait_run", {
          runId,
          until: "any",
          timeout_ms: 8_000,
        });
        expect(waited.isError).toBe(false);
        expect(waited.payload.reason).toBe("waiting");
        expect(waited.payload.until).toBe("any");
        expect(waited.payload.run.status).toBe("running");
        expect(waited.payload.run.waiting_stage_ids).toContain("clarify");
        expect(
          waited.payload.run.stages.find(
            (s: { stage_id: string }) => s.stage_id === "clarify",
          )?.pending_prompt,
        ).toEqual(freeTextPrompt);
        expect(waited.payload.run.stages[0]?.events).toBeUndefined();

        const alreadyWaiting = await mcpCall(base, "wait_run", {
          runId,
          until: "waiting",
          timeout_ms: 2_000,
        });
        expect(alreadyWaiting.isError).toBe(false);
        expect(alreadyWaiting.payload.reason).toBe("already");

        await mcpCall(base, "answer_gate", {
          runId,
          stageId: "clarify",
          answer: freeTextAnswer,
        });
        await waitFor(async () => (await store.readRun(runId)).status === "succeeded");

        const alreadyTerminal = await mcpCall(base, "wait_run", {
          runId,
          until: "terminal",
          timeout_ms: 2_000,
        });
        expect(alreadyTerminal.isError).toBe(false);
        expect(alreadyTerminal.payload.reason).toBe("already");
        expect(alreadyTerminal.payload.run.status).toBe("succeeded");
      },
    );
  });

  it("rejects an until value outside the schema enum", async () => {
    await withMcp(scriptedFakeAgent([]), async ({ base }) => {
      const bad = await mcpCall(base, "wait_run", { runId: "x", until: "nope" });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text ?? "").toMatch(
        /until: Invalid option: expected one of "any"\|"waiting"\|"terminal"/,
      );
    });
  });

  it("a client abort over HTTP does not disturb the waiting run", async () => {
    await withMcp(
      scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: [freeTextPrompt],
          envelope: { status: "success", summary: "ok", artifacts: [] },
        },
      ]),
      async ({ base, store }) => {
        const started = await mcpCall(base, "start_run", {
          pipeline: netPipeline("single"),
          task: { id: "t", goal: "g" },
        });
        const runId = started.payload.runId as string;
        await waitFor(async () =>
          (await store.readRun(runId)).stages.some((s) => s.status === "waiting_for_input"),
        );

        const controller = new AbortController();
        const pending = mcpCall(
          base,
          "wait_run",
          { runId, until: "terminal", timeout_ms: 30_000 },
          { signal: controller.signal },
        );
        const settled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await new Promise((r) => setTimeout(r, 100));
        controller.abort();
        await settled;

        const stillWaiting = await store.readRun(runId);
        expect(stillWaiting.status).toBe("running");
        expect(stillWaiting.stages.some((s) => s.status === "waiting_for_input")).toBe(true);

        const again = await mcpCall(base, "wait_run", {
          runId,
          until: "waiting",
          timeout_ms: 2_000,
        });
        expect(again.payload.reason).toBe("already");

        await mcpCall(base, "answer_gate", {
          runId,
          stageId: "clarify",
          answer: freeTextAnswer,
        });
        await waitFor(async () => (await store.readRun(runId)).status === "succeeded");
      },
    );
  });
});

function cloneInstanceDag(): RunPipelineDagSnapshot {
  return {
    stage_ids: ["author-diagrams~2"],
    roots: ["author-diagrams~2"],
    childrenOf: {},
    nodes: [
      {
        id: "author-diagrams~2",
        needs: null,
        needsEdges: [],
        ancestors: [],
        stageIndex: 0,
        definition_id: "author-diagrams",
      },
    ],
  };
}

async function seedSucceededStage(
  store: RunStore,
  runId: string,
  stageId: string,
  opts: { cost_usd?: number } = {},
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 1 });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" }, { attempt: 1 });
  await store.updateStageExecution(runId, stageId, 1, {
    status: "succeeded",
    envelope: { status: "success", summary: "ok", artifacts: [] },
    ...(opts.cost_usd !== undefined ? { cost_usd: opts.cost_usd } : {}),
  });
}

async function readRunResourcePayload(base: string, runId: string) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: runResourceUri(runId) },
    }),
  });
  const dataLine = (await res.text())
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error("no SSE data in MCP resources/read");
  const message = JSON.parse(dataLine.slice("data: ".length)) as {
    result?: { contents?: Array<{ text?: string }> };
  };
  const text = message.result?.contents?.[0]?.text;
  if (text === undefined) throw new Error("resources/read returned no contents");
  return JSON.parse(text) as Record<string, unknown> & {
    stages: Array<Record<string, unknown>>;
  };
}

describe("MCP lean run projection fields", () => {
  it("get_run, wait_run nested run, and run resource share cost and definition_id omit-or-present rules", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-lean-cost-"));
    const store = createRunStore({ rootDir: root });
    const withCost = await store.createRun({
      pipelineId: "clone-chain",
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: cloneInstanceDag(),
    });
    await seedSucceededStage(store, withCost.runId, "author-diagrams~2", {
      cost_usd: 0.0123,
    });
    const unused = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await seedSucceededStage(store, unused.runId, "clarify");

    const { server, base } = await withMcpServer(root, scriptedFakeAgent([]), store);
    try {
      const getWithCost = await mcpCall(base, "get_run", { runId: withCost.runId });
      const waitWithCost = await mcpCall(base, "wait_run", {
        runId: withCost.runId,
        until: "terminal",
        timeout_ms: 2_000,
      });
      const resourceWithCost = await readRunResourcePayload(base, withCost.runId);

      expect(getWithCost.isError).toBe(false);
      expect(waitWithCost.isError).toBe(false);
      expect(getWithCost.payload.total_cost_usd).toBe(0.0123);
      expect(waitWithCost.payload.run.total_cost_usd).toBe(0.0123);
      expect(resourceWithCost.total_cost_usd).toBe(0.0123);

      const costStage = getWithCost.payload.stages.find(
        (s: { stage_id: string }) => s.stage_id === "author-diagrams~2",
      );
      const waitStage = waitWithCost.payload.run.stages.find(
        (s: { stage_id: string }) => s.stage_id === "author-diagrams~2",
      );
      const resourceStage = resourceWithCost.stages.find(
        (s) => s.stage_id === "author-diagrams~2",
      );
      expect(costStage?.cost_usd).toBe(0.0123);
      expect(costStage?.definition_id).toBe("author-diagrams");
      expect(costStage?.events).toBeUndefined();
      expect(waitStage?.cost_usd).toBe(0.0123);
      expect(waitStage?.definition_id).toBe("author-diagrams");
      expect(waitStage?.events).toBeUndefined();
      expect(resourceStage?.cost_usd).toBe(0.0123);
      expect(resourceStage?.definition_id).toBe("author-diagrams");
      expect(resourceStage?.events).toBeUndefined();
      expect(getWithCost.payload.task_yaml).toBeUndefined();
      expect(waitWithCost.payload.run.task_yaml).toBeUndefined();
      expect(resourceWithCost.task_yaml).toBeUndefined();

      const getUnused = await mcpCall(base, "get_run", { runId: unused.runId });
      const waitUnused = await mcpCall(base, "wait_run", {
        runId: unused.runId,
        until: "terminal",
        timeout_ms: 2_000,
      });
      const resourceUnused = await readRunResourcePayload(base, unused.runId);

      expect(getUnused.payload.total_cost_usd).toBeUndefined();
      expect(waitUnused.payload.run.total_cost_usd).toBeUndefined();
      expect(resourceUnused.total_cost_usd).toBeUndefined();
      expect(getUnused.payload.stages[0]?.cost_usd).toBeUndefined();
      expect(waitUnused.payload.run.stages[0]?.cost_usd).toBeUndefined();
      expect(resourceUnused.stages[0]?.cost_usd).toBeUndefined();
      expect(getUnused.payload.stages[0]?.events).toBeUndefined();
      expect(waitUnused.payload.run.stages[0]?.events).toBeUndefined();
      expect(resourceUnused.stages[0]?.events).toBeUndefined();
      expect(getUnused.payload.task_yaml).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });
});

describe("MCP start_run repository binding (U7)", () => {
  it("rejects token fields before starting a run", async () => {
    await withMcp(successAgent(1), async ({ base }) => {
      const tokenReject = await mcpCall(base, "start_run", {
        pipeline: netPipeline("docs-only"),
        task: { id: "tok", goal: "nope" },
        github_token: "should-not-work",
      });
      expect(tokenReject.isError).toBe(true);
      expect(tokenReject.payload.code).toBe("start.token_rejected");
      expect(tokenReject.payload.field).toBe("github_token");
    });
  });

  it("forwards skip_gates and CI metadata to RunManager.startRun", async () => {
    const spy = vi.spyOn(RunManager.prototype, "startRun");
    try {
      await withMcp(successAgent(), async ({ base }) => {
        const skipCall = await mcpCall(base, "start_run", {
          pipeline: netPipeline("docs-only"),
          task: { id: "skip", goal: "gates" },
          skip_gates: true,
          git_sha: "abc",
          ci_pr_url: "https://example.com/pr/1",
          ci_job_url: "https://example.com/job/1",
        });
        expect(skipCall.isError).toBe(false);
        expect(spy).toHaveBeenCalledWith(
          expect.objectContaining({
            skipGates: true,
            gitSha: "abc",
            ciPrUrl: "https://example.com/pr/1",
            ciJobUrl: "https://example.com/job/1",
          }),
        );
        await waitUntilIdleHealth(base);
      });
    } finally {
      spy.mockRestore();
    }
  });
});
