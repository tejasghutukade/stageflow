import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import {
  applyRetryRootDelta,
  hydrateScheduleFromStore,
  runPipelineDag,
} from "../src/runtime/pipelineScheduler.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const CLONE_IDS = ["design-doc~1", "design-doc~2", "design-doc~3"] as const;

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  ...extra,
});

function cloneItem(summary: string): { envelope: StageEnvelope } {
  return { envelope: okEnvelope(summary) };
}

function fanoutForks(
  mode: "parallel" | "sequential",
  summaries: string[],
): CloneForkItem[] {
  return [
    {
      successor_id: "design-doc",
      action: "fanout",
      mode,
      clones: summaries.map(cloneItem),
    },
  ];
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

function schedulerStageId(input: StageRunInput): string {
  return input.stageId ?? input.stage.id;
}

function sequentialAgent(options: {
  cloneSet?: ReadonlySet<string>;
  siblingId?: string;
  behaviorsByStage: Record<
    string,
    Array<
      | { type: "emit"; envelope: StageEnvelope }
      | { type: "throw"; message: string }
      | { type: "fail"; reason: string; envelope?: StageEnvelope }
      | {
          type: "wait_then_emit";
          waitRequests: unknown[];
          envelope: StageEnvelope;
        }
      | { type: "gate"; gate: Promise<void>; envelope: StageEnvelope; fail?: boolean }
    >
  >;
}): AgentPort & {
  openCounts: Map<string, number>;
  launchOrder: string[];
  cloneMaxConcurrent: number;
  siblingOverlappedClone1: boolean;
} {
  const cloneSet = options.cloneSet ?? new Set(CLONE_IDS);
  const siblingId = options.siblingId;
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const launchOrder: string[] = [];
  let cloneConcurrent = 0;
  let cloneMaxConcurrent = 0;
  let clone1InFlight = false;
  let siblingInFlight = false;
  let siblingOverlappedClone1 = false;

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    launchOrder: string[];
    cloneMaxConcurrent: number;
    siblingOverlappedClone1: boolean;
  } = {
    openCounts,
    launchOrder,
    cloneMaxConcurrent: 0,
    siblingOverlappedClone1: false,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      launchOrder.push(stageId);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = options.behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? {
        type: "throw" as const,
        message: `no behavior for ${stageId} attempt ${index + 1}`,
      };

      if (behavior.type === "throw") {
        throw new Error(behavior.message);
      }

      const begin = () => {
        if (cloneSet.has(stageId)) {
          cloneConcurrent += 1;
          cloneMaxConcurrent = Math.max(cloneMaxConcurrent, cloneConcurrent);
          agent.cloneMaxConcurrent = cloneMaxConcurrent;
          if (stageId === "design-doc~1") clone1InFlight = true;
        }
        if (siblingId !== undefined && stageId === siblingId) {
          siblingInFlight = true;
        }
        if (clone1InFlight && siblingInFlight) {
          siblingOverlappedClone1 = true;
          agent.siblingOverlappedClone1 = true;
        }
      };
      const end = () => {
        if (cloneSet.has(stageId)) {
          cloneConcurrent -= 1;
          if (stageId === "design-doc~1") clone1InFlight = false;
        }
        if (siblingId !== undefined && stageId === siblingId) {
          siblingInFlight = false;
        }
      };

      if (behavior.type === "fail") {
        begin();
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            end();
            return {
              ok: false as const,
              reason: behavior.reason,
              ...(behavior.envelope !== undefined
                ? { envelope: behavior.envelope }
                : {}),
            };
          },
        });
      }
      if (behavior.type === "gate") {
        begin();
        const gate = behavior.gate;
        const envelope = behavior.envelope;
        const fail = behavior.fail;
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            await gate;
            end();
            if (fail) {
              return { ok: false as const, reason: "clone failed" };
            }
            return { ok: true as const, envelope };
          },
        });
      }
      if (behavior.type === "wait_then_emit") {
        begin();
        const scripted = scriptedFakeAgent([behavior]);
        const inner = scripted.openStage(input);
        return {
          async next() {
            const event = await inner.next();
            if (event.status === "completed") end();
            return event;
          },
          async close() {
            await inner.close();
          },
        };
      }
      begin();
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => {
          end();
          return { ok: true as const, envelope: behavior.envelope };
        },
      });
    },
    async runStage(input) {
      const handle = agent.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
  return agent;
}

