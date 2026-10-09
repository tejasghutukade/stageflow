import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import { FakeAgent, fakeHitlResumePath, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageHandle, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { globalStageflowHome } from "../src/project/globalHome.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import { reconstructAndContinue } from "../src/runtime/resumeReconstruct.js";
import { StageHitlController } from "../src/runtime/stageHitl.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { runStage } from "../src/runtime/stageRunner.js";
import { exitForOutcome, runStageWorker } from "../src/runtime/stageWorker.js";
import {
  outcomeToWorkerResult,
  PROCESS_EXIT_FORCE_MS,
  scheduleExitWithDrain,
  STAGE_WORKER_EXIT,
} from "../src/runtime/stageWorkerProtocol.js";

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeStageYaml(
  root: string,
  id: string,
  extraLines: string[] = [],
): Promise<void> {
  await mkdir(path.join(root, "stages"), { recursive: true });
  await writeFile(
    path.join(root, "stages", `${id}.yaml`),
    [
      `id: ${id}`,
      "system_prompt: x",
      "model: anthropic/claude-sonnet-4-5",
      "io:",
      "  input:",
      "    schema:",
      "      type: object",
      "  output:",
      "    schema:",
      "      type: object",
      ...extraLines,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writePipelineYaml(
  root: string,
  fileStem: string,
  pipelineId: string,
  stageLines: string[],
): Promise<string> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  const pipelineFile = path.join(root, "pipelines", `${fileStem}.pipeline.yaml`);
  await writeFile(
    pipelineFile,
    [`id: ${pipelineId}`, "stages:", ...stageLines, ""].join("\n"),
    "utf8",
  );
  return pipelineFile;
}

async function writeNamedSkillPipeline(
  root: string,
  skillName: string,
): Promise<string> {
  await writeStageYaml(root, "named-stage", [`skill: ${skillName}`]);
  return writePipelineYaml(root, "named-skill", "named-skill", [
    "  - id: named-stage",
    "    uses: ../stages/named-stage.yaml",
  ]);
}

const doneEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [],
};

/** Replaces PiAgentAdapter.openStage so worker runs never reach a real Pi session. */
function mockPiOpenStage(onOpen?: (input: StageRunInput) => void): void {
  vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation(
    (input: StageRunInput): StageHandle => {
      onOpen?.(input);
      return {
        stageId: input.stageId ?? input.stage.id,
        async next() {
          return {
            status: "completed",
            result: { ok: true, envelope: doneEnvelope },
          };
        },
        deliverAnswer: vi.fn(),
        async close() {},
      };
    },
  );
}

function recordingAgent(
  behavior: Parameters<typeof scriptedFakeAgent>[0][number],
) {
  const opened: StageRunInput[] = [];
  const inner = scriptedFakeAgent([behavior]);
  return {
    opened,
    agent: {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    },
  };
}

describe("stage worker protocol", () => {
  it.each([
    {
      name: "succeeded",
      outcome: {
        ok: true,
        envelope: { status: "success", summary: "x", artifacts: [] },
      } as const,
      exitCode: STAGE_WORKER_EXIT.SUCCEEDED,
      message: { type: "succeeded" },
    },
    {
      name: "failed",
      outcome: { ok: false, reason: "boom" } as const,
      exitCode: STAGE_WORKER_EXIT.FAILED,
      message: { type: "failed", reason: "boom" },
    },
    {
      name: "waiting",
      outcome: { waiting: true } as const,
      exitCode: STAGE_WORKER_EXIT.WAITING,
      message: { type: "waiting" },
    },
  ])("maps a $name outcome to its exit code and IPC result", async ({ outcome, exitCode, message }) => {
    expect(await exitForOutcome(outcome)).toBe(exitCode);
    expect(outcomeToWorkerResult(outcome)).toEqual(message);
  });

  it("waits for process.send callback before returning", async () => {
    let resolveSend: ((err?: Error | null) => void) | undefined;
    const sendImpl = ((_msg: unknown, cb?: (error: Error | null) => void) => {
      if (typeof cb === "function") {
        resolveSend = cb;
      }
      return true;
    }) as typeof process.send;
    const previousSend = process.send;
    Object.defineProperty(process, "send", {
      configurable: true,
      writable: true,
      value: sendImpl,
    });

    try {
      let settled: number | undefined;
      const pending = exitForOutcome({ ok: false, reason: "diag" }).then((code) => {
        settled = code;
      });
      await Promise.resolve();
      expect(settled).toBeUndefined();
      expect(resolveSend).toBeTypeOf("function");
      resolveSend?.(null);
      await pending;
      expect(settled).toBe(STAGE_WORKER_EXIT.FAILED);
    } finally {
      if (previousSend === undefined) {
        delete (process as { send?: typeof process.send }).send;
      } else {
        Object.defineProperty(process, "send", {
          configurable: true,
          writable: true,
          value: previousSend,
        });
      }
    }
  });

  it("scheduleExitWithDrain sets exitCode and force-exits after the safety net", () => {
    vi.useFakeTimers();
    const prev = process.exitCode;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      scheduleExitWithDrain(2);
      expect(process.exitCode).toBe(2);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PROCESS_EXIT_FORCE_MS);
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      process.exitCode = prev;
      exit.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("stage worker feedback session modes", () => {
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-worker-fb-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it.each([
    { mode: "feedback_resume", withFeedbackLoop: true },
    { mode: "new_session", withFeedbackLoop: false },
  ] as const)(
    "$mode opens with sessionMode on the requested attempt",
    async ({ mode, withFeedbackLoop }) => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-worker-fb-mode-"));
      await writeStageYaml(root, "work");
      const pipelineFile = await writePipelineYaml(root, "solo", "solo", [
        "  - id: work",
        "    uses: ../stages/work.yaml",
      ]);
      const store = createRunStore({ rootDir: globalStageflowHome() });
      const run = await store.createRun({
        pipelineId: "solo",
        pipelinePath: pipelineFile,
        taskYaml: "id: t\ngoal: g\n",
        taskId: "t",
      });
      await store.ensureStageWorkspace(run.runId, "work");
      await store.createStageExecution(run.runId, "work");
      if (withFeedbackLoop) {
        await store.createFeedbackLoop(run.runId, {
          loop_id: "loop-1",
          source_stage_id: "work",
          source_attempt: 1,
          policy: {
            target: "work",
            max_replays: 2,
            on_max_replays: "require_continue",
            replay_session: "resume",
          },
        });
        await store.createFeedbackReplay(run.runId, {
          replay_id: "replay-1",
          loop_id: "loop-1",
          source_stage_id: "work",
          source_attempt: 1,
          target_stage_id: "work",
          replay_number: 1,
          max_replays: 2,
          replay_session: "resume",
          route_stage_ids: ["work"],
          feedback_envelope: {
            status: "success",
            summary: "send back",
            artifacts: [],
            feedback_loop: { action: "send_back", target: "work" },
          },
          status: "active",
        });
      }
      await store.createStageExecution(run.runId, "work");
      if (withFeedbackLoop) {
        await store.createFeedbackReplayStagePass(run.runId, {
          replay_id: "replay-1",
          stage_id: "work",
          stage_attempt: 2,
          session_mode: "resume",
        });
        await store.updateFeedbackLoop(run.runId, "loop-1", {
          current_replay_id: "replay-1",
          current_replay_number: 1,
        });
      }

      const opened: StageRunInput[] = [];
      mockPiOpenStage((input) => opened.push(input));

      const outcome = await runStageWorker({
        runId: run.runId,
        stageId: "work",
        rootDir: root,
        mode,
        attempt: 2,
      });

      expect(outcome).toMatchObject({ ok: true });
      expect(opened.map((i) => i.sessionMode)).toEqual([mode]);
      expect(opened.map((i) => i.feedbackLoopContext?.loop_id)).toEqual([
        withFeedbackLoop ? "loop-1" : undefined,
      ]);
      const events = await store.listStageEvents(run.runId, "work", 2);
      expect(events.some((e) => e.event === "started")).toBe(true);
      const execution = await store.getLatestStageExecution(run.runId, "work");
      expect(execution?.attempt).toBe(2);
      expect(execution?.status).toBe("succeeded");
    },
  );
});

describe("stage worker reload — inline pipeline run", () => {
  // Regression test: a stage worker (this is exactly what `sf internal
  // run-stage` runs — the real subprocess spawned per stage attempt in the
  // default STAGEFLOW_STAGE_EXECUTION=process mode) has no memory of the
  // parent process's in-memory pipeline object. It reloads everything from
  // the store via loadRunContext -> reloadPipelineForRun, which used to
  // require a stored pipeline_path unconditionally — but an inline pipeline
  // (used by MCP start_run's inline-pipeline path and by run_stage, which is
  // ALWAYS inline) never gets one, so this reload always threw "missing
  // pipeline_path" for any inline-pipeline run in real (non-test) process
  // mode. `env.VITEST === "true"` auto-forces in-process execution
  // (src/runtime/stageConcurrency.ts), so no test ever exercised this real
  // worker-subprocess reload path for an inline pipeline before this test —
  // calling runStageWorker directly here (as the pre-existing tests above
  // do) exercises that exact reload path regardless.
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-worker-inline-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("reloads and runs a stage from an inline pipeline with no pipeline_path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-inline-"));
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "standalone-check",
      // No pipelinePath — this is what an inline pipeline run looks like.
      inlinePipeline: {
        id: "standalone-check",
        stages: [
          {
            id: "check",
            system_prompt: "x",
            model: "anthropic/claude-sonnet-4-5",
            io: {
              input: { schema: { type: "object" } },
              output: { schema: { type: "object" } },
            },
          },
        ],
      },
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.ensureStageWorkspace(run.runId, "check");
    await store.createStageExecution(run.runId, "check");

    mockPiOpenStage();

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "check",
      rootDir: root,
      mode: "run",
    });

    expect(outcome).toMatchObject({ ok: true });
    const execution = await store.getLatestStageExecution(run.runId, "check");
    expect(execution?.status).toBe("succeeded");
  });

  it("still throws a clear error when a run has neither pipeline_path nor an inline pipeline (defensive/legacy path)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-inline-broken-"));
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "broken",
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.ensureStageWorkspace(run.runId, "check");
    await store.createStageExecution(run.runId, "check");

    await expect(
      runStageWorker({
        runId: run.runId,
        stageId: "check",
        rootDir: root,
        mode: "run",
      }),
    ).rejects.toThrow(/missing pipeline_path/);
  });
});

