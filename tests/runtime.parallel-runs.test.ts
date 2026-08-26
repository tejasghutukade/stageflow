import { describe, expect, it, vi } from "vitest";
import { FIXTURES_ROOT, pipelinePath, catalogLocators, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeHitlResumePath,
  scriptedFakeAgent,
} from "../src/agent/fakeAgent.js";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type { RunStore } from "../src/runstore/port.js";
import { RunManager } from "../src/runtime/runManager.js";
import { PipelineValidationError } from "../src/runtime/pipelineRunner.js";
import {
  bindRunWorkspaceEnv,
  buildStageRoots,
} from "../src/runtime/stageRoots.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function gatedAgent(gate: Promise<void>) {
  return {
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
}

/** Mirrors PiAdapter: bind for bound stages and hold until handle close (incl. HITL wait). */
function withBoundWorkspaceEnvBind(base: AgentPort): AgentPort {
  return {
    openStage(input: StageRunInput) {
      const restore =
        input.roots.mode === "bound"
          ? bindRunWorkspaceEnv(input.roots.runWorkspaceDir)
          : undefined;
      const handle = base.openStage(input);
      return {
        ...handle,
        async close() {
          try {
            await handle.close();
          } finally {
            restore?.();
          }
        },
      };
    },
    runStage(input: StageRunInput) {
      return base.runStage(input);
    },
  };
}

async function waitUntilIdle(manager: RunManager): Promise<void> {
  while (manager.getActiveCount() > 0) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout waiting for condition");
}

describe("parallel pipeline runs (U1)", () => {
  it("max=2: two unbound concurrent starts ok; third is busy_capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-cap-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 2,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first" },
    });
    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "b", goal: "second" },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const third = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "c", goal: "third" },
    });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.status).toBe(409);
      expect(third.code).toBe("busy_capacity");
      expect(third.activeCount).toBe(2);
      expect(third.maxConcurrent).toBe(2);
      expect(third.activeRunIds).toEqual(
        expect.arrayContaining([first.runId, second.runId]),
      );
      expect(third.activeRunIds).toHaveLength(2);
    }

    release();
    await waitUntilIdle(manager);
  });

  it("same-checkout second start fails with busy_checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-co-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 3,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first", checkout },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "b", goal: "second", checkout },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe("busy_checkout");
      expect(second.conflictingRunId).toBe(first.runId);
      expect(second.conflictingCheckout).toBeTruthy();
      expect(second.activeCount).toBe(1);
      expect(second.maxConcurrent).toBe(3);
      expect(second.activeRunIds).toEqual([first.runId]);
    }

    const otherCheckout = await mkdtemp(path.join(tmpdir(), "sf-checkout-b-"));
    const peer = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "c", goal: "peer", checkout: otherCheckout },
    });
    expect(peer.ok).toBe(true);

    release();
    await waitUntilIdle(manager);
  });

  it("HITL waiting run still counts toward soft max", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-wait-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: {
          status: "success",
          summary: "ok",
          artifacts: [],
        },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "2", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "3", artifacts: [] },
      },
    ]);
    const manager = new RunManager({
      agent,
      cwd: fixtures,
      store,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      task: SAMPLE_TASK,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const detail = await store.readRun(first.runId);
      const clarify = detail.stages.find((s) => s.stage_id === "clarify");
      if (clarify?.status === "waiting_for_input") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const waiting = await store.readRun(first.runId);
    expect(
      waiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(manager.getActiveCount()).toBe(1);

    const second = await manager.startRun({
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      task: { id: "blocked", goal: "should not start" },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("busy_capacity");
      expect(second.activeRunIds).toContain(first.runId);
    }

    await manager.deliverAnswer(first.runId, "clarify", "approved");
    await waitUntilIdle(manager);
  });

  it("rerun obeys soft max and checkout lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-rerun-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-r-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 2,
    });

    const source = await store.createRun({
      pipelineId: "docs-only",
      pipelinePath: DOCS_ONLY_PIPELINE,
      taskYaml: `id: snap\ngoal: from copy\ncheckout: ${checkout}\n`,
      taskId: "snap",
      checkoutRoot: checkout,
    });

    const active = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "holder", goal: "holds lease", checkout },
    });
    expect(active.ok).toBe(true);

    const rerunBusy = await manager.rerun(source.runId);
    expect(rerunBusy.ok).toBe(false);
    if (!rerunBusy.ok) {
      expect(rerunBusy.code).toBe("busy_checkout");
      expect(rerunBusy.conflictingRunId).toBe(
        active.ok ? active.runId : undefined,
      );
    }

    release();
    await waitUntilIdle(manager);

    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const manager2 = new RunManager({
      agent: gatedAgent(gate2),
      cwd: fixtures,
      store,
      maxConcurrent: 1,
    });
    const holder = await manager2.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "other", goal: "other checkout" },
    });
    expect(holder.ok).toBe(true);

    const rerunCap = await manager2.rerun(source.runId);
    expect(rerunCap.ok).toBe(false);
    if (!rerunCap.ok) {
      expect(rerunCap.code).toBe("busy_capacity");
    }

    release2();
    await waitUntilIdle(manager2);
  });

  it("failed start after reserve releases checkout lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-fail-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-f-"));
    const store = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([]),
      cwd: fixtures,
      store,
      maxConcurrent: 2,
    });

    await expect(
      manager.startRun({
        pipeline: "no-such-pipeline-xyz",
        task: { id: "boom", goal: "fail after reserve", checkout },
      }),
    ).rejects.toBeInstanceOf(PipelineValidationError);
    expect(manager.getActiveCount()).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager2 = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 2,
    });
    const peer = await manager2.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "peer", goal: "takes freed lease", checkout },
    });
    expect(peer.ok).toBe(true);

    release();
    await waitUntilIdle(manager2);
  });
});

