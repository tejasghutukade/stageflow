import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createCompletedOnlyStageHandle } from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";

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

describe("run manager inline task", () => {
  it("starts a run from an inline TaskFile without a tasks/ path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-inline-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
      successEnvelope("3"),
    ]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: {
        id: "inline-demo",
        goal: "prove inline task start",
        context: "from test",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const yaml = await store.readTaskYaml(result.runId);
    const task = loadTaskFromYaml(yaml);
    expect(task.id).toBe("inline-demo");
    expect(task.goal).toBe("prove inline task start");
    expect(task.context).toBe("from test");

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("still accepts a task path string", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-path-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      successEnvelope("1"),
      successEnvelope("2"),
      successEnvelope("3"),
    ]);
    const manager = new RunManager({ agent, cwd: fixtures, store });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: "tasks/sample.task.yaml",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("rejects an invalid task object with 400", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-bad-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      cwd: fixtures,
      store,
    });

    const result = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: 1, goal: "x" } as unknown as { id: string; goal: string },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("reserves a soft-max slot before startPipeline awaits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-race-"));
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

    const firstPromise = manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getActiveCount()).toBeGreaterThan(0);

    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "b", goal: "second" },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe("busy_capacity");
    }

    const first = await firstPromise;
    expect(first.ok).toBe(true);
    release();
    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