describe("runStage workerMode", () => {
  it("returns waiting without HITL controller", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: {
          status: "success",
          summary: "done",
          artifacts: [],
        },
      },
    ]);

    const outcome = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
      workerMode: true,
    });

    expect(outcome).toEqual({ waiting: true });
    const events = await store.listStageEvents(run.runId, "clarify");
    expect(events.some((e) => e.event === "waiting_for_input")).toBe(true);
    expect(events.some((e) => e.event === "succeeded")).toBe(false);
  });

  it("worker resume parks a later wait instead of failing without HITL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-resume-wait-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const stage = {
      id: "work",
      system_prompt: "x",
      model: "anthropic/claude-sonnet-4-5",
    };
    const task = { id: "t", goal: "g" };
    const twoWaits = {
      type: "wait_then_emit" as const,
      waitRequests: ["first", "second"],
      envelope: { status: "success", summary: "done", artifacts: [] },
    };

    const parked = await runStage({
      agent: scriptedFakeAgent([twoWaits]),
      store,
      runId: run.runId,
      stage,
      stageId: "work~2",
      task,
      priorEnvelope: null,
      workerMode: true,
    });
    expect(parked).toEqual({ waiting: true });

    const resumeAgent = new FakeAgent(twoWaits);
    const handle = resumeAgent.openStage({
      roots: buildStageRoots(store.getWorkspaceDir(run.runId), "work~2"),
      stage,
      stageId: "work~2",
      task,
      priorEnvelope: null,
    });
    handle.deliverAnswer("ok");
    const resumed = await runStage({
      agent: resumeAgent,
      store,
      runId: run.runId,
      stage,
      stageId: "work~2",
      task,
      priorEnvelope: null,
      skipStarted: true,
      existingHandle: handle,
      workerMode: true,
    });
    expect(resumed).toEqual({ waiting: true });
    const events = await store.listStageEvents(run.runId, "work~2");
    expect(events.filter((e) => e.event === "waiting_for_input").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.event === "failed")).toBe(false);
  });
});

