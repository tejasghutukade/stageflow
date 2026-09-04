import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  buildPipelineDagSnapshotFromLoaded,
  appendCloneInstances,
  instancesOfDefinition,
} from "../src/runstore/pipelineDagSnapshot.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import { retryRun } from "../src/runtime/pipelineScheduler.js";
import { loadRunContext } from "../src/runtime/resumeReconstruct.js";
import { syncRunStatusFromStages } from "../src/runtime/stageRecovery.js";
import {
  cloneFanoutConflict,
  cloneRetryDownstream,
} from "../src/runtime/cloneSchedule.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { CloneForkItem } from "../src/types/forkChoice.js";
import type { RunStore } from "../src/runstore/port.js";
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

function fanoutForks(summaries: string[]): CloneForkItem[] {
  return [
    {
      successor_id: "design-doc",
      action: "fanout",
      mode: "parallel",
      clones: summaries.map((summary) => ({ envelope: okEnvelope(summary) })),
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

/**
 * Retries a stage that has *already succeeded*, driving the scheduler
 * directly instead of through RunManager.retryStage. Reproducing this bug
 * requires retrying an ancestor above a fanout parent whose clone instances
 * already succeeded once — which by DAG causality can only happen after
 * that ancestor itself already succeeded. On `main` today,
 * assertStageRetryEligible (src/runtime/runRetryCoordinator.ts) only allows
 * retrying a stage whose *own* status is "failed" — retrying an
 * already-succeeded stage is handoff item 7 (succeeded-stage retry guard),
 * not landed here and out of scope for this fix. This helper exercises the
 * same scheduler mechanics (`retryRun`) that a real retry uses, bypassing
 * only that separate, unrelated eligibility policy.
 */
async function retryAncestorDirect(
  store: RunStore,
  agent: AgentPort,
  runId: string,
  stageId: string,
): Promise<void> {
  const execution = await store.createStageExecution(runId, stageId);
  const { meta, task, loaded, workspaceDir } = await loadRunContext(
    store,
    runId,
    fixtures,
  );
  await retryRun({
    prepared: {
      task,
      loaded,
      run: { runId, workspaceDir },
      agent,
      store,
      cwd: fixtures,
      checkoutRoot: meta.checkout_root,
    },
    retryRoots: new Map([[stageId, execution.attempt]]),
    maxActiveStagesPerRun: 4,
    executionMode: "inprocess",
  });
  // runPipelineDag skips the store.updateRunStatus persistence step whenever
  // a retryContext is present (RunRetryCoordinator normally reconciles this
  // itself in its .finally()); replicate that here since we're bypassing it.
  await syncRunStatusFromStages(store, runId);
}

function instanceKeyedAgent(
  behaviorsByStage: Record<
    string,
    Array<{ envelope: StageEnvelope }>
  >,
): AgentPort & { openCounts: Map<string, number> } {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const agent: AgentPort & { openCounts: Map<string, number> } = {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = schedulerStageId(input);
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index];
      if (!behavior) {
        throw new Error(`no behavior for ${stageId} attempt ${index + 1}`);
      }
      return createCompletedOnlyStageHandle({
        stageId,
        run: async () => ({ ok: true as const, envelope: behavior.envelope }),
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

describe("clone-fanout conflict on ancestor retry (regression)", () => {
  it("retrying an ancestor of a clone-fanout parent reactivates the fanout instead of stalling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-ancestor-retry-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      intake: [{ envelope: okEnvelope("intake-ok") }, { envelope: okEnvelope("intake-retry") }],
      clarify: [
        { envelope: okEnvelope("clarify-ok", { clone_forks: fanoutForks(["c1", "c2"]) }) },
        { envelope: okEnvelope("clarify-retry", { clone_forks: fanoutForks(["c1-retry", "c2-retry"]) }) },
      ],
      "design-doc~1": [{ envelope: okEnvelope("d1") }, { envelope: okEnvelope("d1-retry") }],
      "design-doc~2": [{ envelope: okEnvelope("d2") }, { envelope: okEnvelope("d2-retry") }],
      "join-doc": [{ envelope: okEnvelope("join-ok") }, { envelope: okEnvelope("join-retry") }],
    });
    const manager = new RunManager({ agent, store, cwd: fixtures, maxActiveStagesPerRun: 4 });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-retry-ancestor"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const before = await store.readRun(started.runId);
    expect(before.stages.find((s) => s.stage_id === "design-doc~1")?.attempt_count).toBe(1);

    await retryAncestorDirect(store, agent, started.runId, "intake");

    const meta = await store.readRunMeta(started.runId);
    // Today's bug: cloneFanoutConflict rejects clarify's fresh fanout because
    // design-doc~1/~2 already structurally exist, and the run stalls as
    // "failed" with the clone instances stuck at their stale attempt 1.
    // With the fix, the retry cascade resets those instances to pending,
    // the fresh fanout reactivates them, and the run succeeds again.
    expect(meta.status).toBe("succeeded");

    const detail = await store.readRun(started.runId);
    const d1 = detail.stages.find((s) => s.stage_id === "design-doc~1");
    const d2 = detail.stages.find((s) => s.stage_id === "design-doc~2");
    const join = detail.stages.find((s) => s.stage_id === "join-doc");
    expect(d1?.status).toBe("succeeded");
    expect(d1?.attempt_count).toBe(2);
    expect(d2?.status).toBe("succeeded");
    expect(d2?.attempt_count).toBe(2);
    expect(join?.status).toBe("succeeded");
    expect(join?.attempt_count).toBe(2);
    expect(agent.openCounts.get("design-doc~1")).toBe(2);
    expect(agent.openCounts.get("design-doc~2")).toBe(2);
    expect(agent.openCounts.get("join-doc")).toBe(2);
    // No phantom third instance minted.
    const meta2 = await store.readRunMeta(started.runId);
    expect(meta2.pipeline_dag?.stage_ids).not.toContain("design-doc~3");
  }, 15000);

  it("growing the clone count on retry reactivates prior instances and mints the extra one fresh", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-ancestor-grow-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      intake: [{ envelope: okEnvelope("intake-ok") }, { envelope: okEnvelope("intake-retry") }],
      clarify: [
        { envelope: okEnvelope("clarify-ok", { clone_forks: fanoutForks(["c1", "c2"]) }) },
        { envelope: okEnvelope("clarify-retry", { clone_forks: fanoutForks(["c1r", "c2r", "c3r"]) }) },
      ],
      "design-doc~1": [{ envelope: okEnvelope("d1") }, { envelope: okEnvelope("d1-retry") }],
      "design-doc~2": [{ envelope: okEnvelope("d2") }, { envelope: okEnvelope("d2-retry") }],
      "design-doc~3": [{ envelope: okEnvelope("d3-retry") }],
      "join-doc": [{ envelope: okEnvelope("join-ok") }, { envelope: okEnvelope("join-retry") }],
    });
    const manager = new RunManager({ agent, store, cwd: fixtures, maxActiveStagesPerRun: 4 });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-retry-ancestor"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    await retryAncestorDirect(store, agent, started.runId, "intake");
    expect((await store.readRunMeta(started.runId)).status).toBe("succeeded");

    const detail = await store.readRun(started.runId);
    const d1 = detail.stages.find((s) => s.stage_id === "design-doc~1");
    const d2 = detail.stages.find((s) => s.stage_id === "design-doc~2");
    const d3 = detail.stages.find((s) => s.stage_id === "design-doc~3");
    const join = detail.stages.find((s) => s.stage_id === "join-doc");
    expect(d1?.status).toBe("succeeded");
    expect(d1?.attempt_count).toBe(2);
    expect(d2?.status).toBe("succeeded");
    expect(d2?.attempt_count).toBe(2);
    expect(d3?.status).toBe("succeeded");
    expect(d3?.attempt_count).toBe(1);
    expect(join?.status).toBe("succeeded");
    expect(join?.attempt_count).toBe(2);
  }, 15000);

  it("shrinking the clone count on retry reactivates the kept instances and skips the rest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-ancestor-shrink-"));
    const store = createRunStore({ rootDir: root });
    const agent = instanceKeyedAgent({
      intake: [{ envelope: okEnvelope("intake-ok") }, { envelope: okEnvelope("intake-retry") }],
      clarify: [
        { envelope: okEnvelope("clarify-ok", { clone_forks: fanoutForks(["c1", "c2", "c3"]) }) },
        { envelope: okEnvelope("clarify-retry", { clone_forks: fanoutForks(["c1r"]) }) },
      ],
      "design-doc~1": [{ envelope: okEnvelope("d1") }, { envelope: okEnvelope("d1-retry") }],
      "design-doc~2": [{ envelope: okEnvelope("d2") }],
      "design-doc~3": [{ envelope: okEnvelope("d3") }],
      "join-doc": [{ envelope: okEnvelope("join-ok") }, { envelope: okEnvelope("join-retry") }],
    });
    const manager = new RunManager({ agent, store, cwd: fixtures, maxActiveStagesPerRun: 4 });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("clone-fanout-retry-ancestor"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitFor(async () => (await store.readRunMeta(started.runId)).status === "succeeded");

    await retryAncestorDirect(store, agent, started.runId, "intake");
    expect((await store.readRunMeta(started.runId)).status).toBe("succeeded");

    const detail = await store.readRun(started.runId);
    const d1 = detail.stages.find((s) => s.stage_id === "design-doc~1");
    const d2 = detail.stages.find((s) => s.stage_id === "design-doc~2");
    const d3 = detail.stages.find((s) => s.stage_id === "design-doc~3");
    const join = detail.stages.find((s) => s.stage_id === "join-doc");
    expect(d1?.status).toBe("succeeded");
    expect(d1?.attempt_count).toBe(2);
    expect(d2?.status).toBe("skipped");
    expect(d3?.status).toBe("skipped");
    expect(join?.status).toBe("succeeded");
    expect(join?.attempt_count).toBe(2);
    // The skipped siblings were never relaunched.
    expect(agent.openCounts.get("design-doc~2")).toBe(1);
    expect(agent.openCounts.get("design-doc~3")).toBe(1);
  }, 15000);
});

