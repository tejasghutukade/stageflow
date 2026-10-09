import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { stageStatusFromEvents } from "../src/runstore/port.js";
import {
  appendCloneInstances,
  buildPipelineDagSnapshotFromLoaded,
} from "../src/runstore/pipelineDagSnapshot.js";
import {
  hydrateScheduleForRetry,
  hydrateScheduleForRetryRoots,
  hydrateScheduleFromStore,
  hydratedScheduleHasRunnableWork,
  runPipelineDag,
} from "../src/runtime/pipelineScheduler.js";
import { shouldReopenSkippedStage } from "../src/runtime/reopenSkipped.js";
import { RunManager } from "../src/runtime/runManager.js";
import { syncRunStatusFromStages } from "../src/runtime/stageRecovery.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { okEnvelope } from "./helpers/envelopes.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";
import { stageKeyedAgent } from "./helpers/stageKeyedAgent.js";
import { waitFor } from "./helpers/waitFor.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

async function seedSucceeded(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  stageId: string,
  overlay?: Partial<StageEnvelope>,
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" });
  await store.writeEnvelope(runId, stageId, {
    status: "success",
    summary: stageId,
    artifacts: [],
    payload: {},
    ...overlay,
  });
  await store.appendStageEvent(runId, stageId, { event: "succeeded" });
}

async function seedSkipped(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  stageId: string,
) {
  await store.appendStageEvent(runId, stageId, { event: "skipped" });
}

async function seedFailed(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  stageId: string,
) {
  await store.createStageExecution(runId, stageId);
  await store.appendStageEvent(runId, stageId, { event: "started" });
  await store.appendStageEvent(runId, stageId, {
    event: "failed",
    reason: "boom",
  });
}

const unexpectedOpen = {
  type: "throw" as const,
  message: "unexpected stage open",
};

async function createRunFor(
  store: ReturnType<typeof createRunStore>,
  pipelineName: string,
) {
  const loaded = await loadPipeline(pipelinePath(pipelineName), {
    cwd: fixtures,
  });
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml: "id: t\ngoal: g\n",
    pipelineDag: {
      ...loaded.dag,
      stage_ids: loaded.dag.nodes.map((n) => n.id),
    },
  });
  return { loaded, run };
}

const linearParentChildDag = {
  nodes: [
    { id: "a", needs: null, needsEdges: [], ancestors: [], stageIndex: 0 },
    {
      id: "b",
      needs: "a",
      needsEdges: [{ id: "a", on: ["succeeded" as const] }],
      ancestors: ["a"],
      stageIndex: 1,
    },
  ],
  roots: ["a"],
  childrenOf: { a: ["b"], b: [] },
};

describe("shouldReopenSkippedStage", () => {
  const okA = new Map<string, StageEnvelope>([["a", okEnvelope("ok")]]);
  const aSucceededBSkipped = new Map([
    ["a", "succeeded" as const],
    ["b", "skipped" as const],
  ]);

  it.each([
    {
      name: "cascade-skipped child whose parent succeeded and has not started",
      states: aSucceededBSkipped,
      envelopes: okA,
      alreadyStarted: false,
      expected: true,
    },
    {
      name: "skipped stage that already started",
      states: aSucceededBSkipped,
      envelopes: okA,
      alreadyStarted: true,
      expected: false,
    },
    {
      name: "superseded clone instance",
      states: aSucceededBSkipped,
      envelopes: okA,
      alreadyStarted: false,
      options: { supersededCloneIds: new Set(["b"]) },
      expected: false,
    },
    {
      name: "child whose parent failed",
      states: new Map([
        ["a", "failed" as const],
        ["b", "skipped" as const],
      ]),
      envelopes: new Map([["a", okEnvelope("boom", { status: "failure" })]]),
      alreadyStarted: false,
      expected: false,
    },
    {
      name: "child whose parent is itself skipped",
      states: new Map([
        ["a", "skipped" as const],
        ["b", "skipped" as const],
      ]),
      envelopes: new Map<string, StageEnvelope>(),
      alreadyStarted: false,
      expected: false,
    },
  ])("$name: reopen=$expected", ({ states, envelopes, alreadyStarted, options, expected }) => {
    expect(
      shouldReopenSkippedStage(
        linearParentChildDag,
        "b",
        states,
        envelopes,
        alreadyStarted,
        options,
      ),
    ).toBe(expected);
  });
});

