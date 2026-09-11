import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter } from "../src/agent/piAdapter.js";
import { FakeAgent, fakeHitlResumePath, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageHandle, StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import { reconstructAndContinue } from "../src/runtime/resumeReconstruct.js";
import { StageHitlController } from "../src/runtime/stageHitl.js";
import { bindPiAgentDirEnv, buildStageRoots } from "../src/runtime/stageRoots.js";
import { runStage } from "../src/runtime/stageRunner.js";
import { openStageAttempt } from "../src/runtime/stageAttemptBootstrap.js";
import { exitForOutcome, runStageWorker } from "../src/runtime/stageWorker.js";
import {
  outcomeToWorkerResult,
  STAGE_WORKER_EXIT,
} from "../src/runtime/stageWorkerProtocol.js";
import { parseRunStageArgs } from "../src/cli.js";

async function writeSkill(dir: string, name: string, body: string): Promise<string> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  await writeFile(filePath, body, "utf8");
  return filePath;
}

async function writeNamedSkillPipeline(
  root: string,
  skillName: string,
): Promise<string> {
  const pipelinePath = path.join(root, "pipelines", "named-skill.pipeline.yaml");
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await writeFile(
    pipelinePath,
    [
      "id: named-skill",
      "stages:",
      "  - id: named-stage",
      "    uses: ../stages/named-stage.yaml",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "stages", "named-stage.yaml"),
    [
      "id: named-stage",
      "system_prompt: x",
      "model: anthropic/claude-sonnet-4-5",
      `skill: ${skillName}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return pipelinePath;
}

describe("stage worker protocol", () => {
  it("maps outcomes to exit codes", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    expect(() =>
      exitForOutcome({ ok: true, envelope: { status: "success", summary: "x", artifacts: [] } }),
    ).toThrow("exit");
    expect(exit).toHaveBeenLastCalledWith(STAGE_WORKER_EXIT.SUCCEEDED);

    exit.mockClear();
    expect(() => exitForOutcome({ ok: false, reason: "boom" })).toThrow("exit");
    expect(exit).toHaveBeenLastCalledWith(STAGE_WORKER_EXIT.FAILED);

    exit.mockClear();
    expect(() => exitForOutcome({ waiting: true })).toThrow("exit");
    expect(exit).toHaveBeenLastCalledWith(STAGE_WORKER_EXIT.WAITING);

    exit.mockRestore();
  });

  it("maps outcomes to IPC result messages", () => {
    expect(outcomeToWorkerResult({ waiting: true })).toEqual({ type: "waiting" });
    expect(
      outcomeToWorkerResult({
        ok: true,
        envelope: { status: "success", summary: "x", artifacts: [] },
      }),
    ).toEqual({ type: "succeeded" });
    expect(outcomeToWorkerResult({ ok: false, reason: "nope" })).toEqual({
      type: "failed",
      reason: "nope",
    });
  });

  it("does not import Pi session repair", async () => {
    const src = await readFile(
      new URL("../src/runtime/stageWorker.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("repairPrematureAskOperatorClosure");
  });

  it("parseRunStageArgs accepts feedback_resume and new_session modes", () => {
    expect(
      parseRunStageArgs([
        "--run-id",
        "r1",
        "--stage-id",
        "s1",
        "--mode",
        "feedback_resume",
      ]).mode,
    ).toBe("feedback_resume");
    expect(
      parseRunStageArgs([
        "--run-id",
        "r1",
        "--stage-id",
        "s1",
        "--mode",
        "new_session",
      ]).mode,
    ).toBe("new_session");
  });
});

describe("stage worker feedback session modes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function writeSingleStagePipeline(root: string): Promise<string> {
    await mkdir(path.join(root, "pipelines"), { recursive: true });
    await mkdir(path.join(root, "stages"), { recursive: true });
    const pipelineFile = path.join(root, "pipelines", "solo.pipeline.yaml");
    await writeFile(
      pipelineFile,
      [
        "id: solo",
        "stages:",
        "  - id: work",
        "    uses: ../stages/work.yaml",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "stages", "work.yaml"),
      [
        "id: work",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "utf8",
    );
    return pipelineFile;
  }

  it("feedback_resume opens with sessionMode and does not call deliverAnswer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-fb-resume-"));
    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.ensureStageWorkspace(run.runId, "work");
    await store.createStageExecution(run.runId, "work");
    const policy = {
      target: "work",
      max_replays: 2,
      on_max_replays: "require_continue" as const,
      replay_session: "resume" as const,
    };
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "work",
      source_attempt: 1,
      policy,
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
    await store.createStageExecution(run.runId, "work");
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

    const deliverAnswer = vi.fn();
    const openedModes: Array<string | undefined> = [];
    const openedContexts: Array<string | undefined> = [];
    vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation(
      (input: StageRunInput): StageHandle => {
        openedModes.push(input.sessionMode);
        openedContexts.push(input.feedbackLoopContext?.loop_id);
        return {
          stageId: input.stageId ?? input.stage.id,
          async next() {
            return {
              status: "completed",
              result: {
                ok: true,
                envelope: { status: "success", summary: "done", artifacts: [] },
              },
            };
          },
          deliverAnswer,
          async close() {},
        };
      },
    );

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "work",
      rootDir: root,
      mode: "feedback_resume",
      attempt: 2,
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(openedModes).toEqual(["feedback_resume"]);
    expect(openedContexts).toEqual(["loop-1"]);
    expect(deliverAnswer).not.toHaveBeenCalled();
    const events = await store.listStageEvents(run.runId, "work", 2);
    expect(events.some((e) => e.event === "started")).toBe(true);
    const execution = await store.getLatestStageExecution(run.runId, "work");
    expect(execution?.attempt).toBe(2);
    expect(execution?.status).toBe("succeeded");
  });

  it("new_session opens with sessionMode and does not call deliverAnswer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-new-session-"));
    const pipelineFile = await writeSingleStagePipeline(root);
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "solo",
      pipelinePath: pipelineFile,
      taskYaml: "id: t\ngoal: g\n",
      taskId: "t",
    });
    await store.ensureStageWorkspace(run.runId, "work");
    await store.createStageExecution(run.runId, "work");
    await store.createStageExecution(run.runId, "work");

    const deliverAnswer = vi.fn();
    const openedModes: Array<string | undefined> = [];
    vi.spyOn(PiAgentAdapter.prototype, "openStage").mockImplementation(
      (input: StageRunInput): StageHandle => {
        openedModes.push(input.sessionMode);
        return {
          stageId: input.stageId ?? input.stage.id,
          async next() {
            return {
              status: "completed",
              result: {
                ok: true,
                envelope: { status: "success", summary: "done", artifacts: [] },
              },
            };
          },
          deliverAnswer,
          async close() {},
        };
      },
    );

    const outcome = await runStageWorker({
      runId: run.runId,
      stageId: "work",
      rootDir: root,
      mode: "new_session",
      attempt: 2,
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(openedModes).toEqual(["new_session"]);
    expect(deliverAnswer).not.toHaveBeenCalled();
    const events = await store.listStageEvents(run.runId, "work", 2);
    expect(events.some((e) => e.event === "started")).toBe(true);
  });

  it("FakeAgent feedback_resume skips HITL park and emits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fake-fb-resume-"));
    const roots = buildStageRoots(root, "work");
    const parkPath = fakeHitlResumePath(roots, "work");
    await mkdir(path.dirname(parkPath), { recursive: true });
    await writeFile(
      parkPath,
      JSON.stringify({
        waitRequests: ["stale"],
        envelope: { status: "success", summary: "parked", artifacts: [] },
        waitIndex: 1,
      }),
      "utf8",
    );

    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["would-wait"],
      envelope: { status: "success", summary: "replayed", artifacts: [] },
    });
    const result = await agent.runStage({
      roots,
      stage: {
        id: "work",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
      sessionMode: "feedback_resume",
      feedbackLoopContext: {
        loop_id: "loop-1",
        replay_id: "replay-1",
        source_stage_id: "review",
        target_stage_id: "work",
        feedback_envelope: {
          status: "success",
          summary: "again",
          artifacts: [],
        },
        replay_number: 1,
        max_replays: 2,
        remaining_replays: 1,
        is_final_replay: false,
        replay_session: "resume",
        route_stage_ids: ["work", "review"],
      },
    });
    expect(result).toEqual({
      ok: true,
      envelope: { status: "success", summary: "replayed", artifacts: [] },
    });
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

  it("resolves a fixture under the operator agent dir after bind", async () => {
    const filePath = await writeSkill(
      path.join(operatorAgentDir, "skills"),
      "operator-fixture",
      "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
    );
    const attemptAgentDir = await mkdtemp(path.join(tmpdir(), "sf-attempt-agent-"));
    const unbind = bindPiAgentDirEnv(attemptAgentDir);
    try {
      expect(getAgentDir()).toBe(attemptAgentDir);
      const opened: StageRunInput[] = [];
      const inner = scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "done", artifacts: [] },
        },
      ]);
      const agent = {
        ...inner,
        openStage(input: StageRunInput) {
          opened.push(input);
          return inner.openStage(input);
        },
      };
      const store = createRunStore({ rootDir: factoryCwd });
      const run = await store.createRun({
        pipelineId: "docs-only",
        taskYaml: "id: t\ngoal: g\n",
      });
      const result = await openStageAttempt({
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
        dag: {
          nodes: [
            { id: "clarify", needs: null, ancestors: [], stageIndex: 0 },
          ],
          roots: ["clarify"],
          childrenOf: {},
        },
        workspaceDir: run.workspaceDir,
        factoryCwd,
        operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
        roots: buildStageRoots(factoryCwd, "clarify"),
      });
      expect(result.ok).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.skillFilePath).toBe(filePath);
    } finally {
      unbind();
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
    const opened: StageRunInput[] = [];
    const inner = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);
    const agent = {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    };

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

  it("fails before openStage when the named skill is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-miss-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const opened: StageRunInput[] = [];
    const inner = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);
    const agent = {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    };

    const outcome = await runStage({
      agent,
      store,
      runId: run.runId,
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
        skill: "missing-skill",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
      factoryCwd,
      operatorCatalog: { cwd: factoryCwd, agentDir: operatorAgentDir },
    });

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringContaining("missing-skill"),
    });
    expect(opened).toHaveLength(0);
  });

  it("does not rediscover via getAgentDir when operator dir is omitted", async () => {
    await writeSkill(
      path.join(operatorAgentDir, "skills"),
      "operator-fixture",
      "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
    );
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-omit-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const opened: StageRunInput[] = [];
    const inner = scriptedFakeAgent([
      {
        type: "emit",
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);
    const agent = {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    };

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
    });

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringContaining("operator-fixture"),
    });
    expect(opened).toHaveLength(0);
  });

  it("reconstruct opens a named-skill Stage through the catalog pair", async () => {
    const filePath = await writeSkill(
      path.join(operatorAgentDir, "skills"),
      "operator-fixture",
      "---\nname: operator-fixture\ndescription: Operator catalog fixture.\n---\n# Operator\n",
    );
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-recon-"));
    const pipelineFile = await writeNamedSkillPipeline(root, "operator-fixture");
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
        envelope: { status: "success", summary: "done", artifacts: [] },
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "named-stage", {
      event: "waiting_for_input",
    });

    const opened: StageRunInput[] = [];
    const inner = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);
    const agent = {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    };
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

    expect(outcome.ok).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.skillFilePath).toBe(filePath);
  });

  it("reconstruct fails before openStage when the named skill is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-recon-miss-"));
    const pipelineFile = await writeNamedSkillPipeline(root, "missing-skill");
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
        envelope: { status: "success", summary: "done", artifacts: [] },
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "named-stage", {
      event: "waiting_for_input",
    });

    const opened: StageRunInput[] = [];
    const inner = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: { status: "success", summary: "done", artifacts: [] },
      },
    ]);
    const agent = {
      ...inner,
      openStage(input: StageRunInput) {
        opened.push(input);
        return inner.openStage(input);
      },
    };
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

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringContaining("missing-skill"),
    });
    expect(opened).toHaveLength(0);
  });

  it("worker resume fails before open when the named skill is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-op-worker-miss-"));
    const pipelineFile = await writeNamedSkillPipeline(root, "missing-skill");
    const store = createRunStore({ rootDir: root });
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
  it("fails closed with envelopeRouting reason when upstream envelope is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-prior-"));
    await mkdir(path.join(root, "pipelines"), { recursive: true });
    await mkdir(path.join(root, "stages"), { recursive: true });
    const pipelineFile = path.join(root, "pipelines", "needs-parent.pipeline.yaml");
    await writeFile(
      pipelineFile,
      [
        "id: needs-parent",
        "stages:",
        "  - id: parent-stage",
        "    uses: ../stages/parent-stage.yaml",
        "    entry: true",
        "    route:",
        "      - to: child-stage",
        "  - id: child-stage",
        "    uses: ../stages/child-stage.yaml",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "stages", "parent-stage.yaml"),
      [
        "id: parent-stage",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "stages", "child-stage.yaml"),
      [
        "id: child-stage",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "utf8",
    );
    const store = createRunStore({ rootDir: root });
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
  async function writeAuthorDiagramsPipeline(root: string): Promise<string> {
    await mkdir(path.join(root, "pipelines"), { recursive: true });
    await mkdir(path.join(root, "stages"), { recursive: true });
    const pipelineFile = path.join(
      root,
      "pipelines",
      "author-diagrams.pipeline.yaml",
    );
    await writeFile(
      pipelineFile,
      [
        "id: author-diagrams-pipe",
        "stages:",
        "  - id: detect",
        "    uses: ../stages/detect.yaml",
        "    entry: true",
        "    route:",
        "      - to: author-diagrams",
        "  - id: author-diagrams",
        "    uses: ../stages/author-diagrams.yaml",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "stages", "detect.yaml"),
      [
        "id: detect",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, "stages", "author-diagrams.yaml"),
      [
        "id: author-diagrams",
        "system_prompt: x",
        "model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "utf8",
    );
    return pipelineFile;
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
    const store = createRunStore({ rootDir: root });
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

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({
      reason: expect.not.stringMatching(/not in pipeline/),
    });
    expect(outcome).toMatchObject({
      reason: expect.stringMatching(/missing envelope for upstream stage "detect"/),
    });
  });

  it("does not recover catalog id by parsing tilde when the DAG node is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-worker-tilde-"));
    const pipelineFile = await writeAuthorDiagramsPipeline(root);
    const loaded = await loadPipeline(pipelineFile);
    const store = createRunStore({ rootDir: root });
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

  it("reconstructAndContinue looks up config by definition_id", async () => {
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
    const hitl = new StageHitlController({ store });
    const outcome = await reconstructAndContinue({
      runId: run.runId,
      stageId: "author-diagrams~2",
      opaqueAnswer: "ok",
      agent: scriptedFakeAgent([
        {
          type: "emit",
          envelope: { status: "success", summary: "done", artifacts: [] },
        },
      ]),
      store,
      hitl,
      executionMode: "inprocess",
      cwd: root,
      maxActiveStagesPerRun: 4,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).not.toMatch(/not in pipeline/);
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