function stageEvents(
  detail: Awaited<ReturnType<ReturnType<typeof createRunStore>["readRun"]>>,
  stageId: string,
) {
  return detail.stages.find((s) => s.stage_id === stageId)?.events ?? [];
}

async function prepareProcessPipeline(root: string, pipelineId: string) {
  const store = createRunStore({ rootDir: root });
  const taskYaml = await readFile(SAMPLE_TASK, "utf8");
  const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
  const loaded = await loadPipeline(pipelinePath(pipelineId), { cwd: fixtures });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  const agent = { openStage: vi.fn(), runStage: vi.fn() };
  return {
    prepared: {
      task,
      loaded,
      run: { runId: run.runId, workspaceDir: run.workspaceDir },
      agent,
      store,
      cwd: fixtures,
    },
    store,
    loaded,
  };
}

describe("sequential clone runnable gate (U1)", () => {
  it("AE1: three sequential clones succeed in order then join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae1-"));
    const store = createRunStore({ rootDir: root });
    const agent = sequentialAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "design-doc~3": [{ type: "emit", envelope: okEnvelope("d3") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const cloneThenJoin = agent.launchOrder.filter(
      (id) => id === "join-doc" || id.startsWith("design-doc~"),
    );
    expect(cloneThenJoin).toEqual([
      "design-doc~1",
      "design-doc~2",
      "design-doc~3",
      "join-doc",
    ]);
    expect(agent.cloneMaxConcurrent).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("AE4: HITL on clone 1 blocks clone 2; outcome waiting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae4-"));
    const dummy = { openStage: vi.fn(), runStage: vi.fn() };
    const { prepared, store } = await prepareProcessPipeline(
      root,
      "clone-fanout-join",
    );
    const launched: string[] = [];
    const launch = vi.fn(
      async ({
        runId,
        stageId,
      }: {
        runId: string;
        stageId: string;
      }) => {
        launched.push(stageId);
        if (stageId === "clarify") {
          await store.writeEnvelope(
            runId,
            stageId,
            okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          );
          return { type: "succeeded" as const };
        }
        if (stageId === "design-doc~1") {
          await store.appendStageEvent(runId, stageId, {
            event: "waiting_for_input",
          });
          return { type: "waiting" as const };
        }
        throw new Error(`${stageId} must not launch`);
      },
    );
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const result = await runPipelineDag({
      prepared: { ...prepared, agent: dummy },
      maxActiveStagesPerRun: 4,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });
    expect(result.outcome).toBe("waiting");
    expect(launched).toContain("design-doc~1");
    expect(launched).not.toContain("design-doc~2");
    expect(launched).not.toContain("join-doc");
    const detail = await store.readRun(prepared.run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc~1")?.status,
    ).toBe("waiting_for_input");
  });

  it("AE5: gated clone 1 with high ceiling keeps clone-set concurrency at 1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae5-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = sequentialAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "gate", gate, envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "design-doc~3": [{ type: "emit", envelope: okEnvelope("d3") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 5,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(() => (agent.openCounts.get("design-doc~1") ?? 0) >= 1);
    expect(agent.openCounts.get("design-doc~2") ?? 0).toBe(0);
    expect(agent.cloneMaxConcurrent).toBe(1);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.cloneMaxConcurrent).toBe(1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("parallel control: mode parallel still overlaps clone instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-par-ctrl-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = sequentialAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "gate", gate, envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "gate", gate, envelope: okEnvelope("d2") }],
        "design-doc~3": [{ type: "gate", gate, envelope: okEnvelope("d3") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 5,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(() => agent.cloneMaxConcurrent >= 2);
    expect(agent.cloneMaxConcurrent).toBeGreaterThanOrEqual(2);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
  });
});

