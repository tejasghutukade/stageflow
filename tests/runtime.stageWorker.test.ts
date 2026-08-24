import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHitlResumePath, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { StageRunInput } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
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
): Promise<void> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await writeFile(
    path.join(root, "pipelines", "named-skill.yaml"),
    "id: named-skill\nstages:\n  - named-stage\n",
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
    await writeNamedSkillPipeline(root, "operator-fixture");
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "named-skill",
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
    await writeNamedSkillPipeline(root, "missing-skill");
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "named-skill",
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
    await writeNamedSkillPipeline(root, "missing-skill");
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "named-skill",
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
    await writeFile(
      path.join(root, "pipelines", "needs-parent.yaml"),
      "id: needs-parent\nstages:\n  - parent-stage\n  - child-stage\n",
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
