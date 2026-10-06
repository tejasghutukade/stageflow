import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

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

function recordingAgent(starts: string[]): AgentPort {
  return {
    openStage(input: StageRunInput) {
      starts.push(input.runId);
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
    async runStage(input) {
      starts.push(input.runId);
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

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
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

describe("runtime admission queue (U8)", () => {
  const previousMaxQueued = process.env.STAGEFLOW_MAX_QUEUED;

  beforeEach(() => {
    process.env.STAGEFLOW_MAX_QUEUED = "32";
    clearFindProjectRootCacheForTests();
  });

  afterEach(() => {
    if (previousMaxQueued === undefined) {
      delete process.env.STAGEFLOW_MAX_QUEUED;
    } else {
      process.env.STAGEFLOW_MAX_QUEUED = previousMaxQueued;
    }
  });

  it("maxConcurrent full → queued true queuePosition 1; starts when slot frees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-cap-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "a", goal: "hold" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getMaxConcurrent()).toBe(1);

    const queued = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "b", goal: "wait" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.queued).toBe(true);
    expect(queued.queuePosition).toBe(1);

    const meta = await store.readRunMeta(queued.runId);
    expect(meta.status).toBe("queued");
    expect(manager.getActiveRunIds()).toEqual([first.runId]);

    release();
    await waitFor(async () => {
      const m = await store.readRunMeta(queued.runId);
      return m.status === "running" || m.status === "succeeded";
    });
    await queued.done;
    const after = await store.readRunMeta(queued.runId);
    expect(after.status).toBe("succeeded");
  });

  it("two project_roots × two queued → round-robin A,B,A,B", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-rr-"));
    const store = createRunStore({ rootDir: root });
    const rootA = path.join(root, "proj-a");
    const rootB = path.join(root, "proj-b");
    const pipelineA = await plantMiniProject(rootA);
    const pipelineB = await plantMiniProject(rootB);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leaveQueuedOrder: string[] = [];
    const manager = new RunManager({
      agent: {
        openStage(input) {
          return gatedAgent(gate).openStage(input);
        },
        runStage(input) {
          return gatedAgent(gate).runStage(input);
        },
      },
      store,
      cwd: rootA,
      projectRoot: rootA,
      maxConcurrent: 1,
    });

    const holder = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "hold", goal: "hold" },
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;

    const queuedIds: string[] = [];
    for (const pipeline of [pipelineA, pipelineB, pipelineA, pipelineB]) {
      const result = await manager.startRun({
        pipeline,
        task: { id: `q-${queuedIds.length}`, goal: "queued" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.queued).toBe(true);
      queuedIds.push(result.runId);
      await new Promise((r) => setTimeout(r, 5));
    }

    const metas = await Promise.all(
      queuedIds.map((id) => store.readRunMeta(id)),
    );
    expect(metas.map((m) => m.project_root)).toEqual(
      await Promise.all([rootA, rootB, rootA, rootB].map(realpathSafe)),
    );

    release();
    await waitFor(async () => {
      for (const id of queuedIds) {
        if (leaveQueuedOrder.includes(id)) continue;
        const m = await store.readRunMeta(id);
        if (m.status !== "queued") leaveQueuedOrder.push(id);
      }
      const rows = await Promise.all(
        queuedIds.map((id) => store.readRunMeta(id)),
      );
      return rows.every((m) => m.status === "succeeded");
    }, 15000);

    expect(leaveQueuedOrder).toEqual(queuedIds);
  }, 20000);

  it("MAX_QUEUED full → busy_capacity", async () => {
    process.env.STAGEFLOW_MAX_QUEUED = "1";
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-full-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "a", goal: "hold" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(manager.getActiveCount()).toBe(1);

    const queued = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "b", goal: "queued" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.queued).toBe(true);

    const rejected = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "c", goal: "reject" },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("busy_capacity");
      expect(rejected.status).toBe(409);
      expect(rejected.reason).toMatch(/queue full/i);
    }

    release();
    await first.done;
    if (queued.ok) await queued.done;
  });

  it("busy_checkout never queued even when queue has room", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-co-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-adm-co-path-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 2,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "a", goal: "hold", checkout },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(manager.getActiveCount()).toBe(1);

    const conflict = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "b", goal: "conflict", checkout },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("busy_checkout");
    }

    const runs = await store.listRuns({ status: "queued" });
    expect(runs).toHaveLength(0);

    release();
    await first.done;
  });

  it("restart: persisted queued re-enqueued created_at order from DB", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-boot-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline(pipelinePath("single"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const taskYaml = "id: t\ngoal: g\n";
    const createdIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await store.createRun({
        pipelineId: loaded.pipeline.id,
        taskYaml,
        pipelineDag: dag,
        pipelinePath: pipelinePath("single"),
        projectRoot: fixtures,
        status: "queued",
      });
      createdIds.push(created.runId);
      await new Promise((r) => setTimeout(r, 5));
    }

    const leaveQueuedOrder: string[] = [];
    const manager = new RunManager({
      agent: recordingAgent([]),
      store,
      cwd: fixtures,
      projectRoot: fixtures,
      maxConcurrent: 1,
    });
    await manager.reenqueuePersistedQueuedRuns();

    await waitFor(async () => {
      for (const id of createdIds) {
        if (leaveQueuedOrder.includes(id)) continue;
        const m = await store.readRunMeta(id);
        if (m.status !== "queued") leaveQueuedOrder.push(id);
      }
      const metas = await Promise.all(
        createdIds.map((id) => store.readRunMeta(id)),
      );
      return metas.every((m) => m.status === "succeeded");
    }, 15000);

    expect(leaveQueuedOrder).toEqual(createdIds);
  }, 20000);

  it("cancel queued removes from queue; no worker spawned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-cancel-"));
    const store = createRunStore({ rootDir: root });
    const openStage = vi.fn((input: StageRunInput) =>
      createCompletedOnlyStageHandle({
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
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = gatedAgent(gate);
    const manager = new RunManager({
      agent: {
        openStage(input) {
          openStage(input);
          return hold.openStage(input);
        },
        runStage(input) {
          openStage(input);
          return hold.runStage(input);
        },
      },
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "a", goal: "hold" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const queued = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "b", goal: "cancel-me" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.queued).toBe(true);

    const opensBeforeCancel = openStage.mock.calls.length;
    const cancelled = await manager.cancelRun(queued.runId, "not needed");
    expect(cancelled).toEqual({ ok: true, runId: queued.runId });

    const meta = await store.readRunMeta(queued.runId);
    expect(meta.status).toBe("cancelled");
    expect(meta.cancel_reason).toBe("not needed");

    release();
    await first.done;
    await new Promise((r) => setTimeout(r, 100));
    expect(openStage.mock.calls.length).toBe(opensBeforeCancel);
    expect(
      openStage.mock.calls.some((call) => call[0]?.runId === queued.runId),
    ).toBe(false);
  });

  it("cancel during dequeue materialize leaves cancelled, not running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-cancel-mat-"));
    const store = createRunStore({ rootDir: root });
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let releaseMaterialize!: () => void;
    let materializeEntered = false;
    const materializeGate = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });

    try {
      const manager = new RunManager({
        agent: gatedAgent(holdGate),
        store,
        cwd: fixtures,
        maxConcurrent: 1,
        onBeforeQueuedMaterialize: async () => {
          materializeEntered = true;
          await materializeGate;
        },
      });

      const first = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "a", goal: "hold" },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const queued = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "b", goal: "cancel-mid-dequeue" },
      });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      expect(queued.queued).toBe(true);

      releaseHold();
      await first.done;
      await waitFor(async () => materializeEntered);

      const cancelled = await manager.cancelRun(
        queued.runId,
        "cancel during materialize",
      );
      expect(cancelled).toEqual({ ok: true, runId: queued.runId });

      releaseMaterialize();
      await queued.done;
      await new Promise((r) => setTimeout(r, 50));

      const meta = await store.readRunMeta(queued.runId);
      expect(meta.status).toBe("cancelled");
      expect(meta.cancel_reason).toBe("cancel during materialize");
    } finally {
      releaseMaterialize();
    }
  }, 15000);
  it("capacity race during dequeue requeues once (no double-requeue)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-cap-race-"));
    const store = createRunStore({ rootDir: root });
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let releaseFiller!: () => void;
    const fillerGate = new Promise<void>((resolve) => {
      releaseFiller = resolve;
    });
    let releaseDisk!: () => void;
    let diskCheckEntered = false;
    let diskBlockersRemaining = 0;
    const diskGate = new Promise<void>((resolve) => {
      releaseDisk = resolve;
    });

    const prevFloor = process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
    process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = "1000";

    try {
      const manager = new RunManager({
        agent: {
          openStage(input: StageRunInput) {
            if (input.task.goal === "hold") {
              return gatedAgent(holdGate).openStage(input);
            }
            if (input.task.goal === "fill-slot") {
              return gatedAgent(fillerGate).openStage(input);
            }
            return recordingAgent([]).openStage(input);
          },
          async runStage(input: StageRunInput) {
            if (input.task.goal === "hold") {
              return gatedAgent(holdGate).runStage(input);
            }
            if (input.task.goal === "fill-slot") {
              return gatedAgent(fillerGate).runStage(input);
            }
            return recordingAgent([]).runStage(input);
          },
        },
        store,
        cwd: fixtures,
        maxConcurrent: 1,
        freeSpaceReader: async () => {
          if (diskBlockersRemaining > 0) {
            diskBlockersRemaining -= 1;
            diskCheckEntered = true;
            await diskGate;
          }
          return { freeBytes: 1_000_000_000_000, totalBytes: 2_000_000_000_000 };
        },
      });

      const first = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "a", goal: "hold" },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const queued = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "b", goal: "dequeue-race" },
      });
      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      expect(queued.queued).toBe(true);

      diskBlockersRemaining = 1;
      releaseHold();
      await first.done;
      await waitFor(async () => diskCheckEntered);

      const filler = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "c", goal: "fill-slot" },
      });
      expect(filler.ok).toBe(true);
      if (!filler.ok) return;
      expect(filler.queued).not.toBe(true);

      releaseDisk();
      await waitFor(async () => {
        const meta = await store.readRunMeta(queued.runId);
        return meta.status === "queued";
      });

      const probe = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "d", goal: "probe-depth" },
      });
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      expect(probe.queued).toBe(true);
      // B requeued once + D → position 2. Double-requeue would make this 3.
      expect(probe.queuePosition).toBe(2);

      releaseFiller();
      await filler.done;
      await queued.done;
      await probe.done;

      const meta = await store.readRunMeta(queued.runId);
      expect(meta.status).toBe("succeeded");
    } finally {
      releaseDisk();
      releaseFiller();
      if (prevFloor === undefined) {
        delete process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
      } else {
        process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = prevFloor;
      }
    }
  }, 20000);

  it("stopAcceptingWork prevents drainAdmissionQueue from starting queued runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-adm-shutdown-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "a", goal: "hold" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const queued = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "b", goal: "wait" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.queued).toBe(true);

    manager.stopAcceptingWork();
    release();
    await first.done;

    await new Promise((r) => setTimeout(r, 150));
    const meta = await store.readRunMeta(queued.runId);
    expect(meta.status).toBe("queued");
    expect(manager.getActiveCount()).toBe(0);
  });
});