describe("sequential fail-fast and join skip (U2)", () => {
  it("AE2: clone 2 fails skips clone 3 and join with skipped events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae2-"));
    const store = createRunStore({ rootDir: root });
    const agent = sequentialAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "fail", reason: "clone 2 boom" }],
        "design-doc~3": [{ type: "throw", message: "clone 3 agent must not open" }],
        "join-doc": [{ type: "throw", message: "join must not run" }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.openCounts.get("design-doc~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);

    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc~3")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "join-doc")?.status).toBe(
      "skipped",
    );
    expect(stageEvents(detail, "design-doc~3").some((e) => e.event === "skipped")).toBe(
      true,
    );
    expect(stageEvents(detail, "join-doc").some((e) => e.event === "skipped")).toBe(
      true,
    );
  });

  it("named sibling still starts after sequential clone 2 fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae2-sib-"));
    const store = createRunStore({ rootDir: root });
    const agent = sequentialAgent({
      siblingId: "implementation-plan",
      cloneSet: new Set(["design-doc~1", "design-doc~2", "design-doc~3"]),
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: ["implementation-plan"],
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "fail", reason: "clone 2 boom" }],
        "design-doc~3": [{ type: "throw", message: "clone 3 must not open" }],
        "implementation-plan": [
          { type: "emit", envelope: okEnvelope("impl") },
        ],
        "join-doc": [{ type: "throw", message: "join must not run" }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 5,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("design-doc~3") ?? 0).toBe(0);
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
    const detail = await store.readRun(started.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("succeeded");
  });
});

describe("named-sibling isolation (U3)", () => {
  it("AE3/AE5: sibling overlaps clone 1; clone 2 stays unstarted while gated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae3-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = sequentialAgent({
      siblingId: "implementation-plan",
      cloneSet: new Set(["design-doc~1", "design-doc~2"]),
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: ["implementation-plan"],
              clone_forks: fanoutForks("sequential", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "gate", gate, envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "implementation-plan": [
          { type: "gate", gate, envelope: okEnvelope("impl") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 5,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(
      () =>
        (agent.openCounts.get("design-doc~1") ?? 0) >= 1 &&
        (agent.openCounts.get("implementation-plan") ?? 0) >= 1,
    );
    expect(agent.openCounts.get("design-doc~2") ?? 0).toBe(0);
    expect(agent.cloneMaxConcurrent).toBe(1);
    expect(agent.siblingOverlappedClone1).toBe(true);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.cloneMaxConcurrent).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });
});

describe("hydrate leftover sequential skips (U4)", () => {
  it("AE6: leftover clone and join hydrate as skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-seq-ae6-"));
    const store = createRunStore({ rootDir: root });
    const agent = sequentialAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "fail", reason: "clone 2 boom" }],
        "design-doc~3": [{ type: "throw", message: "clone 3 must not open" }],
        "join-doc": [{ type: "throw", message: "join must not run" }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc~3")?.status).toBe(
      "skipped",
    );
    expect(stageEvents(detail, "design-doc~3").some((e) => e.event === "skipped")).toBe(
      true,
    );
    expect(detail.stages.find((s) => s.stage_id === "join-doc")?.status).toBe(
      "skipped",
    );

    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const hydrated = await hydrateScheduleFromStore(
      store,
      started.runId,
      loaded.dag,
      "process",
    );
    expect(hydrated.states.get("design-doc~3")).toBe("skipped");
    expect(hydrated.states.get("join-doc")).toBe("skipped");
    expect(hydrated.states.get("design-doc~2")).toBe("failed");
  });

  it("retry of sequential ~2 pending-izes later clones and join", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 3,
    });
    const states = new Map(
      snapshot.nodes.map((n) => [n.id, "pending" as const]),
    );
    states.set("clarify", "succeeded");
    states.set("design-doc~1", "succeeded");
    states.set("design-doc~2", "failed");
    states.set("design-doc~3", "skipped");
    states.set("join-doc", "skipped");
    const completed = new Map<string, StageEnvelope>([
      [
        "clarify",
        okEnvelope("clarify-ok", {
          clone_forks: fanoutForks("sequential", ["c1", "c2", "c3"]),
        }),
      ],
      ["design-doc~1", okEnvelope("d1")],
      [
        "design-doc~2",
        { status: "failure", summary: "boom", artifacts: [] },
      ],
    ]);
    applyRetryRootDelta(
      snapshot,
      states,
      completed,
      new Map(),
      "design-doc~2",
      2,
    );
    expect(states.get("clarify")).toBe("succeeded");
    expect(states.get("design-doc~1")).toBe("succeeded");
    expect(states.get("design-doc~2")).toBe("pending");
    expect(states.get("design-doc~3")).toBe("pending");
    expect(states.get("join-doc")).toBe("pending");
  });
});
