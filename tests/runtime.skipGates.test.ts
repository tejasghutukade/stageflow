import { describe, expect, it, vi } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeAgent, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { resolveStageToolNames } from "../src/agent/piAdapter.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import {
  runStage,
  runStageYieldLoop,
  isRunStageWaiting,
} from "../src/runtime/stageRunner.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageLaunchInput } from "../src/runtime/stageProcessLauncher.js";
import { outcomeToWorkerResult, STAGE_WORKER_EXIT } from "../src/runtime/stageWorkerProtocol.js";
import { exitForOutcome } from "../src/runtime/stageWorker.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const sampleTask = SAMPLE_TASK;

const waitEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

function waitingAgent() {
  return scriptedFakeAgent([
    {
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: waitEnvelope,
    },
  ]);
}

describe("skip-gates yield-loop fail-before-park (U2)", () => {
  it("policy on + waiting_for_input returns ok false with a reason and does not park", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-loop-on-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const agent = new FakeAgent({
      type: "wait_then_emit",
      waitRequests: ["need-input"],
      envelope: waitEnvelope,
    });
    const handle = agent.openStage({
      roots: buildStageRoots(store.getWorkspaceDir(run.runId), "clarify"),
      stage: {
        id: "clarify",
        system_prompt: "x",
        model: "anthropic/claude-sonnet-4-5",
      },
      task: { id: "t", goal: "g" },
      priorEnvelope: null,
    });

    const outcome = await runStageYieldLoop({
      handle,
      runId: run.runId,
      stageId: "clarify",
      workerMode: true,
      store,
      skipGates: true,
    });

    expect(isRunStageWaiting(outcome)).toBe(false);
    expect(outcome).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    if ("reason" in outcome) {
      expect(outcome.reason.length).toBeGreaterThan(0);
      expect(outcome.reason).not.toBe("undefined");
    }
    const events = await store.listStageEvents(run.runId, "clarify");
    expect(events.some((e) => e.event === "waiting_for_input")).toBe(false);
  });

  it("policy off + waiting_for_input still parks in workerMode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-loop-off-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const outcome = await runStage({
      agent: waitingAgent(),
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
  });

  it("runStage with skipGates writes failed and never waiting_for_input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-stage-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    const outcome = await runStage({
      agent: waitingAgent(),
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
      skipGates: true,
    });

    expect(isRunStageWaiting(outcome)).toBe(false);
    expect(outcome).toMatchObject({ ok: false });
    if ("reason" in outcome) {
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
    const events = await store.listStageEvents(run.runId, "clarify");
    expect(events.some((e) => e.event === "waiting_for_input")).toBe(false);
    expect(events.some((e) => e.event === "failed")).toBe(true);
  });

  it("process-mode launch with policy on is launcher failed and listed stage is not waiting", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-skip-gates-proc-"));
    const store = createRunStore({ rootDir: storeRoot });
    const agent = waitingAgent();
    const launch = vi.fn(async (input: StageLaunchInput) => {
      const outcome = await runStage({
        agent,
        store,
        runId: input.runId,
        stage: {
          id: input.stageId,
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
        },
        task: { id: "sample", goal: "g" },
        priorEnvelope: null,
        workerMode: true,
        skipGates: input.skipGates,
      });
      if (isRunStageWaiting(outcome)) return { type: "waiting" as const };
      if ("ok" in outcome && outcome.ok) return { type: "succeeded" as const };
      return {
        type: "failed" as const,
        reason: "reason" in outcome ? outcome.reason : "stage failed",
      };
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncher,
    });
    const started = await manager.startRun({
      task: sampleTask,
      pipeline: pipelinePath("single"),
      skipGates: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = await started.done;
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ skipGates: true }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    const detail = await store.readRun(started.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).not.toBe("waiting_for_input");
    expect(detail.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "failed",
    );
    const events = await store.listStageEvents(started.runId, "clarify");
    expect(events.some((e) => e.event === "waiting_for_input")).toBe(false);
  });

  it("ask_operator remains registered when gate_kinds is omitted", () => {
    expect(resolveStageToolNames("emit_stage_envelope")).toContain(
      "ask_operator",
    );
    expect(
      resolveStageToolNames("emit_stage_envelope", "write_stage_artifact"),
    ).toContain("ask_operator");
  });

  it("ask_operator is omitted when gate_kinds is empty (AE5)", () => {
    expect(
      resolveStageToolNames(
        "emit_stage_envelope",
        undefined,
        "ask_operator",
        [],
      ),
    ).not.toContain("ask_operator");
    expect(
      resolveStageToolNames(
        "emit_stage_envelope",
        "write_stage_artifact",
        "ask_operator",
        [],
      ),
    ).not.toContain("ask_operator");
  });

  it("skip-gates wait maps to worker FAILED exit 1", () => {
    const mapped = outcomeToWorkerResult({
      ok: false,
      reason: "skip-gates: stage requested wait",
    });
    expect(mapped).toEqual({
      type: "failed",
      reason: "skip-gates: stage requested wait",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() =>
      exitForOutcome({ ok: false, reason: "skip-gates: stage requested wait" }),
    ).toThrow("exit");
    expect(exit).toHaveBeenLastCalledWith(STAGE_WORKER_EXIT.FAILED);
    exit.mockRestore();
  });
});