describe("parallel pipeline runs (U2 bound env)", () => {
  it("F8: HITL-waiting bound run allows peer bound stage on other checkout without env throw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-f8-"));
    const checkoutA = await mkdtemp(path.join(tmpdir(), "sf-checkout-a-"));
    const checkoutB = await mkdtemp(path.join(tmpdir(), "sf-checkout-b-"));
    const store = createRunStore({ rootDir: root });
    const opened: string[] = [];
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input-a"],
        envelope: {
          status: "success",
          summary: "a-ok",
          artifacts: [],
        },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "b1", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "b2", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "b3", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "a2", artifacts: [] },
      },
      {
        type: "emit",
        envelope: { status: "success", summary: "a3", artifacts: [] },
      },
    ]);
    const agent = withBoundWorkspaceEnvBind({
      openStage(input) {
        opened.push(`${input.roots.checkoutRoot ?? "unbound"}:${input.stage.id}`);
        return base.openStage(input);
      },
      runStage(input) {
        return base.runStage(input);
      },
    });
    const manager = new RunManager({
      agent,
      cwd: fixtures,
      store,
      maxConcurrent: 3,
    });

    const first = await manager.startRun({
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      task: { id: "a", goal: "bound-a", checkout: checkoutA },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(first.runId);
      return (
        detail.stages.find((s) => s.stage_id === "clarify")?.status ===
        "waiting_for_input"
      );
    });

    const second = await manager.startRun({
      pipeline: LINEAR_EXPLICIT_PIPELINE,
      task: { id: "b", goal: "bound-b", checkout: checkoutB },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(second.runId);
      return detail.status === "succeeded";
    });

    expect(
      opened.some((o) => o.startsWith(`${checkoutA}:`)),
    ).toBe(true);
    expect(
      opened.some((o) => o.startsWith(`${checkoutB}:`)),
    ).toBe(true);

    const sameCheckout = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "c", goal: "same-as-a", checkout: checkoutA },
    });
    expect(sameCheckout.ok).toBe(false);
    if (!sameCheckout.ok) {
      expect(sameCheckout.code).toBe("busy_checkout");
      expect(sameCheckout.conflictingRunId).toBe(first.runId);
    }

    await manager.deliverAnswer(first.runId, "clarify", "approved");
    await waitUntilIdle(manager);
  });
});

const successEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

