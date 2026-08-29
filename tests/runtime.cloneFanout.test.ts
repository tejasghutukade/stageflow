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
  applyCloneForksFromEnvelopes,
  applyCloneForksToSchedule,
  runPipelineDag,
  type StageScheduleState,
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

const okEnvelope = (
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope => ({
  status: "success",
  summary,
  artifacts: [],
  ...extra,
});

const failEnvelope = (summary: string): StageEnvelope => ({
  status: "failure",
  summary,
  artifacts: [],
});

const cloneItem = (summary: string): { envelope: StageEnvelope } => ({
  envelope: okEnvelope(summary),
});

function skipForks(): CloneForkItem[] {
  return [{ successor_id: "design-doc", action: "skip" }];
}

function onceForks(summary: string): CloneForkItem[] {
  return [
    {
      successor_id: "design-doc",
      action: "once",
      envelope: okEnvelope(summary),
    },
  ];
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

function instanceKeyedAgent(options: {
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
  priors: Map<string, StageEnvelope | null>;
  priorEnvelopes: Map<string, StageEnvelope[] | undefined>;
  concurrent: number;
  maxConcurrent: number;
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const priors = new Map<string, StageEnvelope | null>();
  const priorEnvelopes = new Map<string, StageEnvelope[] | undefined>();
  let concurrent = 0;
  let maxConcurrent = 0;

  const agent: AgentPort & {
    openCounts: Map<string, number>;
    priors: Map<string, StageEnvelope | null>;
    priorEnvelopes: Map<string, StageEnvelope[] | undefined>;
    concurrent: number;
    maxConcurrent: number;
  } = {
    openCounts,
    priors,
    priorEnvelopes,
    concurrent: 0,
    maxConcurrent: 0,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      priors.set(stageId, input.priorEnvelope);
      priorEnvelopes.set(stageId, input.priorEnvelopes);
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
      if (behavior.type === "fail") {
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => ({
            ok: false as const,
            reason: behavior.reason,
            ...(behavior.envelope !== undefined
              ? { envelope: behavior.envelope }
              : {}),
          }),
        });
      }
      if (behavior.type === "gate") {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        agent.concurrent = concurrent;
        agent.maxConcurrent = maxConcurrent;
        const gate = behavior.gate;
        const envelope = behavior.envelope;
        const fail = behavior.fail;
        return createCompletedOnlyStageHandle({
          stageId,
          run: async () => {
            await gate;
            concurrent -= 1;
            agent.concurrent = concurrent;
            if (fail) {
              return { ok: false as const, reason: "clone failed" };
            }
            return { ok: true as const, envelope };
          },
        });
      }
      if (behavior.type === "wait_then_emit") {
        const scripted = scriptedFakeAgent([behavior]);
        return scripted.openStage(input);
      }
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => ({
          ok: true as const,
          envelope: behavior.envelope,
        }),
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

async function prepareInprocessPipeline(
  root: string,
  pipelineId: string,
  agent: AgentPort,
) {
  const store = createRunStore({ rootDir: root });
  const taskPath = SAMPLE_TASK;
  const taskYaml = await readFile(taskPath, "utf8");
  const task = loadTaskFromYaml(taskYaml, taskPath);
  const loaded = await loadPipeline(pipelinePath(pipelineId), { cwd: fixtures });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
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
    runId: run.runId,
  };
}

describe("clone fan-out skip (U1 / AE2)", () => {
  it("skips clonable successor and join; run succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-skip-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", { clone_forks: skipForks() }),
          },
        ],
        "design-doc": [{ type: "throw", message: "should not run" }],
        "join-doc": [{ type: "throw", message: "should not run" }],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
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

    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc")?.status).toBe(
      "skipped",
    );
    expect(detail.stages.find((s) => s.stage_id === "join-doc")?.status).toBe(
      "skipped",
    );
    expect(agent.openCounts.get("design-doc") ?? 0).toBe(0);
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
  });

  it("persists skipped events on successor and join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-skip-persist-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", { clone_forks: skipForks() }),
          },
        ],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
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

    const detail = await store.readRun(started.runId);
    const designEvents =
      detail.stages.find((s) => s.stage_id === "design-doc")?.events ?? [];
    const joinEvents =
      detail.stages.find((s) => s.stage_id === "join-doc")?.events ?? [];
    expect(designEvents.some((e) => e.event === "skipped")).toBe(true);
    expect(joinEvents.some((e) => e.event === "skipped")).toBe(true);
  });

  it("hydrate does not launch skipped successor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-skip-hydrate-"));
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        "design-doc": [{ type: "throw", message: "should not run" }],
        "join-doc": [{ type: "throw", message: "should not run" }],
      },
    });
    const { prepared, store, runId } = await prepareInprocessPipeline(
      root,
      "clone-fanout-join",
      agent,
    );
    await store.ensureStageWorkspace(runId, "clarify");
    await store.createStageExecution(runId, "clarify");
    await store.writeEnvelope(
      runId,
      "clarify",
      okEnvelope("clarify-ok", { clone_forks: skipForks() }),
    );
    await store.appendStageEvent(runId, "clarify", { event: "started" });
    await store.appendStageEvent(runId, "clarify", { event: "succeeded" });

    const result = await runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("design-doc") ?? 0).toBe(0);
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
  });

  it("applying skip twice is idempotent", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const states = new Map<string, StageScheduleState>(
      dag.nodes.map((n) => [n.id, "pending"]),
    );
    states.set("clarify", "succeeded");
    const envelope = okEnvelope("clarify-ok", { clone_forks: skipForks() });
    const first = applyCloneForksToSchedule(dag, "clarify", envelope, states);
    const second = applyCloneForksToSchedule(
      first.dag,
      "clarify",
      envelope,
      states,
    );
    expect(states.get("design-doc")).toBe("skipped");
    expect(states.get("join-doc")).toBe("skipped");
    expect(second.skippedIds).toEqual([]);
    states.set("design-doc", "succeeded");
    applyCloneForksToSchedule(second.dag, "clarify", envelope, states);
    expect(states.get("design-doc")).toBe("succeeded");
  });
});

