import { mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";

const temps: string[] = [];
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

afterEach(() => {
  clearFindProjectRootCacheForTests();
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function gatedAgent(gate: Promise<void>): AgentPort {
  return {
    openStage(input: StageRunInput) {
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
              payload: {},
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
          payload: {},
        },
      };
    },
  };
}

async function plantMiniProject(root: string): Promise<string> {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "stages"), { recursive: true });
  await cp(
    path.join(fixtures, "pipelines", "single.pipeline.yaml"),
    path.join(root, "pipelines", "single.pipeline.yaml"),
  );
  await cp(
    path.join(fixtures, "stages", "clarify.yaml"),
    path.join(root, "stages", "clarify.yaml"),
  );
  await writeFile(path.join(root, ".git"), "");
  return path.join(root, "pipelines", "single.pipeline.yaml");
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

describe("per-project concurrency cap", () => {
  it("rejects second same-root run with scope project when cap is 1", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-per-proj-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([]);
    const manager = new RunManager({
      agent,
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 6,
      maxConcurrentPerProject: 1,
      maxQueued: 0,
    });

    const a = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => { action: string; failure?: { code?: string; scope?: string } };
    }).tryAdmitOrEnqueue(undefined, root);
    expect(a.action).toBe("reserve");

    const b = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => {
        action: string;
        failure?: { code?: string; scope?: string; maxConcurrent?: number };
      };
    }).tryAdmitOrEnqueue(undefined, root);
    expect(b.action).toBe("reject");
    expect(b.failure?.code).toBe("busy_capacity");
    expect(b.failure?.scope).toBe("project");
    expect(b.failure?.maxConcurrent).toBe(1);

    const other = path.join(root, "other");
    const c = (manager as unknown as {
      tryAdmitOrEnqueue: (
        checkoutKey: string | undefined,
        projectRoot?: string,
      ) => { action: string };
    }).tryAdmitOrEnqueue(undefined, other);
    expect(c.action).toBe("reserve");

    const cap = manager.getPerProjectCapacity();
    expect(cap.maxConcurrent).toBe(1);
    expect(cap.projects.some((p) => p.activeCount >= 1)).toBe(true);
  });

  it("drain skips project-capped queue head and still starts other project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-per-proj-drain-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const rootA = path.join(root, "proj-a");
    const rootB = path.join(root, "proj-b");
    const rootH1 = path.join(root, "proj-h1");
    const rootH2 = path.join(root, "proj-h2");
    const pipelineA = await plantMiniProject(rootA);
    const pipelineB = await plantMiniProject(rootB);
    const pipelineH1 = await plantMiniProject(rootH1);
    const pipelineH2 = await plantMiniProject(rootH2);

    let releaseH1!: () => void;
    const h1Gate = new Promise<void>((resolve) => {
      releaseH1 = resolve;
    });
    let releaseH2!: () => void;
    const h2Gate = new Promise<void>((resolve) => {
      releaseH2 = resolve;
    });
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const manager = new RunManager({
      agent: {
        openStage(input) {
          const goal = input.task.goal;
          const gate =
            goal === "hold-1"
              ? h1Gate
              : goal === "hold-2"
                ? h2Gate
                : goal === "active-a"
                  ? aGate
                  : Promise.resolve();
          return gatedAgent(gate).openStage(input);
        },
        runStage(input) {
          const goal = input.task.goal;
          const gate =
            goal === "hold-1"
              ? h1Gate
              : goal === "hold-2"
                ? h2Gate
                : goal === "active-a"
                  ? aGate
                  : Promise.resolve();
          return gatedAgent(gate).runStage(input);
        },
      },
      store,
      cwd: rootH1,
      projectRoot: rootH1,
      maxConcurrent: 2,
      maxConcurrentPerProject: 1,
      maxQueued: 32,
    });

    const hold1 = await manager.startRun({
      pipeline: pipelineH1,
      task: { id: "h1", goal: "hold-1" },
    });
    expect(hold1.ok).toBe(true);
    if (!hold1.ok) return;

    const hold2 = await manager.startRun({
      pipeline: pipelineH2,
      task: { id: "h2", goal: "hold-2" },
    });
    expect(hold2.ok).toBe(true);
    if (!hold2.ok) return;
    expect(manager.getActiveCount()).toBe(2);

    const a1 = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "a-1", goal: "active-a" },
    });
    expect(a1.ok).toBe(true);
    if (!a1.ok) return;
    expect(a1.queued).toBe(true);

    const a2 = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "a-2", goal: "queued-a" },
    });
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    expect(a2.queued).toBe(true);

    releaseH1();
    await hold1.done;
    await waitFor(async () => {
      const m = await store.readRunMeta(a1.runId);
      return m.status === "running" || m.status === "succeeded";
    });
    expect(manager.getActiveCount()).toBe(2);

    const b1 = await manager.startRun({
      pipeline: pipelineB,
      task: { id: "b-1", goal: "other-project" },
    });
    expect(b1.ok).toBe(true);
    if (!b1.ok) return;
    expect(b1.queued).toBe(true);

    releaseH2();
    await hold2.done;
    await waitFor(async () => {
      const m = await store.readRunMeta(b1.runId);
      return m.status === "running" || m.status === "succeeded";
    });

    const a2Meta = await store.readRunMeta(a2.runId);
    expect(a2Meta.status).toBe("queued");

    releaseA();
    await Promise.all([a1.done, a2.done, b1.done]);
  }, 20000);
});