async function seedWaitingRun(
  store: RunStore,
  opts: {
    taskId: string;
    checkout?: string;
    pipelineId?: string;
  },
): Promise<{ runId: string; workspaceDir: string }> {
  const checkout = opts.checkout;
  const taskYaml =
    checkout !== undefined
      ? `id: ${opts.taskId}\ngoal: wait\ncheckout: ${checkout}\n`
      : `id: ${opts.taskId}\ngoal: wait\n`;
  const pipelineId = opts.pipelineId ?? "single";
  const locators = catalogLocators(pipelineId);
  const run = await store.createRun({
    pipelineId: locators.pipelineId,
    pipelinePath: locators.pipelinePath,
    taskYaml,
    taskId: opts.taskId,
    checkoutRoot: checkout,
  });
  await store.ensureStageWorkspace(run.runId, "clarify");
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  const resumePath = fakeHitlResumePath(
    buildStageRoots(run.workspaceDir, "clarify", checkout),
    "clarify",
  );
  await writeFile(
    resumePath,
    `${JSON.stringify({
      waitRequests: ["need-input"],
      envelope: successEnvelope,
      waitIndex: 1,
    })}\n`,
    "utf8",
  );
  await store.appendStageEvent(run.runId, "clarify", {
    event: "waiting_for_input",
  });
  return run;
}

async function seedIntraRunMultiWait(
  store: RunStore,
  opts: { taskId: string },
): Promise<{ runId: string; workspaceDir: string }> {
  const taskYaml = `id: ${opts.taskId}\ngoal: wait\n`;
  const locators = catalogLocators("parallel-hitl-multi-wait");
  const run = await store.createRun({
    pipelineId: locators.pipelineId,
    pipelinePath: locators.pipelinePath,
    taskYaml,
    taskId: opts.taskId,
  });
  const roots = buildStageRoots(run.workspaceDir, "clarify");
  await store.ensureStageWorkspace(run.runId, "clarify");
  await store.createStageExecution(run.runId, "clarify");
  await store.writeEnvelope(run.runId, "clarify", successEnvelope);
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
  for (const stageId of ["branch-a", "branch-b"] as const) {
    await store.ensureStageWorkspace(run.runId, stageId);
    await store.appendStageEvent(run.runId, stageId, { event: "started" });
    const resumePath = fakeHitlResumePath(roots, stageId);
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: [`need-input-${stageId}`],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, stageId, {
      event: "waiting_for_input",
    });
  }
  return run;
}