describe("operator catalog roots", () => {
  const previousHome = process.env.HOME;
  let factoryCwd: string;
  let operatorAgentDir: string;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "sf-op-home-"));
    factoryCwd = await mkdtemp(path.join(tmpdir(), "sf-op-cwd-"));
    operatorAgentDir = path.join(home, ".pi", "agent");
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("passes the resolved filePath on in-process runStage", async () => {
    const filePath = await writeSkill(
      path.join(operatorAgentDir, "skills"),
      "operator-fixture",
      "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
    );
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-run-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const { opened, agent } = recordingAgent({
      type: "emit",
      envelope: doneEnvelope,
    });

    const outcome = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
        skill: "operator-fixture",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
      factoryCwd,
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.skillFilePath).toBe(filePath);
  });

  it.each([
    { name: "present", skillInCatalog: true },
    { name: "missing", skillInCatalog: false },
  ])(
    "reconstruct with the catalog pair: named skill $name",
    async ({ skillInCatalog }) => {
      const skillName = skillInCatalog ? "operator-fixture" : "missing-skill";
      const filePath = await writeSkill(
        path.join(operatorAgentDir, "skills"),
        "operator-fixture",
        "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
      );
      const root = await mkdtemp(path.join(tmpdir(), "sf-op-recon-"));
      const pipelineFile = await writeNamedSkillPipeline(root, skillName);
      const store = createRunStore({ rootDir: root });
      const run = await store.createRun({
        pipelineId: "named-skill",
        pipelinePath: pipelineFile,
        taskYaml: "id: t\ngoal: g\n",
        taskId: "t",
      });
      await store.ensureStageWorkspace(run.runId, "named-stage");
      await store.appendStageEvent(run.runId, "named-stage", { event: "started" });
      const resumePath = fakeHitlResumePath(
        buildStageRoots(run.workspaceDir, "named-stage"),
        "named-stage",
      );
      await writeFile(
        resumePath,
        `${JSON.stringify({
          waitRequests: ["need-input"],
          envelope: doneEnvelope,
          waitIndex: 1,
        })}\n`,
        "utf8",
      );
      await store.appendStageEvent(run.runId, "named-stage", {
        event: "waiting_for_input",
      });

      const { opened, agent } = recordingAgent({
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: doneEnvelope,
      });
      const hitl = new StageHitlController({ store });

      const outcome = await reconstructAndContinue({
        runId: run.runId,
        stageId: "named-stage",
        opaqueAnswer: "direct-resume",
        agent,
        store,
        hitl,
        executionMode: "inprocess",
        cwd: root,
        maxActiveStagesPerRun: 4,
        operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
      });

      if (skillInCatalog) {
        expect(outcome.ok).toBe(true);
        expect(opened).toHaveLength(1);
        expect(opened[0]?.skillFilePath).toBe(filePath);
      } else {
        expect(outcome).toEqual({
          ok: false,
          reason: expect.stringContaining("missing-skill"),
        });
        expect(opened).toHaveLength(0);
      }
    },
  );

  it("worker resume fails before open when the named skill is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-worker-miss-"));
    const pipelineFile = await writeNamedSkillPipeline(root, "missing-skill");
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "named-skill",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.ensureStageWorkspace(run.runId, "named-stage");

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "named-stage",
      rootDir: root,
      mode: "resume",
      resumeAnswer: "ok",
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringContaining("missing-skill"),
    });
  });
});