describe("hydrateScheduleFromStore cascade skip", () => {
  it("reopens only the next cascade-skipped stage in a linear chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-chain-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "linear-explicit");

    await seedSucceeded(store, run.runId, "clarify");
    await seedSkipped(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "succeeded");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydrated.states.get("design-doc")).toBe("pending");
    const designEvents = await store.listStageEvents(run.runId, "design-doc");
    expect(stageStatusFromEvents(designEvents)).toBe("pending");
    expect(designEvents.map((e) => e.event)).toContain("reopened");

    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    const implEvents = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(stageStatusFromEvents(implEvents)).toBe("skipped");
    expect(implEvents.map((e) => e.event)).not.toContain("reopened");
    expect(hydratedScheduleHasRunnableWork(hydrated)).toBe(true);

    await seedSucceeded(store, run.runId, "design-doc");
    const hydratedAgain = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydratedAgain.states.get("implementation-plan")).toBe("pending");
    const implAfter = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(stageStatusFromEvents(implAfter)).toBe("pending");
    expect(implAfter.map((e) => e.event)).toContain("reopened");
  });

  it("does not reopen a cascade-skipped child while the parent is failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-failed-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "linear-explicit");

    await seedSucceeded(store, run.runId, "clarify");
    await seedFailed(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    const events = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(stageStatusFromEvents(events)).toBe("skipped");
    expect(events.map((e) => e.event)).not.toContain("reopened");
    expect(hydrated.schedulingHalted).toBe(true);
    expect(hydratedScheduleHasRunnableWork(hydrated)).toBe(false);
  });

  it("hydrate is idempotent: a second hydrate does not append another reopened", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-idemp-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "linear-explicit");

    await seedSucceeded(store, run.runId, "clarify");
    await seedSucceeded(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "succeeded");

    await hydrateScheduleFromStore(store, run.runId, loaded.dag);
    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    const events = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(events.filter((e) => e.event === "reopened")).toHaveLength(1);
    expect(stageStatusFromEvents(events)).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("pending");
  });

  it("reopens the chosen fork child and leaves the unchosen child skipped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-fork-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline(pipelinePath("fork-route-allow-none"), {
      cwd: fixtures,
    });
    const clarify = loaded.dag.nodes.find((n) => n.id === "clarify");
    if (clarify) {
      clarify.fork = { select: "subset", allow_none: true };
    }
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedSucceeded(store, run.runId, "clarify", {
      fork_choice: ["design-doc"],
    });
    await seedSkipped(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydrated.states.get("design-doc")).toBe("pending");
    const designEvents = await store.listStageEvents(run.runId, "design-doc");
    expect(stageStatusFromEvents(designEvents)).toBe("pending");
    expect(designEvents.map((e) => e.event)).toContain("reopened");

    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    const implEvents = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(stageStatusFromEvents(implEvents)).toBe("skipped");
    expect(implEvents.map((e) => e.event)).not.toContain("reopened");
  });

  it("reopens an ungated sibling but not an if-miss gated sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-if-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "route-if-eq");

    await seedSucceeded(store, run.runId, "triage", {
      payload: { severity: "low" },
    });
    await seedSkipped(store, run.runId, "page");
    await seedSkipped(store, run.runId, "notify");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydrated.states.get("notify")).toBe("pending");
    const notifyEvents = await store.listStageEvents(run.runId, "notify");
    expect(stageStatusFromEvents(notifyEvents)).toBe("pending");
    expect(notifyEvents.map((e) => e.event)).toContain("reopened");

    expect(hydrated.states.get("page")).toBe("skipped");
    const pageEvents = await store.listStageEvents(run.runId, "page");
    expect(stageStatusFromEvents(pageEvents)).toBe("skipped");
    expect(pageEvents.map((e) => e.event)).not.toContain("reopened");
  });

  it("does not reopen a skipped successor that already started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-started-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "linear-explicit");

    await seedSucceeded(store, run.runId, "clarify");
    await seedSucceeded(store, run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "implementation-plan", {
      event: "started",
    });
    await store.appendStageEvent(run.runId, "implementation-plan", {
      event: "skipped",
    });
    await store.updateRunStatus(run.runId, "succeeded");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );

    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    const events = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(events.map((e) => e.event)).not.toContain("reopened");
    expect(stageStatusFromEvents(events)).toBe("skipped");
  });
});

describe("hydrateScheduleForRetry cascade skip", () => {
  it("persists reopened on skipped downstream of the retry root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-hydrate-retry-"));
    const store = createRunStore({ rootDir: root });
    const { loaded, run } = await createRunFor(store, "linear-explicit");

    await seedSucceeded(store, run.runId, "clarify");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc", {
      event: "failed",
      reason: "boom",
    });
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetry(
      store,
      run.runId,
      loaded.dag,
      "design-doc",
    );

    expect(hydrated.states.get("implementation-plan")).toBe("pending");
    const events = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(stageStatusFromEvents(events)).toBe("pending");
    expect(events.map((e) => e.event)).toContain("reopened");
  });
});