describe("parallel pipeline runs (U4 attach + multi-wait)", () => {
  it("attach two waiters: both active; answer one leaves other waiting; lease blocks same checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-u4-attach-"));
    const checkoutA = await mkdtemp(path.join(tmpdir(), "sf-checkout-u4a-"));
    const checkoutB = await mkdtemp(path.join(tmpdir(), "sf-checkout-u4b-"));
    const store = createRunStore({ rootDir: root });
    const runA = await seedWaitingRun(store, {
      taskId: "a",
      checkout: checkoutA,
    });
    const runB = await seedWaitingRun(store, {
      taskId: "b",
      checkout: checkoutB,
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });

    const attached = await manager.attachWaitingStages();
    expect(attached).toEqual(
      expect.arrayContaining([
        { runId: runA.runId, stageId: "clarify" },
        { runId: runB.runId, stageId: "clarify" },
      ]),
    );
    expect(attached).toHaveLength(2);
    expect(manager.getActiveCount()).toBe(2);
    expect(manager.getActiveRunIds()).toEqual(
      expect.arrayContaining([runA.runId, runB.runId]),
    );

    const sameAsA = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "peer-a", goal: "same as A", checkout: checkoutA },
    });
    expect(sameAsA.ok).toBe(false);
    if (!sameAsA.ok) {
      expect(sameAsA.code).toBe("busy_checkout");
      expect(sameAsA.conflictingRunId).toBe(runA.runId);
    }

    const delivered = await manager.deliverAnswer(
      runA.runId,
      "clarify",
      "answer-a",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store2.readRun(runA.runId);
      return detail.status === "succeeded";
    });

    const stillB = await store2.readRun(runB.runId);
    expect(stillB.status).toBe("running");
    expect(
      stillB.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(manager.getActiveRunIds()).toContain(runB.runId);

    const sameAsB = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "peer-b", goal: "same as B", checkout: checkoutB },
    });
    expect(sameAsB.ok).toBe(false);
    if (!sameAsB.ok) {
      expect(sameAsB.code).toBe("busy_checkout");
      expect(sameAsB.conflictingRunId).toBe(runB.runId);
    }
  });

  it("over-max attach still registers leases; deliverAnswer works; start is busy_capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-u4-overmax-"));
    const checkoutA = await mkdtemp(path.join(tmpdir(), "sf-checkout-om-a-"));
    const checkoutB = await mkdtemp(path.join(tmpdir(), "sf-checkout-om-b-"));
    const store = createRunStore({ rootDir: root });
    const runA = await seedWaitingRun(store, {
      taskId: "a",
      checkout: checkoutA,
    });
    const runB = await seedWaitingRun(store, {
      taskId: "b",
      checkout: checkoutB,
    });

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const attached = await manager.attachWaitingStages();
    expect(attached).toHaveLength(2);
    expect(manager.getActiveCount()).toBe(2);

    const overCap = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "new", goal: "blocked by capacity" },
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) {
      expect(overCap.code).toBe("busy_capacity");
      expect(overCap.activeCount).toBe(2);
      expect(overCap.maxConcurrent).toBe(1);
    }

    const delivered = await manager.deliverAnswer(
      runA.runId,
      "clarify",
      "answer-a",
    );
    expect(delivered.ok).toBe(true);
    await waitFor(async () => {
      const detail = await store2.readRun(runA.runId);
      return detail.status === "succeeded";
    });

    const stillB = await store2.readRun(runB.runId);
    expect(
      stillB.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(manager.getActiveRunIds()).toContain(runB.runId);

    const stillCap = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "still", goal: "still at max with B waiting" },
    });
    expect(stillCap.ok).toBe(false);
    if (!stillCap.ok) {
      expect(stillCap.code).toBe("busy_capacity");
      expect(stillCap.activeRunIds).toEqual([runB.runId]);
    }
  });
  it("duplicate checkout_root among attached waiters: fail-closed one lease-holder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-u4-dup-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-dup-"));
    const store = createRunStore({ rootDir: root });
    const runFirst = await seedWaitingRun(store, {
      taskId: "first",
      checkout,
    });
    const runDup = await seedWaitingRun(store, {
      taskId: "dup",
      checkout,
    });

    const store2 = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: ["need-input"],
          envelope: successEnvelope,
        },
      ]),
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });

    const attached = await manager.attachWaitingStages();
    expect(attached).toHaveLength(1);
    const keeperId = attached[0]!.runId;
    expect([runFirst.runId, runDup.runId]).toContain(keeperId);
    const quarantinedId =
      keeperId === runFirst.runId ? runDup.runId : runFirst.runId;
    expect(manager.getActiveRunIds()).toEqual([keeperId]);

    const dupDetail = await store2.readRun(quarantinedId);
    expect(dupDetail.status).toBe("failed");
    const dupClarify = dupDetail.stages.find((s) => s.stage_id === "clarify")!;
    expect(dupClarify.status).toBe("failed");
    expect(
      dupClarify.events.some(
        (e) =>
          e.event === "failed" &&
          "reason" in e &&
          String(e.reason).includes("duplicate_checkout"),
      ),
    ).toBe(true);

    const conflict = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "peer", goal: "same checkout", checkout },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("busy_checkout");
      expect(conflict.conflictingRunId).toBe(keeperId);
    }

    const answerDup = await manager.deliverAnswer(
      quarantinedId,
      "clarify",
      "should-fail",
    );
    expect(answerDup.ok).toBe(false);
  });

  it("health activeCount matches activeRunIds length (includes provisionals)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-health-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 2,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first" },
    });
    expect(first.ok).toBe(true);

    const health = manager.getHealth();
    expect(health.activeCount).toBe(health.activeRunIds.length);
    expect(health.activeCount).toBe(manager.getActiveCount());
    expect(health.activeRunIds).toHaveLength(1);

    release();
    await waitUntilIdle(manager);
  });

  it("attach intra-run multi-wait: both branch waiters registered for one run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-intra-attach-"));
    const store = createRunStore({ rootDir: root });
    const run = await seedIntraRunMultiWait(store, { taskId: "intra" });

    const store2 = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent: scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: ["need-input-branch-a"],
          envelope: successEnvelope,
        },
        {
          type: "wait_then_emit",
          waitRequests: ["need-input-branch-b"],
          envelope: successEnvelope,
        },
      ]),
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });

    const attached = await manager.attachWaitingStages();
    expect(attached).toEqual(
      expect.arrayContaining([
        { runId: run.runId, stageId: "branch-a" },
        { runId: run.runId, stageId: "branch-b" },
      ]),
    );
    expect(attached).toHaveLength(2);
    expect(manager.getActiveCount()).toBe(1);
    expect(manager.getActiveRunIds()).toEqual([run.runId]);
  });

  it("overlapping restart deliverAnswer for same stageId is rejected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-overlap-"));
    const store = createRunStore({ rootDir: root });
    const run = await seedWaitingRun(store, { taskId: "overlap" });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const agent: AgentPort = {
      openStage(input) {
        const handle = base.openStage(input);
        return {
          ...handle,
          async next() {
            await gate;
            return handle.next();
          },
        };
      },
      runStage(input) {
        return base.runStage(input);
      },
    };

    const store2 = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent,
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });
    await manager.attachWaitingStages();

    const first = manager.deliverAnswer(run.runId, "clarify", "answer-1");
    const second = await manager.deliverAnswer(
      run.runId,
      "clarify",
      "answer-2",
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.reason).toMatch(/Resume already in progress/i);
    }

    releaseGate();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("different stageId waiters in same run may deliver concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-diff-stage-"));
    const store = createRunStore({ rootDir: root });
    const run = await seedIntraRunMultiWait(store, { taskId: "diff-stage" });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const base = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input-branch-a"],
        envelope: successEnvelope,
      },
      {
        type: "wait_then_emit",
        waitRequests: ["need-input-branch-b"],
        envelope: successEnvelope,
      },
      { type: "emit", envelope: successEnvelope },
    ]);
    const agent: AgentPort = {
      openStage(input) {
        const handle = base.openStage(input);
        if (input.stage.id !== "branch-a") {
          return handle;
        }
        return {
          ...handle,
          async next() {
            await gate;
            return handle.next();
          },
        };
      },
      runStage(input) {
        return base.runStage(input);
      },
    };

    const store2 = createRunStore({ rootDir: root });
    const manager = new RunManager({
      agent,
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });
    await manager.attachWaitingStages();

    const first = manager.deliverAnswer(run.runId, "branch-a", "answer-a");
    const second = await manager.deliverAnswer(
      run.runId,
      "branch-b",
      "answer-b",
    );
    expect(second.ok).toBe(true);

    releaseGate();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store2.readRun(run.runId);
      return detail.status === "succeeded";
    });
  });

  it("restart deliverAnswer without attach re-acquires lease; conflict fails closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-resume-lease-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-checkout-rl-"));
    const store = createRunStore({ rootDir: root });
    const waiting = await seedWaitingRun(store, {
      taskId: "waiter",
      checkout,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RunManager({
      agent: gatedAgent(gate),
      cwd: fixtures,
      store,
      maxConcurrent: 3,
    });

    const holder = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "holder", goal: "holds lease", checkout },
    });
    expect(holder.ok).toBe(true);

    const resumed = await manager.deliverAnswer(
      waiting.runId,
      "clarify",
      "should-block",
    );
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(409);
      expect(resumed.reason).toMatch(/duplicate_checkout_resume/);
    }
    expect(manager.getActiveRunIds()).not.toContain(waiting.runId);

    const stillWaiting = await store.readRun(waiting.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");

    release();
    await waitUntilIdle(manager);
  });

  it("attach then reconcile: waiting runs stay attached; orphaned stages reconciled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-par-attach-reconcile-"));
    const checkoutA = await mkdtemp(path.join(tmpdir(), "sf-checkout-ar-a-"));
    const store = createRunStore({ rootDir: root });
    const runWaiting = await seedWaitingRun(store, {
      taskId: "waiter",
      checkout: checkoutA,
    });

    const runOrphan = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: orphan\ngoal: stuck\n",
      taskId: "orphan",
    });
    await store.appendStageEvent(runOrphan.runId, "clarify", {
      event: "started",
    });
    await store.updateRunStatus(runOrphan.runId, "running");

    const store2 = createRunStore({ rootDir: root });
    const agent2 = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: successEnvelope,
      },
    ]);
    const manager = new RunManager({
      agent: agent2,
      store: store2,
      cwd: fixtures,
      maxConcurrent: 3,
    });

    const attached = await manager.attachWaitingStages();
    const reconciled = await manager.reconcileOrphanedStages();

    expect(attached).toEqual([
      { runId: runWaiting.runId, stageId: "clarify" },
    ]);
    expect(reconciled.reconciled).toEqual([
      {
        runId: runOrphan.runId,
        stageId: "clarify",
        reason: "process_interrupted: no active worker (server restart)",
      },
    ]);
    expect(manager.getActiveRunIds()).toContain(runWaiting.runId);
    expect(manager.getActiveRunIds()).not.toContain(runOrphan.runId);

    const orphanDetail = await store2.readRun(runOrphan.runId);
    expect(orphanDetail.status).toBe("failed");
    expect(
      orphanDetail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("failed");

    const stillWaiting = await store2.readRun(runWaiting.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");

    const delivered = await manager.deliverAnswer(
      runWaiting.runId,
      "clarify",
      "after-attach-reconcile",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store2.readRun(runWaiting.runId);
      return detail.status === "succeeded";
    });
  });
});