describe("clone fan-out once (U2 / AE8)", () => {
  it("runs one catalog instance with the supplied prior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-once-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-summary", {
              clone_forks: onceForks("once-prior"),
            }),
          },
        ],
        "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
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

    expect(agent.openCounts.get("design-doc")).toBe(1);
    expect(agent.openCounts.get("design-doc~1") ?? 0).toBe(0);
    expect(agent.priors.get("design-doc")?.summary).toBe("once-prior");
    expect(agent.priors.get("design-doc")?.summary).not.toBe("clarify-summary");
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("named sibling still receives the predecessor envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-once-sib-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-summary", {
              fork_choice: ["implementation-plan"],
              clone_forks: onceForks("once-prior"),
            }),
          },
        ],
        "design-doc": [{ type: "emit", envelope: okEnvelope("design-ok") }],
        "implementation-plan": [
          { type: "emit", envelope: okEnvelope("impl-ok") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.priors.get("design-doc")?.summary).toBe("once-prior");
    expect(agent.priors.get("implementation-plan")?.summary).toBe(
      "clarify-summary",
    );
  });
});

describe("clone fan-out parallel mint (U3 / AE1)", () => {
  it("starts three overlapping clone instances with list priors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-ae1-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", [
                "clone-1",
                "clone-2",
                "clone-3",
              ]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1") },
        ],
        "design-doc~2": [
          { type: "gate", gate, envelope: okEnvelope("d2") },
        ],
        "design-doc~3": [
          { type: "gate", gate, envelope: okEnvelope("d3") },
        ],
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

    await waitFor(() => agent.maxConcurrent >= 2);
    expect(agent.maxConcurrent).toBeGreaterThanOrEqual(2);
    release();

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
    expect(agent.openCounts.get("design-doc") ?? 0).toBe(0);
    expect(agent.priors.get("design-doc~1")?.summary).toBe("clone-1");
    expect(agent.priors.get("design-doc~2")?.summary).toBe("clone-2");
    expect(agent.priors.get("design-doc~3")?.summary).toBe("clone-3");
    expect(agent.openCounts.get("join-doc")).toBe(1);
    const joinPriors = agent.priorEnvelopes.get("join-doc");
    expect(joinPriors?.map((e) => e.summary)).toEqual(["d1", "d2", "d3"]);
  });

  it("process-mode launcher overlaps clone ~1 and ~2", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-proc-"));
    const dummy = { openStage: vi.fn(), runStage: vi.fn() };
    const { prepared, store } = await prepareInprocessPipeline(
      root,
      "clone-fanout-join",
      dummy,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const launch = vi.fn(
      async ({
        runId,
        stageId,
      }: {
        runId: string;
        stageId: string;
      }) => {
        if (stageId === "clarify") {
          await store.writeEnvelope(
            runId,
            stageId,
            okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          );
          return { type: "succeeded" as const };
        }
        if (stageId === "design-doc~1" || stageId === "design-doc~2") {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await gate;
          concurrent -= 1;
        }
        await store.writeEnvelope(runId, stageId, okEnvelope(stageId));
        return { type: "succeeded" as const };
      },
    );
    const mockLauncher = { launch } as unknown as StageProcessLauncher;
    const runPromise = runPipelineDag({
      prepared,
      maxActiveStagesPerRun: 3,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });
    await waitFor(() => maxConcurrent >= 2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    release();
    const result = await runPromise;
    expect(result.outcome).toBe("succeeded");
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "design-doc~1" }),
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: "design-doc~2" }),
    );
  });

  it("cap 2 with N=3 still opens all three clones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-cap2-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1") },
        ],
        "design-doc~2": [
          { type: "gate", gate, envelope: okEnvelope("d2") },
        ],
        "design-doc~3": [
          { type: "gate", gate, envelope: okEnvelope("d3") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 2,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(() => agent.maxConcurrent === 2);
    expect(agent.maxConcurrent).toBe(2);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
  });

  it("sequential stub holds ~2 while ~1 runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-seq-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("sequential", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1") },
        ],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
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

    await waitFor(() => (agent.openCounts.get("design-doc~1") ?? 0) >= 1);
    expect(agent.openCounts.get("design-doc~2") ?? 0).toBe(0);
    release();
    await waitFor(() => (agent.openCounts.get("design-doc~2") ?? 0) >= 1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("second fanout of an already-instanced catalog id fails closed", async () => {
    const dummy = { openStage: vi.fn(), runStage: vi.fn() };
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-unique-"));
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: snapshot,
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "throw", message: "must not mint twice" }],
        "design-doc~2": [{ type: "throw", message: "must not mint twice" }],
      },
    });
    const metaBefore = await store.readRunMeta(run.runId);
    expect(metaBefore.pipeline_dag?.stage_ids).toContain("design-doc~1");
    expect(metaBefore.pipeline_dag?.stage_ids).not.toContain("design-doc");
    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("failed");
    const detail = await store.readRun(run.runId);
    expect(detail.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "failed",
    );
    expect(agent.openCounts.get("design-doc~1") ?? 0).toBe(0);
  });
});

