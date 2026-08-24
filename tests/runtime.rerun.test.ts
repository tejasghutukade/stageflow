import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function successEnvelope(summary: string) {
  return {
    type: "emit" as const,
    envelope: {
      status: "success" as const,
      summary,
      artifacts: [],
    },
  };
}

describe("run manager re-run", () => {
  it("re-run creates a new run id with the same task snapshot and pipeline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-"));
    const store = createRunStore({ rootDir: root });
    const sourceTask = "id: snap\ngoal: from copy\n";
    const source = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: sourceTask,
      taskId: "snap",
    });

    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
      successEnvelope("3"),
    ]);

    const manager = new RunManager({
      agent,
      cwd: fixtures,
      store,
    });

    const result = await manager.rerun(source.runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.runId).not.toBe(source.runId);
    const copy = await store.readTaskYaml(result.runId);
    expect(copy).toBe(sourceTask);

    await new Promise((r) => setTimeout(r, 50));
    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("rejects a second UI start when soft max is full", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-busy-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = {
      openStage(input: { stage: { id: string } }) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            await gate;
            return {
              ok: true as const,
              envelope: {
                status: "success" as const,
                summary: "ok",
                artifacts: [],
              },
            };
          },
        });
      },
      async runStage() {
        await gate;
        return {
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
          },
        };
      },
    };

    const manager = new RunManager({
      agent,
      cwd: fixtures,
      store,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      task: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "docs-only",
    });
    expect(first.ok).toBe(true);

    const second = await manager.startRun({
      task: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "docs-only",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe("busy_capacity");
      expect(second.activeCount).toBe(1);
      expect(second.maxConcurrent).toBe(1);
      if (first.ok) {
        expect(second.activeRunIds).toContain(first.runId);
      }
    }

    release();
    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("startPipeline returns runId before stages finish", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-start-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = {
      openStage(input: { stage: { id: string } }) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            await gate;
            return {
              ok: true as const,
              envelope: {
                status: "success" as const,
                summary: "ok",
                artifacts: [],
              },
            };
          },
        });
      },
      async runStage() {
        await gate;
        return {
          ok: true as const,
          envelope: {
            status: "success" as const,
            summary: "ok",
            artifacts: [],
          },
        };
      },
    };

    const started = await startPipeline({
      agent,
      store,
      taskPath: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "docs-only",
      cwd: fixtures,
    });
    expect(started.runId).toBeTruthy();
    release();
    const result = await started.done;
    expect(result.ok).toBe(true);
  });

  it("retry keeps same run id while rerun creates a new run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-rerun-vs-retry-"));
    const store = createRunStore({ rootDir: root });

    function envelope(summary: string, status: "success" | "failure") {
      return { status, summary, artifacts: [] as string[] };
    }

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: envelope("clarify", "success") },
      { type: "emit", envelope: envelope("design-fail", "failure") },
      { type: "emit", envelope: envelope("design-retry", "success") },
      { type: "emit", envelope: envelope("plan", "success") },
    ]);

    const manager = new RunManager({ agent, cwd: fixtures, store });
    const started = await manager.startRun({
      task: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "linear-explicit",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await new Promise((r) => setTimeout(r, 100));
    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const meta = await store.readRunMeta(started.runId);
    expect(meta.status).toBe("failed");

    const retry = await manager.retryStage(started.runId, "design-doc");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.runId).toBe(started.runId);

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const rerun = await manager.rerun(started.runId);
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    expect(rerun.runId).not.toBe(started.runId);

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