function createCliEquivalentManager(opts: {
  agent: ReturnType<typeof gatedAgent> | AgentPort;
  store: RunStore;
  cwd: string;
  maxConcurrent: number;
}): RunManager {
  return new RunManager({
    agent: opts.agent,
    store: opts.store,
    cwd: opts.cwd,
    operatorCatalog: { cwd: opts.cwd, agentDir: opts.cwd },
    maxConcurrent: opts.maxConcurrent,
  });
}

describe("CLI-equivalent startRun (S5)", () => {
  it("AE-S5-1: startRun then await done honors busy_capacity; no createRun on reject", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-s5-cap-"));
    const store = createRunStore({ rootDir: root });
    const createRunSpy = vi.spyOn(store, "createRun");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createCliEquivalentManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.done).toBeDefined();
    const createsAfterFirst = createRunSpy.mock.calls.length;
    expect(createsAfterFirst).toBeGreaterThan(0);

    let firstSettled = false;
    void first.done.then(() => {
      firstSettled = true;
    });

    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "b", goal: "second" },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe("busy_capacity");
      expect(second.reason).toMatch(/busy_capacity|Capacity full/i);
    }
    expect(createRunSpy).toHaveBeenCalledTimes(createsAfterFirst);
    expect(firstSettled).toBe(false);

    release();
    const pipeline = await first.done;
    expect(firstSettled).toBe(true);
    expect(pipeline.ok).toBe(true);
    expect(pipeline.runDir).toBeTruthy();
    await waitUntilIdle(manager);
  });

  it("AE-S5-2: startRun then await done honors busy_checkout; no createRun on reject", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-s5-co-"));
    const checkout = await mkdtemp(path.join(tmpdir(), "sf-s5-checkout-"));
    const store = createRunStore({ rootDir: root });
    const createRunSpy = vi.spyOn(store, "createRun");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createCliEquivalentManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 3,
    });

    const first = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "a", goal: "first" },
      checkoutOverride: checkout,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const createsAfterFirst = createRunSpy.mock.calls.length;

    const second = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "b", goal: "second" },
      checkoutOverride: checkout,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.code).toBe("busy_checkout");
      expect(second.conflictingCheckout).toBeTruthy();
      expect(second.conflictingRunId).toBe(first.runId);
    }
    expect(createRunSpy).toHaveBeenCalledTimes(createsAfterFirst);

    release();
    const pipeline = await first.done;
    expect(pipeline.ok).toBe(true);
    await waitUntilIdle(manager);
  });

  it("AE-S5-3: await done does not resolve before the pipeline finishes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-s5-block-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createCliEquivalentManager({
      agent: gatedAgent(gate),
      store,
      cwd: fixtures,
      maxConcurrent: 1,
    });

    const started = await manager.startRun({
      pipeline: pipelinePath("docs-only"),
      task: { id: "block", goal: "wait for release" },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let settled = false;
    const pending = started.done.then((pipeline) => {
      settled = true;
      return pipeline;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);

    release();
    const pipeline = await pending;
    expect(settled).toBe(true);
    expect(pipeline.ok).toBe(true);
    expect(pipeline.runDir).toBeTruthy();
    await waitUntilIdle(manager);
  });
});