describe("resume after premature succeeded+skipped", () => {
  it("runPipelineDag after hydrate runs a cascade-skipped successor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-run-dag-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("linear-explicit"), {
      cwd: fixtures,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: "sample",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedSucceeded(store, run.runId, "clarify");
    await seedSucceeded(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "succeeded");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );
    await syncRunStatusFromStages(store, run.runId);
    expect((await store.readRunMeta(run.runId)).status).toBe("running");

    const agent = stageKeyedAgent({
      clarify: [{ type: "throw", message: "should not open clarify" }],
      "design-doc": [{ type: "throw", message: "should not open design-doc" }],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("implementation-plan") },
      ],
    }, { fallback: unexpectedOpen });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run,
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      initialSchedule: hydrated,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    const detail = await store.readRun(run.runId);
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");
    expect(impl?.status).toBe("succeeded");
    const names = impl?.events.map((e) => e.event) ?? [];
    expect(names.indexOf("reopened")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("started")).toBeGreaterThan(names.indexOf("reopened"));
  });

  it("runPipelineDag reopens a skipped successor of a parent that was still pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-live-success-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
    const loaded = await loadPipeline(pipelinePath("linear-explicit"), {
      cwd: fixtures,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: "sample",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedSucceeded(store, run.runId, "clarify");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "running");

    const hydrated = await hydrateScheduleFromStore(
      store,
      run.runId,
      loaded.dag,
    );
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("skipped");
    const implBefore = await store.listStageEvents(
      run.runId,
      "implementation-plan",
    );
    expect(implBefore.map((e) => e.event)).not.toContain("reopened");

    const agent = stageKeyedAgent({
      clarify: [{ type: "throw", message: "should not open clarify" }],
      "design-doc": [{ type: "emit", envelope: okEnvelope("design-doc") }],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("implementation-plan") },
      ],
    }, { fallback: unexpectedOpen });

    const result = await runPipelineDag({
      prepared: {
        task,
        loaded,
        run,
        agent,
        store,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      initialSchedule: hydrated,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    const detail = await store.readRun(run.runId);
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");
    expect(impl?.status).toBe("succeeded");
    const names = impl?.events.map((e) => e.event) ?? [];
    expect(names.indexOf("reopened")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("started")).toBeGreaterThan(names.indexOf("reopened"));
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    expect(design?.events.filter((e) => e.event === "started")).toHaveLength(1);
  });

  it("resumeStalledSchedules launches a reopened successor on a previously succeeded run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-reopen-resume-stalled-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(SAMPLE_TASK, "utf8");
    const loaded = await loadPipeline(pipelinePath("linear-explicit"), {
      cwd: fixtures,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml,
      taskId: "sample",
      pipelinePath: pipelinePath("linear-explicit"),
      taskPath: SAMPLE_TASK,
      projectRoot: fixtures,
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedSucceeded(store, run.runId, "clarify");
    await seedSucceeded(store, run.runId, "design-doc");
    await seedSkipped(store, run.runId, "implementation-plan");
    await store.updateRunStatus(run.runId, "succeeded");

    await hydrateScheduleFromStore(store, run.runId, loaded.dag);
    await syncRunStatusFromStages(store, run.runId);
    expect((await store.readRunMeta(run.runId)).status).toBe("running");

    const agent = stageKeyedAgent({
      clarify: [{ type: "throw", message: "should not open clarify" }],
      "design-doc": [{ type: "throw", message: "should not open design-doc" }],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("implementation-plan") },
      ],
    }, { fallback: unexpectedOpen });
    const manager = new RunManager({ agent, store, cwd: fixtures });
    const resumed = await manager.resumeStalledSchedules();
    expect(resumed.map((entry) => entry.runId)).toContain(run.runId);

    await waitFor(async () => {
      const meta = await store.readRunMeta(run.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(run.runId);
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");
    expect(impl?.status).toBe("succeeded");
  });
});

describe("hydrateScheduleForRetryRoots superseded clones", () => {
  it("does not re-pend clones from a superseded generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-superseded-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline(pipelinePath("clone-chain-smallest"), {
      cwd: fixtures,
    });
    const frozen = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(frozen, {
      catalogId: "handle-item",
      predecessorId: "emit-items",
      count: 2,
    });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: snapshot,
    });

    await seedSucceeded(store, run.runId, "emit-items");
    await seedSucceeded(store, run.runId, "handle-item~1");
    await seedSkipped(store, run.runId, "handle-item~1");
    await seedSucceeded(store, run.runId, "handle-item~2");
    await seedSkipped(store, run.runId, "handle-item~2");

    await store.createForkGeneration(run.runId, {
      generation_id: "gen-1",
      fork_parent_stage_id: "emit-items",
      generation_number: 1,
      clone_stage_ids: ["handle-item~1", "handle-item~2"],
    });
    await store.updateForkGeneration(run.runId, "gen-1", {
      status: "superseded",
    });

    const hydrated = await hydrateScheduleForRetryRoots(
      store,
      run.runId,
      snapshot,
      ["emit-items"],
    );

    expect(hydrated.states.get("emit-items")).toBe("pending");
    expect(hydrated.states.get("handle-item~1")).toBe("skipped");
    expect(hydrated.states.get("handle-item~2")).toBe("skipped");
  });
});
