import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { reportCliRun } from "../src/cli/runOutput.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { FreeSpaceReader } from "../src/runstore/diskUsage.js";
import { resolveMinFreeDiskFloor } from "../src/runstore/diskUsage.js";
import {
  INSUFFICIENT_DISK_CANCEL_REASON,
  PROJECT_ROOT_UNAVAILABLE_REASON,
  RunManager,
} from "../src/runtime/runManager.js";
import { mapStartFailure } from "../src/server/operatorResults.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const FLOOR = 1_000_000;
const TOTAL = 10_000_000;

function freeSpace(freeBytes: number): FreeSpaceReader {
  return async () => ({ freeBytes, totalBytes: TOTAL });
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

describe("runtime disk-floor admission (U9)", () => {
  const previousMinFree = process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
  const previousMaxQueued = process.env.STAGEFLOW_MAX_QUEUED;
  const previousHome = process.env.STAGEFLOW_HOME;

  beforeEach(() => {
    process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = String(FLOOR);
    process.env.STAGEFLOW_MAX_QUEUED = "32";
    clearFindProjectRootCacheForTests();
  });

  afterEach(() => {
    resetGlobalStageflowHomeForTests();
    if (previousMinFree === undefined) {
      delete process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
    } else {
      process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = previousMinFree;
    }
    if (previousMaxQueued === undefined) {
      delete process.env.STAGEFLOW_MAX_QUEUED;
    } else {
      process.env.STAGEFLOW_MAX_QUEUED = previousMaxQueued;
    }
    if (previousHome === undefined) {
      delete process.env.STAGEFLOW_HOME;
    } else {
      process.env.STAGEFLOW_HOME = previousHome;
    }
  });

  it("resolveMinFreeDiskFloor: bytes, percent, and default max(2GiB, 10%)", () => {
    const tenGib = 10 * 1024 * 1024 * 1024;
    expect(resolveMinFreeDiskFloor("5000", tenGib)).toBe(5000);
    expect(resolveMinFreeDiskFloor("10%", tenGib)).toBe(
      Math.floor(tenGib * 0.1),
    );
    expect(resolveMinFreeDiskFloor(undefined, tenGib)).toBe(
      Math.max(2 * 1024 * 1024 * 1024, Math.floor(tenGib * 0.1)),
    );
    expect(resolveMinFreeDiskFloor("", 1000)).toBe(
      Math.max(2 * 1024 * 1024 * 1024, 100),
    );
  });

  async function withHome(): Promise<string> {
    const home = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-home-"));
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    return home;
  }

  it("above floor → normal admit", async () => {
    await withHome();
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-ok-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: recordingAgent([]),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
      freeSpaceReader: freeSpace(FLOOR + 1),
    });

    const started = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "ok", goal: "above floor" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.queued).not.toBe(true);
    await started.done;
  });

  it("above floor with full capacity → queues", async () => {
    await withHome();
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-q-"));
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
      freeSpaceReader: freeSpace(FLOOR + 1),
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "hold", goal: "hold" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const queued = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "wait", goal: "queue" },
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.queued).toBe(true);
    expect(queued.queuePosition).toBe(1);

    release();
    await queued.done;
  });

  it("below floor at initial → insufficient_disk, no row, no queue", async () => {
    await withHome();
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-rej-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: recordingAgent([]),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
      freeSpaceReader: freeSpace(FLOOR - 1),
    });

    const rejected = await manager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "nope", goal: "below floor" },
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("insufficient_disk");
    expect(rejected.status).toBe(409);
    expect(rejected.freeBytes).toBe(FLOOR - 1);
    expect(rejected.minFreeBytes).toBe(FLOOR);
    expect(rejected.reason).toMatch(/Insufficient free disk/);

    const runs = await store.listRuns();
    expect(runs).toHaveLength(0);
    expect(manager.getActiveCount()).toBe(0);
  });

  it("disk drops while queued → dequeue cancels insufficient_disk; next root tried", async () => {
    await withHome();
    let freeBytes = FLOOR + 1;
    const reader: FreeSpaceReader = async () => ({
      freeBytes,
      totalBytes: TOTAL,
    });

    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-drop-"));
    const store = createRunStore({ rootDir: root });
    const rootA = path.join(root, "proj-a");
    const rootB = path.join(root, "proj-b");
    const pipelineA = await plantMiniProject(rootA);
    const pipelineB = await plantMiniProject(rootB);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const manager = new RunManager({
      agent: {
        openStage(input) {
          starts.push(input.runId);
          return gatedAgent(gate).openStage(input);
        },
        runStage(input) {
          starts.push(input.runId);
          return gatedAgent(gate).runStage(input);
        },
      },
      store,
      cwd: rootA,
      projectRoot: rootA,
      maxConcurrent: 1,
      freeSpaceReader: reader,
    });

    const holder = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "hold", goal: "hold" },
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;

    const queuedA = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "qa", goal: "queued-a" },
    });
    expect(queuedA.ok).toBe(true);
    if (!queuedA.ok) return;
    expect(queuedA.queued).toBe(true);

    const queuedB = await manager.startRun({
      pipeline: pipelineB,
      task: { id: "qb", goal: "queued-b" },
    });
    expect(queuedB.ok).toBe(true);
    if (!queuedB.ok) return;
    expect(queuedB.queued).toBe(true);

    freeBytes = FLOOR - 1;
    release();

    await waitFor(async () => {
      const a = await store.readRunMeta(queuedA.runId);
      const b = await store.readRunMeta(queuedB.runId);
      return a.status === "cancelled" && b.status === "cancelled";
    });

    const metaA = await store.readRunMeta(queuedA.runId);
    const metaB = await store.readRunMeta(queuedB.runId);
    expect(metaA.cancel_reason).toBe(INSUFFICIENT_DISK_CANCEL_REASON);
    expect(metaB.cancel_reason).toBe(INSUFFICIENT_DISK_CANCEL_REASON);
    expect(starts).not.toContain(queuedA.runId);
    expect(starts).not.toContain(queuedB.runId);

    const doneA = await queuedA.done;
    expect(doneA.outcome).toBe("cancelled");
    expect(doneA.reason).toBe(INSUFFICIENT_DISK_CANCEL_REASON);
  }, 15000);

  it("project_root removed from known roots → cancel project_root_unavailable", async () => {
    await withHome();
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-root-"));
    const store = createRunStore({ rootDir: root });
    const rootA = path.join(root, "proj-a");
    const rootB = path.join(root, "proj-b");
    const pipelineA = await plantMiniProject(rootA);
    const pipelineB = await plantMiniProject(rootB);
    const realA = await realpath(rootA);
    const realB = await realpath(rootB);

    let knownRoots = [realA, realB];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const manager = new RunManager({
      agent: {
        openStage(input) {
          starts.push(input.runId);
          return gatedAgent(gate).openStage(input);
        },
        runStage(input) {
          starts.push(input.runId);
          return gatedAgent(gate).runStage(input);
        },
      },
      store,
      cwd: rootA,
      projectRoot: rootA,
      maxConcurrent: 1,
      freeSpaceReader: freeSpace(FLOOR + 1),
      knownWritableProjectRoots: () => knownRoots,
    });

    const holder = await manager.startRun({
      pipeline: pipelineA,
      task: { id: "hold", goal: "hold" },
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;

    const queuedB = await manager.startRun({
      pipeline: pipelineB,
      task: { id: "qb", goal: "queued-b" },
    });
    expect(queuedB.ok).toBe(true);
    if (!queuedB.ok) return;
    expect(queuedB.queued).toBe(true);

    knownRoots = [realA];
    release();

    await waitFor(async () => {
      const m = await store.readRunMeta(queuedB.runId);
      return m.status === "cancelled";
    });

    const meta = await store.readRunMeta(queuedB.runId);
    expect(meta.cancel_reason).toBe(PROJECT_ROOT_UNAVAILABLE_REASON);
    expect(starts).not.toContain(queuedB.runId);

    const done = await queuedB.done;
    expect(done.outcome).toBe("cancelled");
    expect(done.reason).toBe(PROJECT_ROOT_UNAVAILABLE_REASON);
  }, 15000);

  it("anti: code field discriminates insufficient_disk vs busy_capacity on MCP/REST/CLI JSON", async () => {
    await withHome();
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-adm-anti-"));
    const store = createRunStore({ rootDir: root });
    const diskManager = new RunManager({
      agent: recordingAgent([]),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
      freeSpaceReader: freeSpace(FLOOR - 1),
    });

    const diskFail = await diskManager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "disk", goal: "disk" },
    });
    expect(diskFail.ok).toBe(false);
    if (diskFail.ok) return;
    expect(diskFail.code).toBe("insufficient_disk");
    expect(diskFail.code).not.toBe("busy_capacity");

    const restBody = mapStartFailure(diskFail);
    expect(restBody.code).toBe("insufficient_disk");
    expect(restBody.freeBytes).toBe(FLOOR - 1);
    expect(restBody.minFreeBytes).toBe(FLOOR);
    expect(restBody).not.toHaveProperty("activeCount");

    const { ok: _ok, reason, ...mcpRest } = diskFail;
    const mcpPayload = { error: reason, ...mcpRest };
    expect(mcpPayload.code).toBe("insufficient_disk");
    expect(mcpPayload.freeBytes).toBe(FLOOR - 1);

    const lines: string[] = [];
    await reportCliRun(
      { kind: "start-failure", started: diskFail },
      {
        json: true,
        io: {
          log: (line) => lines.push(line),
          error: () => undefined,
        },
      },
    );
    const cliJson = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(cliJson.outcome).toBe("failed");
    expect(cliJson.code).toBe("insufficient_disk");
    expect(cliJson.code).not.toBe("busy_capacity");
    expect(cliJson.freeBytes).toBe(FLOOR - 1);
    expect(cliJson.minFreeBytes).toBe(FLOOR);

    process.env.STAGEFLOW_MAX_QUEUED = "0";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busyManager = new RunManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
      freeSpaceReader: freeSpace(FLOOR + 1),
    });
    const holder = await busyManager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "hold", goal: "hold" },
    });
    expect(holder.ok).toBe(true);
    if (!holder.ok) return;

    const busy = await busyManager.startRun({
      pipeline: pipelinePath("single"),
      task: { id: "busy", goal: "busy" },
    });
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.code).toBe("busy_capacity");
    expect(busy.code).not.toBe("insufficient_disk");

    const busyRest = mapStartFailure(busy);
    expect(busyRest.code).toBe("busy_capacity");

    const busyLines: string[] = [];
    await reportCliRun(
      { kind: "start-failure", started: busy },
      {
        json: true,
        io: {
          log: (line) => busyLines.push(line),
          error: () => undefined,
        },
      },
    );
    const busyCli = JSON.parse(busyLines[0] ?? "{}") as Record<string, unknown>;
    expect(busyCli.outcome).toBe("busy");
    expect(busyCli.code).toBe("busy_capacity");

    release();
    await holder.done;
  });

  it("freeSpaceReader throw → disk_check_failed (fail closed)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-disk-throw-"));
    const store = createRunStore({ rootDir: root });
    const prev = process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
    process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = String(FLOOR);
    try {
      const manager = new RunManager({
        agent: recordingAgent([]),
        store,
        cwd: fixtures,
        freeSpaceReader: async () => {
          throw new Error("statfs exploded");
        },
      });
      const rejected = await manager.startRun({
        pipeline: pipelinePath("single"),
        task: { id: "t", goal: "disk-throw" },
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.code).toBe("disk_check_failed");
      expect(rejected.status).toBe(503);
      expect(rejected.reason).toContain("statfs exploded");
      const runs = await store.listRuns();
      expect(runs).toHaveLength(0);
    } finally {
      if (prev === undefined) {
        delete process.env.STAGEFLOW_MIN_FREE_DISK_BYTES;
      } else {
        process.env.STAGEFLOW_MIN_FREE_DISK_BYTES = prev;
      }
    }
  });
});