describe("clone fan-out join gate (U4)", () => {
  it("join opens after a parallel clone failure; run outcome is failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-join-fail-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "fail", reason: "clone 2 boom" }],
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
      return meta.status === "failed";
    });

    expect(agent.openCounts.get("join-doc")).toBe(1);
    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
    const joinPriors = agent.priorEnvelopes.get("join-doc");
    expect(joinPriors).toHaveLength(3);
    expect(joinPriors?.[1]?.status).toBe("failure");
    const detail = await store.readRun(started.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc~1")?.status).toBe(
      "succeeded",
    );
    expect(detail.stages.find((s) => s.stage_id === "design-doc~3")?.status).toBe(
      "succeeded",
    );
  });

  it("queued clone still starts after a sibling failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-queued-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2", "c3"]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1"), fail: true },
        ],
        "design-doc~2": [
          { type: "gate", gate, envelope: okEnvelope("d2") },
        ],
        "design-doc~3": [{ type: "emit", envelope: okEnvelope("d3") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      maxActiveStagesPerRun: 2,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(() => agent.maxConcurrent >= 2);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("hydrate of mixed clone failure starts join without halt-skip", async () => {
    const dummyFail = instanceKeyedAgent({
      behaviorsByStage: {
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-hydrate-join-"));
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: task.id,
      pipelineDag: snapshot,
    });
    const clarifyEnvelope = okEnvelope("clarify-ok", {
      clone_forks: fanoutForks("parallel", ["c1", "c2"]),
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", clarifyEnvelope);
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.ensureStageWorkspace(run.runId, "design-doc~1");
    await store.createStageExecution(run.runId, "design-doc~1");
    await store.appendStageEvent(run.runId, "design-doc~1", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc~1", {
      event: "failed",
      reason: "boom",
    });
    await store.writeEnvelope(run.runId, "design-doc~1", failEnvelope("boom"));
    await store.ensureStageWorkspace(run.runId, "design-doc~2");
    await store.createStageExecution(run.runId, "design-doc~2");
    await store.writeEnvelope(run.runId, "design-doc~2", okEnvelope("d2"));
    await store.appendStageEvent(run.runId, "design-doc~2", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc~2", {
      event: "succeeded",
    });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run: { runId: run.runId, workspaceDir: run.workspaceDir },
        agent: dummyFail,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(result.outcome).toBe("failed");
    expect(dummyFail.openCounts.get("join-doc")).toBe(1);
    expect(dummyFail.openCounts.get("design-doc~1") ?? 0).toBe(0);
  });
});

describe("clone fan-out mix (U6 / AE6)", () => {
  it("named sibling starts with the first clone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-mix-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: ["implementation-plan"],
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1") },
        ],
        "design-doc~2": [
          { type: "gate", gate, envelope: okEnvelope("d2") },
        ],
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
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(
      () =>
        (agent.openCounts.get("implementation-plan") ?? 0) >= 1 &&
        (agent.openCounts.get("design-doc~1") ?? 0) >= 1 &&
        agent.maxConcurrent >= 2,
    );
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);
    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("fork subset omitting clonable id still applies clone_forks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-mix-omit-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              fork_choice: ["implementation-plan"],
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [{ type: "emit", envelope: okEnvelope("d1") }],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "implementation-plan": [
          { type: "emit", envelope: okEnvelope("impl") },
        ],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("design-doc~1")).toBe(1);
    expect(agent.openCounts.get("implementation-plan")).toBe(1);
  });

  it("sequential apply does not hold the named sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-seq-mix-"));
    const store = createRunStore({ rootDir: root });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = instanceKeyedAgent({
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
        "design-doc~1": [
          { type: "gate", gate, envelope: okEnvelope("d1") },
        ],
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
      maxActiveStagesPerRun: 4,
    });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-mix"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(
      () =>
        (agent.openCounts.get("implementation-plan") ?? 0) >= 1 &&
        (agent.openCounts.get("design-doc~1") ?? 0) >= 1,
    );
    expect(agent.openCounts.get("design-doc~2") ?? 0).toBe(0);
    release();
    await waitFor(() => (agent.openCounts.get("design-doc~2") ?? 0) >= 1);
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });
});

