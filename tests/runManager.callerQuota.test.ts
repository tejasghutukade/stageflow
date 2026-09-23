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

type AdmitFn = (
  checkoutKey: string | undefined,
  projectRoot?: string,
  callerId?: string | null,
) => {
  action: string;
  reason?: string;
  failure?: {
    code?: string;
    scope?: string;
    caller_id?: string;
    maxConcurrent?: number;
  };
};

function admit(manager: RunManager): AdmitFn {
  return (manager as unknown as { tryAdmitOrEnqueue: AdmitFn }).tryAdmitOrEnqueue.bind(
    manager,
  );
}

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

describe("per-caller concurrency quota", () => {
  it("queues with busy_caller_quota reason when caller is at quota and global has room", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-q-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 4,
      maxQueued: 8,
      callerQuotas: { ci: 1 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const second = tryAdmit(undefined, root, "ci");
    expect(second.action).toBe("enqueue");
    expect(second.reason).toBe("caller_quota");

    const other = tryAdmit(undefined, root, "other");
    expect(other.action).toBe("reserve");
  });

  it("rejects busy_caller_quota when caller over quota and admission queue is full", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-full-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 2,
      maxQueued: 0,
      callerQuotas: { ci: 1 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_caller_quota");
    expect(rejected.failure?.scope).toBe("caller");
    expect(rejected.failure?.caller_id).toBe("ci");
    expect(rejected.failure?.maxConcurrent).toBe(1);

  });

  it("global full still returns busy_capacity not busy_caller_quota", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-global-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 1,
      maxQueued: 0,
      callerQuotas: { ci: 10 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_capacity");
    expect(rejected.failure?.scope).toBe("global");
  });

  it("per-project cap still rejects with busy_capacity (does not queue)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "sf-caller-proj-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 6,
      maxConcurrentPerProject: 1,
      maxQueued: 8,
      callerQuotas: { ci: 10 },
    });

    const tryAdmit = admit(manager);
    expect(tryAdmit(undefined, root, "ci").action).toBe("reserve");
    const rejected = tryAdmit(undefined, root, "ci");
    expect(rejected.action).toBe("reject");
    expect(rejected.failure?.code).toBe("busy_capacity");
    expect(rejected.failure?.scope).toBe("project");
  });

  it("drain skips caller-quota head and starts later caller on same project_root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-caller-drain-"));
    temps.push(root);
    const store = createRunStore({ rootDir: root });
    const pipeline = await plantMiniProject(root);

    let releaseCi!: () => void;
    const ciGate = new Promise<void>((resolve) => {
      releaseCi = resolve;
    });
    let releaseFiller!: () => void;
    const fillerGate = new Promise<void>((resolve) => {
      releaseFiller = resolve;
    });

    const manager = new RunManager({
      agent: {
        openStage(input) {
          const gate =
            input.task.goal === "hold-ci"
              ? ciGate
              : input.task.goal === "hold-filler"
                ? fillerGate
                : Promise.resolve();
          return gatedAgent(gate).openStage(input);
        },
        runStage(input) {
          const gate =
            input.task.goal === "hold-ci"
              ? ciGate
              : input.task.goal === "hold-filler"
                ? fillerGate
                : Promise.resolve();
          return gatedAgent(gate).runStage(input);
        },
      },
      store,
      cwd: root,
      projectRoot: root,
      maxConcurrent: 2,
      maxQueued: 8,
      callerQuotas: { ci: 1 },
    });

    const holdCi = await manager.startRun({
      pipeline,
      task: { id: "hold-ci", goal: "hold-ci" },
      callerId: "ci",
    });
    expect(holdCi.ok).toBe(true);
    if (!holdCi.ok) return;

    const holdFiller = await manager.startRun({
      pipeline,
      task: { id: "hold-filler", goal: "hold-filler" },
      callerId: "filler",
    });
    expect(holdFiller.ok).toBe(true);
    if (!holdFiller.ok) return;
    expect(manager.getActiveCount()).toBe(2);

    const queuedCi = await manager.startRun({
      pipeline,
      task: { id: "queued-ci", goal: "blocked-ci" },
      callerId: "ci",
    });
    expect(queuedCi.ok).toBe(true);
    if (!queuedCi.ok) return;
    expect(queuedCi.queued).toBe(true);

    const queuedOther = await manager.startRun({
      pipeline,
      task: { id: "queued-other", goal: "progress-other" },
      callerId: "other",
    });
    expect(queuedOther.ok).toBe(true);
    if (!queuedOther.ok) return;
    expect(queuedOther.queued).toBe(true);

    releaseFiller();
    await holdFiller.done;

    await waitFor(async () => {
      const m = await store.readRunMeta(queuedOther.runId);
      return m.status === "running" || m.status === "succeeded";
    });

    const otherMeta = await store.readRunMeta(queuedOther.runId);
    expect(["running", "succeeded"]).toContain(otherMeta.status);
    const ciStillQueued = await store.readRunMeta(queuedCi.runId);
    expect(ciStillQueued.status).toBe("queued");

    releaseCi();
    await Promise.all([holdCi.done, queuedOther.done, queuedCi.done]);
  }, 20000);
});
