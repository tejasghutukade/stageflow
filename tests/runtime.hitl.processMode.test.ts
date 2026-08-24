import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendOperatorPrompt } from "../src/hitl/qaTrail.js";
import { createRunStore } from "../src/runstore/createStore.js";
import * as pipelineScheduler from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const okEnvelope = (): StageEnvelope => ({
  status: "success",
  summary: "clarify-ok",
  artifacts: [],
});

const answer = {
  promptId: "q1",
  kind: "free_text" as const,
  text: "approved",
};

async function createWaitingRun(root: string) {
  const store = createRunStore({ rootDir: root });
  const taskYaml = "id: sample\ngoal: process-mode-hitl\n";
  const run = await store.createRun({
    pipelineId: "docs-only",
    taskYaml,
    taskId: "sample",
  });
  await store.ensureStageWorkspace(run.runId, "clarify");
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  await appendOperatorPrompt(store, run.runId, "clarify", {
    kind: "free_text",
    id: "q1",
    message: "Need input?",
  });
  await store.appendStageEvent(run.runId, "clarify", {
    event: "waiting_for_input",
  });
  return { store, run };
}

describe("runtime HITL deliverAnswer process mode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subprocess succeeded calls resumeRun with envelope from store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi
      .spyOn(pipelineScheduler, "resumeRun")
      .mockResolvedValue({
        ok: true,
        runDir: run.workspaceDir,
        runId: run.runId,
      });

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith({
      runId: run.runId,
      stageId: "clarify",
      rootDir: fixtures,
      mode: "resume",
      resumeAnswer: answer,
      attempt: 1,
      sessionFilePath: expect.stringMatching(/stages\/clarify\/attempts\/1\/pi-session\.jsonl$/),
    });
    expect(resumeRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeFromStageId: "clarify",
        initialPrior: envelope,
        executionMode: "process",
        stageProcessLauncher: mockLauncher,
      }),
    );
  });

  it("subprocess waiting returns ok without resumeRun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);

    const launch = vi.fn().mockImplementation(async ({ runId, stageId }) => {
      await store.appendStageEvent(runId, stageId, {
        event: "waiting_for_input",
      });
      return { type: "waiting" };
    });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi.spyOn(pipelineScheduler, "resumeRun");

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "resume",
        resumeAnswer: answer,
      }),
    );
    expect(resumeRunSpy).not.toHaveBeenCalled();

    const detail = await store.readRun(run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
  });

  it("subprocess failed marks run failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-"));
    const { store, run } = await createWaitingRun(root);

    const launch = vi.fn().mockResolvedValue({
      type: "failed",
      reason: "stage worker failed",
    });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;

    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stage worker failed");

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("failed");
  });

  it("resumeInProcess prepared keeps the operator catalog pair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-hitl-process-cat-"));
    const { store, run } = await createWaitingRun(root);
    const envelope = okEnvelope();
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", envelope);

    const launch = vi.fn().mockResolvedValue({ type: "succeeded" });
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const resumeRunSpy = vi
      .spyOn(pipelineScheduler, "resumeRun")
      .mockResolvedValue({
        ok: true,
        runDir: run.workspaceDir,
        runId: run.runId,
      });

    const operatorCatalog = {
      cwd: fixtures,
      agentDir: "/tmp/operator-agent-catalog",
    };
    const manager = new RunManager({
      agent: { openStage: vi.fn(), runStage: vi.fn() },
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
      operatorCatalog,
    });

    const result = await manager.deliverAnswer(run.runId, "clarify", answer);
    expect(result).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "resume",
        operatorCatalog,
      }),
    );
    expect(resumeRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: expect.objectContaining({
          operatorCatalog,
        }),
      }),
    );
  });
});