describe("stage worker prior StageEnvelope", () => {
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-worker-prior-home-"));
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("fails closed with envelopeRouting reason when upstream envelope is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-prior-"));
    await writeStageYaml(root, "parent-stage");
    await writeStageYaml(root, "child-stage");
    const pipelineFile = await writePipelineYaml(root, "needs-parent", "needs-parent", [
      "  - id: parent-stage",
      "    uses: ../stages/parent-stage.yaml",
      "    entry: true",
      "    route:",
      "      - to: child-stage",
      "  - id: child-stage",
      "    uses: ../stages/child-stage.yaml",
    ]);
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: "needs-parent",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "child-stage",
      rootDir: root,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'missing envelope for upstream stage "parent-stage"',
    });
  });
});

describe("clone instance definition lookup", () => {
  const previousHome = process.env.HOME;

  beforeEach(async () => {
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "sf-worker-clone-home-"));
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  async function writeAuthorDiagramsPipeline(root: string): Promise<string> {
    await writeStageYaml(root, "detect");
    await writeStageYaml(root, "author-diagrams");
    return writePipelineYaml(root, "author-diagrams", "author-diagrams-pipe", [
      "  - id: detect",
      "    uses: ../stages/detect.yaml",
      "    entry: true",
      "    route:",
      "      - to: author-diagrams",
      "  - id: author-diagrams",
      "    uses: ../stages/author-diagrams.yaml",
    ]);
  }

  it("AE4: worker loads StageConfig via definition_id for author-diagrams~2", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-def-"));
    const pipelineFile = await writeAuthorDiagramsPipeline(root);
    const loaded = await loadPipeline(pipelineFile);
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: snapshot,
    });

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "author-diagrams~2",
      rootDir: root,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'missing envelope for upstream stage "detect"',
    });
  });

  it("does not recover catalog id by parsing tilde when the DAG node is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-tilde-"));
    const pipelineFile = await writeAuthorDiagramsPipeline(root);
    const loaded = await loadPipeline(pipelineFile);
    const store = createRunStore({ rootDir: globalStageflowHome() });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
    });

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "author-diagrams~2",
      rootDir: root,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringMatching(/not in pipeline/),
    });
  });

  it("reconstructAndContinue opens the instance with its definition StageConfig", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-recon-def-"));
    const pipelineFile = await writeAuthorDiagramsPipeline(root);
    const loaded = await loadPipeline(pipelineFile);
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "author-diagrams",
      predecessorId: "detect",
      count: 2,
    });
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
      pipelineDag: snapshot,
    });
    await store.createStageExecution(run.runId, "detect");
    await store.appendStageEvent(run.runId, "detect", { event: "started" });
    await store.writeEnvelope(run.runId, "detect", {
      ...doneEnvelope,
      payload: {},
    });
    await store.appendStageEvent(run.runId, "detect", { event: "succeeded" });
    await store.ensureStageWorkspace(run.runId, "author-diagrams~2");
    await store.appendStageEvent(run.runId, "author-diagrams~2", {
      event: "started",
    });
    await writeFile(
      fakeHitlResumePath(
        buildStageRoots(run.workspaceDir, "author-diagrams~2"),
        "author-diagrams~2",
      ),
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: doneEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "author-diagrams~2", {
      event: "waiting_for_input",
    });
    const { opened, agent } = recordingAgent({
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: doneEnvelope,
    });
    const hitl = new StageHitlController({ store });
    await reconstructAndContinue({
      runId: run.runId,
      stageId: "author-diagrams~2",
      opaqueAnswer: "ok",
      agent,
      store,
      hitl,
      executionMode: "inprocess",
      cwd: root,
      maxActiveStagesPerRun: 4,
    });

    // The first open is the resumed instance; later opens are scheduler follow-ups.
    expect(opened[0]?.stage.id).toBe("author-diagrams");
    expect(opened[0]?.stageId).toBe("author-diagrams~2");
  });

  it("runStage keys store events by instance stageId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-runstage-inst-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);

    const outcome = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "author-diagrams",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      stageId: "author-diagrams~1",
      task: { id: "t", goal: "g" },
      workerMode: true,
    });

    expect(outcome).toEqual({ waiting: true });
    const instanceEvents = await store.listStageEvents(
      run.runId,
      "author-diagrams~1",
    );
    expect(instanceEvents.some((e) => e.event === "waiting_for_input")).toBe(
      true,
    );
    expect(await store.listStageEvents(run.runId, "author-diagrams")).toEqual(
      [],
    );
  });
});

