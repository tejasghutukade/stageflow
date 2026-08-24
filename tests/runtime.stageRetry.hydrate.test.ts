import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { collectDownstreamClosure, collectDownstreamStageIds } from "../src/runtime/dagTraversal.js";
import {
  applyRetryRootDelta,
  hydrateScheduleForRetry,
  hydrateScheduleForRetryRoots,
} from "../src/runtime/pipelineScheduler.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

async function seedStageStatus(
  store: Awaited<ReturnType<typeof createRunStore>>,
  runId: string,
  stageId: string,
  status: "succeeded" | "failed" | "skipped",
) {
  if (status === "succeeded") {
    await store.createStageExecution(runId, stageId);
    await store.appendStageEvent(runId, stageId, { event: "started" });
    await store.writeEnvelope(runId, stageId, {
      status: "success",
      summary: stageId,
      artifacts: [],
    });
    await store.appendStageEvent(runId, stageId, { event: "succeeded" });
    return;
  }
  await store.appendStageEvent(runId, stageId, { event: "started" });
  await store.appendStageEvent(runId, stageId, {
    event: "failed",
    reason: `${stageId} failed`,
  });
}

describe("hydrateScheduleForRetry", () => {
  it("linear A→B→C: retry B resets B and C to pending, A succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hydrate-linear-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("linear-explicit", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetry(
      store,
      run.runId,
      loaded.dag,
      "design-doc",
    );

    expect(hydrated.schedulingHalted).toBe(false);
    expect(hydrated.firstFailureReason).toBeUndefined();
    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("pending");
    expect(hydrated.completedEnvelopes.has("design-doc")).toBe(false);
  });

  it("A→(B,C)→D fan-out: retry B resets B and D only, C succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hydrate-fanout-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await seedStageStatus(store, run.runId, "implementation-plan", "succeeded");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetry(
      store,
      run.runId,
      loaded.dag,
      "design-doc",
    );

    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("succeeded");
    expect(hydrated.states.get("join-doc")).toBe("pending");
    expect(hydrated.completedEnvelopes.has("implementation-plan")).toBe(true);
  });

  it("both branches failed: retry B leaves C failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hydrate-both-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await seedStageStatus(store, run.runId, "implementation-plan", "failed");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetry(
      store,
      run.runId,
      loaded.dag,
      "design-doc",
    );

    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("failed");
    expect(hydrated.states.get("join-doc")).toBe("pending");
  });
});

describe("hydrateScheduleForRetryRoots", () => {
  it("AE2 regression: single failed root leaves succeeded sibling sticky", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hydrate-multi-ae2-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await seedStageStatus(store, run.runId, "implementation-plan", "succeeded");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetryRoots(
      store,
      run.runId,
      loaded.dag,
      ["design-doc"],
    );

    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("succeeded");
    expect(hydrated.states.get("join-doc")).toBe("pending");
    expect(hydrated.completedEnvelopes.has("implementation-plan")).toBe(true);
    expect(hydrated.completedEnvelopes.has("design-doc")).toBe(false);
  });

  it("two-root union downstream resets both branches and shared join", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hydrate-multi-union-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await seedStageStatus(store, run.runId, "implementation-plan", "failed");
    await seedStageStatus(store, run.runId, "join-doc", "skipped");
    await store.updateRunStatus(run.runId, "failed");

    const hydrated = await hydrateScheduleForRetryRoots(
      store,
      run.runId,
      loaded.dag,
      ["design-doc", "implementation-plan"],
    );

    expect(hydrated.schedulingHalted).toBe(false);
    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("pending");
    expect(hydrated.states.get("join-doc")).toBe("pending");
    expect(hydrated.completedEnvelopes.has("clarify")).toBe(true);
    expect(hydrated.completedEnvelopes.has("design-doc")).toBe(false);
    expect(hydrated.completedEnvelopes.has("implementation-plan")).toBe(false);
    expect(hydrated.completedEnvelopes.has("join-doc")).toBe(false);
  });
});

describe("collectDownstreamStageIds", () => {
  it("walks childrenOf transitive closure", async () => {
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const downstream = collectDownstreamStageIds(loaded.dag, "design-doc");
    expect(downstream.has("join-doc")).toBe(true);
    expect(downstream.has("implementation-plan")).toBe(false);
  });
});

describe("collectDownstreamClosure", () => {
  it("unions downstream closures for multiple roots", async () => {
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const downstream = collectDownstreamClosure(loaded.dag, [
      "design-doc",
      "implementation-plan",
    ]);
    expect(downstream.has("join-doc")).toBe(true);
    expect(downstream.has("design-doc")).toBe(false);
    expect(downstream.has("implementation-plan")).toBe(false);
  });
});

describe("applyRetryRootDelta", () => {
  it("Hydrate join AE: mid-loop addRoot resets branch without touching succeeded sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-delta-join-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("parallel-retry-fanout", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");
    await seedStageStatus(store, run.runId, "implementation-plan", "failed");

    const hydrated = await hydrateScheduleForRetryRoots(
      store,
      run.runId,
      loaded.dag,
      ["design-doc"],
    );
    hydrated.states.set("design-doc", "active");

    const retryRoots = new Map([["design-doc", 2]]);
    applyRetryRootDelta(
      loaded.dag,
      hydrated.states,
      hydrated.completedEnvelopes,
      retryRoots,
      "implementation-plan",
      2,
    );

    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("active");
    expect(hydrated.states.get("implementation-plan")).toBe("pending");
    expect(hydrated.states.get("join-doc")).toBe("pending");
    expect(hydrated.completedEnvelopes.has("clarify")).toBe(true);
    expect(hydrated.completedEnvelopes.has("implementation-plan")).toBe(false);
    expect(retryRoots.get("implementation-plan")).toBe(2);
  });

  it("preserves active stage inside delta reset closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-delta-active-closure-"));
    const store = createRunStore({ rootDir: root });
    const loaded = await loadPipeline("linear-explicit", { cwd: fixtures });
    const run = await store.createRun({
      pipelineId: loaded.pipeline.id,
      taskYaml: "id: t\ngoal: g\n",
      pipelineDag: {
        ...loaded.dag,
        stage_ids: loaded.dag.nodes.map((n) => n.id),
      },
    });

    await seedStageStatus(store, run.runId, "clarify", "succeeded");
    await seedStageStatus(store, run.runId, "design-doc", "failed");

    const hydrated = await hydrateScheduleForRetry(
      store,
      run.runId,
      loaded.dag,
      "design-doc",
    );
    hydrated.states.set("implementation-plan", "active");

    const retryRoots = new Map([["design-doc", 2]]);
    applyRetryRootDelta(
      loaded.dag,
      hydrated.states,
      hydrated.completedEnvelopes,
      retryRoots,
      "design-doc",
      2,
    );

    expect(hydrated.states.get("clarify")).toBe("succeeded");
    expect(hydrated.states.get("design-doc")).toBe("pending");
    expect(hydrated.states.get("implementation-plan")).toBe("active");
    expect(hydrated.completedEnvelopes.has("clarify")).toBe(true);
    expect(hydrated.completedEnvelopes.has("implementation-plan")).toBe(false);
    expect(retryRoots.get("design-doc")).toBe(2);
  });
});