describe("clone fan-out HITL and retry (U7)", () => {
  it("HITL-open clone blocks join until the clone is terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-hitl-"));
    const store = createRunStore({ rootDir: root });
    const prompt = {
      kind: "free_text" as const,
      id: "clone-hitl",
      message: "Need clone input?",
    };
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [
          {
            type: "wait_then_emit",
            waitRequests: [prompt],
            envelope: okEnvelope("d1"),
          },
        ],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join-ok") }],
      },
    });
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-join"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc~1")?.status ===
        "waiting_for_input"
      );
    });
    expect(agent.openCounts.get("join-doc") ?? 0).toBe(0);

    const delivered = await manager.deliverAnswer(started.runId, "design-doc~1", {
      promptId: "clone-hitl",
      kind: "free_text",
      text: "go",
    });
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("join-doc")).toBe(1);
  });

  it("retry of a failed clone keeps join closed until the new attempt terminals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-retry-"));
    const store = createRunStore({ rootDir: root });
    let releaseRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const agent = instanceKeyedAgent({
      behaviorsByStage: {
        clarify: [
          {
            type: "emit",
            envelope: okEnvelope("clarify-ok", {
              clone_forks: fanoutForks("parallel", ["c1", "c2"]),
            }),
          },
        ],
        "design-doc~1": [
          { type: "fail", reason: "first attempt failed" },
          { type: "gate", gate: retryGate, envelope: okEnvelope("d1-retry") },
        ],
        "design-doc~2": [{ type: "emit", envelope: okEnvelope("d2") }],
        "join-doc": [
          { type: "emit", envelope: okEnvelope("join-ok") },
          { type: "emit", envelope: okEnvelope("join-retry") },
        ],
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
    expect(agent.openCounts.get("join-doc")).toBe(1);
    expect(agent.priorEnvelopes.get("join-doc")?.[0]?.status).toBe("failure");

    const retryPromise = manager.retryStage(started.runId, "design-doc~1");
    await waitFor(() => (agent.openCounts.get("design-doc~1") ?? 0) >= 2);
    expect(agent.openCounts.get("join-doc")).toBe(1);
    releaseRetry();
    const retry = await retryPromise;
    expect(retry.ok).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
    expect(agent.openCounts.get("join-doc")).toBe(2);
    expect(agent.priorEnvelopes.get("join-doc")?.[0]?.summary).toBe("d1-retry");
  }, 15000);
});

describe("applyCloneForksFromEnvelopes", () => {
  it("re-applies skip without launching", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), {
      cwd: fixtures,
    });
    const dag = buildPipelineDagSnapshotFromLoaded(loaded);
    const states = new Map<string, StageScheduleState>(
      dag.nodes.map((n) => [n.id, "pending"]),
    );
    states.set("clarify", "succeeded");
    const completed = new Map<string, StageEnvelope>([
      ["clarify", okEnvelope("clarify-ok", { clone_forks: skipForks() })],
    ]);
    const next = await applyCloneForksFromEnvelopes(dag, states, completed);
    expect(states.get("design-doc")).toBe("skipped");
    expect(states.get("join-doc")).toBe("skipped");
    await applyCloneForksFromEnvelopes(next.dag, states, completed);
    expect(states.get("design-doc")).toBe("skipped");
  });
});
