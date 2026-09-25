import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { writeTerminalRunStatus } from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import { OPERATOR_CANCEL_REASON } from "../src/runtime/stageRecovery.js";
import {
  pipelinePath,
  SAMPLE_TASK,
} from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function hangingAgent(): AgentPort {
  return {
    openStage(_input: StageRunInput) {
      return {
        async next() {
          await new Promise<void>(() => {});
          throw new Error("unreachable");
        },
        async close() {},
      };
    },
    async runStage() {
      await new Promise<void>(() => {});
      throw new Error("unreachable");
    },
  };
}

function reconcileAgent(): AgentPort {
  return {
    openStage(input) {
      return createCompletedOnlyStageHandle({
        stageId: input.stage.id,
        run: async () => ({
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
            payload: {},
          },
        }),
      });
    },
    async runStage() {
      return {
        ok: true as const,
        envelope: {
          status: "success" as const,
          summary: "ok",
          artifacts: [],
          payload: {},
        },
      };
    },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

describe("runtime cancelRun", () => {
  it("cancels a running run with a live stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-live-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: hangingAgent(),
      store,
      cwd: fixtures,
    });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("single"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return detail.stages.some((s) => s.status === "running");
    });

    expect(manager.getActiveRunIds()).toContain(started.runId);

    const result = await manager.cancelRun(started.runId, "operator stop");
    expect(result).toEqual({ ok: true, runId: started.runId });

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("cancelled");
    expect(detail.cancel_reason).toBe("operator stop");
    const stage = detail.stages.find((s) => s.stage_id === "clarify");
    expect(stage?.status).toBe("failed");
    const events = await store.listStageEvents(started.runId, "clarify");
    expect(events.find((e) => e.event === "failed")?.reason).toBe(
      OPERATOR_CANCEL_REASON,
    );
    expect(manager.getActiveRunIds()).not.toContain(started.runId);
  });

  it("signals StageProcessLauncher.cancelRun for live workers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-launcher-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const mockLauncher = {
      getActiveStageProcesses: () => [
        { runId: run.runId, stageId: "build", startedAt: Date.now() },
      ],
      cancelRun,
      launch: vi.fn(),
      activeCount: () => 1,
    } as unknown as StageProcessLauncher;

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });

    const result = await manager.cancelRun(run.runId, "kill workers");
    expect(result.ok).toBe(true);
    expect(cancelRun).toHaveBeenCalledWith(run.runId);
  });

  it("cancels a waiting_for_input stage and clears HITL wait", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-wait-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });

    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });
    await store.updateRunStatus(run.runId, "running");

    const prompt = {
      kind: "free_text" as const,
      id: "prompt-1",
      message: "name?",
    };
    const waitPromise = manager
      .getHitlController()
      .enterWait(run.runId, "clarify", {
        async next() {
          return {
            status: "completed" as const,
            result: {
              ok: true as const,
              envelope: {
                status: "success" as const,
                summary: "ok",
                artifacts: [],
                payload: {},
              },
            },
          };
        },
        async close() {},
      }, prompt)
      .catch((err: unknown) => err);

    await waitFor(async () =>
      manager.getHitlController().hasLiveWait(run.runId, "clarify"),
    );

    const result = await manager.cancelRun(run.runId, "stop waiting");
    expect(result.ok).toBe(true);

    const cleared = await waitPromise;
    expect(cleared).toBeInstanceOf(Error);
    expect((cleared as Error).message).toMatch(/wait cancelled/i);
    expect(manager.getHitlController().hasLiveWait(run.runId, "clarify")).toBe(
      false,
    );

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("cancelled");
    expect(detail.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "failed",
    );

    const answer = await manager.deliverAnswer(run.runId, "clarify", {
      promptId: "prompt-1",
      kind: "free_text",
      text: "x",
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.status).toBe(409);
  });

  it("is idempotent on already-cancelled runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-idem-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const first = await manager.cancelRun(run.runId, "first");
    expect(first).toEqual({ ok: true, runId: run.runId });

    const eventsAfterFirst = await store.listStageEvents(run.runId, "build");
    const failedCount = eventsAfterFirst.filter((e) => e.event === "failed")
      .length;

    const second = await manager.cancelRun(run.runId, "second");
    expect(second).toEqual({ ok: true, runId: run.runId });

    const eventsAfterSecond = await store.listStageEvents(run.runId, "build");
    expect(eventsAfterSecond.filter((e) => e.event === "failed").length).toBe(
      failedCount,
    );
    const meta = await store.readRunMeta(run.runId);
    expect(meta.cancel_reason).toBe("first");
  });

  it("returns 409 when cancelling a succeeded run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-409-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });

    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "succeeded");

    const result = await manager.cancelRun(run.runId, "too late");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  it("writeTerminalRunStatus refuses to overwrite cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-cancel-sched-"));
    const store = createRunStore({ rootDir: root });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.updateRunStatus(run.runId, "cancelled");
    await store.setCancelReason(run.runId, "already cancelled");

    await writeTerminalRunStatus(store, run.runId, "failed");
    await writeTerminalRunStatus(store, run.runId, "succeeded");

    const meta = await store.readRunMeta(run.runId);
    expect(meta.status).toBe("cancelled");
    expect(meta.cancel_reason).toBe("already cancelled");
  });
});