describe("cloneFanoutConflict (unit)", () => {
  it("rejects existing instances that were never touched by a retry (true duplicate case)", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), { cwd: fixtures });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const states = new Map<string, "pending">(
      instancesOfDefinition(snapshot, "design-doc").map((id) => [id, "pending" as const]),
    );
    const envelope = okEnvelope("clarify-ok", {
      clone_forks: fanoutForks(["c1", "c2"]),
    });
    const conflict = cloneFanoutConflict(snapshot, envelope, states, new Set());
    expect(conflict).toBe('clone fan-out for "design-doc" is already instanced');
  });

  it("allows existing instances that a retry cascade reset to pending", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), { cwd: fixtures });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const instanceIds = instancesOfDefinition(snapshot, "design-doc");
    const states = new Map<string, "pending">(instanceIds.map((id) => [id, "pending" as const]));
    const retryDownstreamIds = cloneRetryDownstream(snapshot, ["clarify"]);
    const envelope = okEnvelope("clarify-retry", {
      clone_forks: fanoutForks(["c1-retry", "c2-retry"]),
    });
    const conflict = cloneFanoutConflict(snapshot, envelope, states, retryDownstreamIds);
    expect(conflict).toBeUndefined();
  });

  it("still rejects when instances are active, even if downstream of a retry", async () => {
    const loaded = await loadPipeline(pipelinePath("clone-fanout-join"), { cwd: fixtures });
    const base = buildPipelineDagSnapshotFromLoaded(loaded);
    const { snapshot } = appendCloneInstances(base, {
      catalogId: "design-doc",
      predecessorId: "clarify",
      count: 2,
    });
    const instanceIds = instancesOfDefinition(snapshot, "design-doc");
    const states = new Map<string, "active" | "pending">([
      [instanceIds[0]!, "active"],
      [instanceIds[1]!, "pending"],
    ]);
    const retryDownstreamIds = cloneRetryDownstream(snapshot, ["clarify"]);
    const envelope = okEnvelope("clarify-retry", {
      clone_forks: fanoutForks(["c1-retry", "c2-retry"]),
    });
    const conflict = cloneFanoutConflict(snapshot, envelope, states, retryDownstreamIds);
    expect(conflict).toBe('clone fan-out for "design-doc" is already instanced');
  });
});
