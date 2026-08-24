import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHitlResumePath, scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  createCompletedOnlyStageHandle,
  type AgentPort,
  type StageRunInput,
} from "../src/agent/port.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { stageStatusFromEvents } from "../src/runstore/port.js";
import { RunManager } from "../src/runtime/runManager.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  failStageAsInterrupted,
  syncRunStatusFromStages,
} from "../src/runtime/stageRecovery.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const successEnvelope = {
  status: "success" as const,
  summary: "done",
  artifacts: [] as string[],
};

const STARTUP_RECONCILE_REASON =
  "process_interrupted: no active worker (server restart)";

const OPERATOR_ABANDON_REASON =
  "process_interrupted: operator abandoned stage";

function okEnvelope(summary: string) {
  return { status: "success" as const, summary, artifacts: [] as string[] };
}

function failEnvelope(summary: string) {
  return { status: "failure" as const, summary, artifacts: [] as string[] };
}

function hangingStageHandle() {
  return {
    async next() {
      await new Promise<void>(() => {});
      throw new Error("unreachable");
    },
    async close() {},
  };
}

function parallelFanoutStuckDesignAgent(
  retryBehaviors: {
    design: Parameters<typeof scriptedFakeAgent>[0];
    impl: Parameters<typeof scriptedFakeAgent>[0];
  },
): AgentPort & { openCounts: Map<string, number> } {
  const clarifyAgent = scriptedFakeAgent([
    { type: "emit", envelope: okEnvelope("clarify-ok") },
  ]);
  const designRetryAgent = scriptedFakeAgent(retryBehaviors.design);
  const implAgent = scriptedFakeAgent([
    { type: "emit", envelope: failEnvelope("impl-fail") },
    ...retryBehaviors.impl,
  ]);
  const joinAgent = scriptedFakeAgent([
    { type: "emit", envelope: okEnvelope("join-ok") },
  ]);
  const openCounts = new Map<string, number>();
  let designOpens = 0;

  return {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);

      if (stageId === "clarify") {
        return clarifyAgent.openStage(input);
      }
      if (stageId === "design-doc") {
        designOpens += 1;
        if (designOpens === 1) {
          return hangingStageHandle();
        }
        return designRetryAgent.openStage(input);
      }
      if (stageId === "implementation-plan") {
        return implAgent.openStage(input);
      }
      if (stageId === "join-doc") {
        return joinAgent.openStage(input);
      }
      throw new Error(`unknown stage ${stageId}`);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
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

function agentWithHangingFirstDesign(retryBehaviors: Parameters<
  typeof scriptedFakeAgent
>[0]): AgentPort {
  const clarifyAgent = scriptedFakeAgent([
    { type: "emit", envelope: okEnvelope("clarify-ok") },
  ]);
  const retryAgent = scriptedFakeAgent(retryBehaviors);
  let designOpens = 0;
  return {
    openStage(input: StageRunInput) {
      if (input.stage.id === "clarify") {
        return clarifyAgent.openStage(input);
      }
      if (input.stage.id === "design-doc") {
        designOpens += 1;
        if (designOpens === 1) {
          return {
            async next() {
              await new Promise<void>(() => {});
              throw new Error("unreachable");
            },
            async close() {},
          };
        }
        return retryAgent.openStage(input);
      }
      return retryAgent.openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

function reconcileAgent() {
  return scriptedFakeAgent([
    { type: "emit", envelope: successEnvelope },
  ]);
}

const kinds = ["sqlite"] as const;

describe.each(kinds)("runtime stage recovery (%s)", (kind) => {
  it("failStageAsInterrupted appends failed after started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-recovery-fail-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await failStageAsInterrupted({
      store,
      runId: run.runId,
      stageId: "build",
      reason: "process_interrupted: no active worker (server restart)",
    });

    const events = await store.listStageEvents(run.runId, "build");
    expect(stageStatusFromEvents(events)).toBe("failed");
    expect(events.some((e) => e.event === "failed")).toBe(true);
  });

  it("failStageAsInterrupted patches execution row finished_at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-recovery-exec-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.createStageExecution(run.runId, "build");
    await store.appendStageEvent(
      run.runId,
      "build",
      { event: "started" },
      { attempt: 1 },
    );
    await failStageAsInterrupted({
      store,
      runId: run.runId,
      stageId: "build",
      reason: "process_interrupted: no active worker (server restart)",
    });

    const execution = await store.getStageExecution(run.runId, "build", 1);
    expect(execution.status).toBe("failed");
    expect(execution.finished_at).toBeDefined();
  });

  it("syncRunStatusFromStages sets run failed when stage failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sf-recovery-sync-${kind}-`));
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await failStageAsInterrupted({
      store,
      runId: run.runId,
      stageId: "build",
      reason: "process_interrupted: no active worker (server restart)",
    });
    await store.updateRunStatus(run.runId, "running");

    await syncRunStatusFromStages(store, run.runId);

    const meta = await store.readRunMeta(run.runId);
    expect(meta.status).toBe("failed");
    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
  });

  it("syncRunStatusFromStages settles mixed retry outcomes to failed run status", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-retry-settle-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "parallel-retry-fanout",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await store.appendStageEvent(
      run.runId,
      "design-doc",
      { event: "failed", reason: "design-fail-2" },
      { attempt: 2 },
    );
    await store.appendStageEvent(
      run.runId,
      "implementation-plan",
      { event: "started" },
      { attempt: 2 },
    );
    await store.appendStageEvent(
      run.runId,
      "implementation-plan",
      { event: "succeeded" },
      { attempt: 2 },
    );
    await store.updateRunStatus(run.runId, "running");

    await syncRunStatusFromStages(store, run.runId);

    const meta = await store.readRunMeta(run.runId);
    expect(meta.status).toBe("failed");
    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
  });
});

describe.each(kinds)("runtime stage recovery reconcile (%s)", (kind) => {
  it("AE1: started without terminal reconciles to failed run", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-ae1-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.reconcileOrphanedStages();

    expect(result.reconciled).toEqual([
      {
        runId: run.runId,
        stageId: "build",
        reason: STARTUP_RECONCILE_REASON,
      },
    ]);

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(detail.stages.find((s) => s.stage_id === "build")?.status).toBe(
      "failed",
    );
  });

  it("AE2: waiting_for_input stage is not reconciled", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-ae2-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: t\ngoal: g\n",
    });
    const roots = buildStageRoots(run.workspaceDir, "clarify");
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(roots, "clarify");
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
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.reconcileOrphanedStages();

    expect(result.reconciled).toEqual([]);
    const detail = await store.readRun(run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(detail.status).toBe("running");
  });

  it("AE3: parallel sibling succeeded; only running stage fails", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-ae3-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "parallel-after-clarify",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc", {
      event: "succeeded",
    });
    await store.appendStageEvent(run.runId, "implementation-plan", {
      event: "started",
    });
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.reconcileOrphanedStages();

    expect(result.reconciled).toEqual([
      {
        runId: run.runId,
        stageId: "implementation-plan",
        reason: STARTUP_RECONCILE_REASON,
      },
    ]);

    const detail = await store.readRun(run.runId);
    expect(detail.stages.find((s) => s.stage_id === "design-doc")?.status).toBe(
      "succeeded",
    );
    expect(
      detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("failed");
    expect(detail.status).toBe("failed");
  });

  it("attachWaitingStages still works when reconcile follows", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-attach-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: t\ngoal: g\n",
    });
    const roots = buildStageRoots(run.workspaceDir, "clarify");
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(roots, "clarify");
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
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: scriptedFakeAgent([
        {
          type: "wait_then_emit",
          waitRequests: ["need-input"],
          envelope: successEnvelope,
        },
      ]),
      store,
      cwd: fixtures,
    });
    const attached = await manager.attachWaitingStages();
    await manager.reconcileOrphanedStages();

    expect(attached).toEqual([{ runId: run.runId, stageId: "clarify" }]);

    const stillWaiting = await store.readRun(run.runId);
    expect(
      stillWaiting.stages.find((s) => s.stage_id === "clarify")?.status,
    ).toBe("waiting_for_input");
    expect(stillWaiting.status).toBe("running");

    const delivered = await manager.deliverAnswer(
      run.runId,
      "clarify",
      "after-reconcile",
    );
    expect(delivered.ok).toBe(true);

    const done = await store.readRun(run.runId);
    expect(done.status).toBe("succeeded");
    expect(done.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "succeeded",
    );
  });

  it("AE6: retryStage rejected for waiting_for_input after reconcile", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-ae6-elig-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "parallel-hitl-fork",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });

    const designRoots = buildStageRoots(run.workspaceDir, "design-doc");
    await store.ensureStageWorkspace(run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await writeFile(
      fakeHitlResumePath(designRoots, "design-doc"),
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: successEnvelope,
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "design-doc", {
      event: "waiting_for_input",
    });

    await store.appendStageEvent(run.runId, "implementation-plan", {
      event: "started",
    });
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    await manager.reconcileOrphanedStages();

    const detail = await store.readRun(run.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("waiting_for_input");
    expect(
      detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("failed");
    expect(detail.status).toBe("failed");

    const retryWaiting = await manager.retryStage(run.runId, "design-doc");
    expect(retryWaiting.ok).toBe(false);
    if (!retryWaiting.ok) {
      expect(retryWaiting.status).toBe(409);
      expect(retryWaiting.reason).toMatch(/waiting for input/i);
    }
  });
});

describe.each(kinds)("runtime stage recovery abandon (%s)", (kind) => {
  it("AE4: abandon marks running stage and run failed", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-abandon-ae4-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.abandonStage(run.runId, "build");

    expect(result).toEqual({
      ok: true,
      runId: run.runId,
      stageId: "build",
    });

    const detail = await store.readRun(run.runId);
    expect(detail.status).toBe("failed");
    expect(detail.stages.find((s) => s.stage_id === "build")?.status).toBe(
      "failed",
    );
    const events = await store.listStageEvents(run.runId, "build");
    expect(events.some((e) => e.event === "failed")).toBe(true);
    expect(
      events.find((e) => e.event === "failed")?.reason,
    ).toBe(OPERATOR_ABANDON_REASON);
  });

  it("AE5: abandon cancels active stage process when present", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-abandon-ae5-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.updateRunStatus(run.runId, "running");

    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const mockLauncher = {
      getActiveStageProcesses: () => [
        { runId: run.runId, stageId: "build", startedAt: Date.now() },
      ],
      cancelRun,
      launch: vi.fn(),
      activeCount: () => 1,
    } as unknown as StageProcessLauncher;

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: mockLauncher,
    });
    const result = await manager.abandonStage(run.runId, "build");

    expect(result.ok).toBe(true);
    expect(cancelRun).toHaveBeenCalledWith(run.runId);

    const detail = await store.readRun(run.runId);
    expect(detail.stages.find((s) => s.stage_id === "build")?.status).toBe(
      "failed",
    );
  });

  it("returns 409 when stage is not running", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-abandon-409-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "docs-only",
      taskYaml: "id: t\ngoal: g\n",
    });

    await store.appendStageEvent(run.runId, "build", { event: "started" });
    await store.appendStageEvent(run.runId, "build", { event: "failed" });

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.abandonStage(run.runId, "build");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.reason).toMatch(/not running/i);
  });

  it("returns 409 when stage is waiting_for_input", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-abandon-wait-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const run = await store.createRun({
      pipelineId: "single",
      taskYaml: "id: t\ngoal: g\n",
    });
    const roots = buildStageRoots(run.workspaceDir, "clarify");
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(roots, "clarify");
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

    const manager = new RunManager({
      agent: reconcileAgent(),
      store,
      cwd: fixtures,
    });
    const result = await manager.abandonStage(run.runId, "clarify");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.reason).toMatch(/waiting for input/i);
  });

  it(
    "retryStage succeeds after abandon on stuck running stage",
    async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), `sf-recovery-abandon-retry-${kind}-`),
    );
    const store = createRunStore({ rootDir: root, kind });
    const agent = agentWithHangingFirstDesign([
      { type: "emit", envelope: okEnvelope("design-ok-retry") },
      { type: "emit", envelope: okEnvelope("plan-ok") },
    ]);
    const manager = new RunManager({ agent, store, cwd: fixtures });

    const started = await manager.startRun({
      task: path.join(fixtures, "tasks", "sample.yaml"),
      pipeline: "linear-explicit",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const design = detail.stages.find((s) => s.stage_id === "design-doc");
      return design?.status === "running";
    });

    const abandoned = await manager.abandonStage(started.runId, "design-doc");
    expect(abandoned.ok).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const retry = await manager.retryStage(started.runId, "design-doc");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("succeeded");
  },
    15000,
  );

  it(
    "AE5: abandon stuck stage then parallel retry on failed siblings",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), `sf-recovery-ae5-par-retry-${kind}-`),
      );
      const store = createRunStore({ rootDir: root, kind });
      const agent = parallelFanoutStuckDesignAgent({
        design: [{ type: "emit", envelope: okEnvelope("design-retry") }],
        impl: [{ type: "emit", envelope: okEnvelope("impl-retry") }],
      });
      const manager = new RunManager({ agent, store, cwd: fixtures });

      const started = await manager.startRun({
        task: path.join(fixtures, "tasks", "sample.yaml"),
        pipeline: "parallel-retry-fanout",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        const design = detail.stages.find((s) => s.stage_id === "design-doc");
        const impl = detail.stages.find(
          (s) => s.stage_id === "implementation-plan",
        );
        return design?.status === "running" && impl?.status === "failed";
      });

      const abandoned = await manager.abandonStage(
        started.runId,
        "design-doc",
      );
      expect(abandoned.ok).toBe(true);

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "failed";
      });

      const retryDesign = manager.retryStage(started.runId, "design-doc");
      await new Promise((r) => setTimeout(r, 50));
      const retryImpl = manager.retryStage(
        started.runId,
        "implementation-plan",
      );
      const [designResult, implResult] = await Promise.all([
        retryDesign,
        retryImpl,
      ]);
      expect(designResult.ok).toBe(true);
      expect(implResult.ok).toBe(true);

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "succeeded";
      });

      const detail = await store.readRun(started.runId);
      expect(
        detail.stages.find((s) => s.stage_id === "design-doc")?.status,
      ).toBe("succeeded");
      expect(
        detail.stages.find((s) => s.stage_id === "implementation-plan")
          ?.status,
      ).toBe("succeeded");
      expect(agent.openCounts.get("join-doc")).toBe(1);
    },
    15000,
  );
});

describe("runtime stage recovery abandon parallel interaction", () => {
  it(
    "abandon during parallel retry leaves sibling branch best-effort in-process",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "sf-recovery-abandon-sibling-"),
      );
      const store = createRunStore({ rootDir: root, kind: "sqlite" });
      let releaseDesign!: () => void;
      let releaseImpl!: () => void;
      const designGate = new Promise<void>((resolve) => {
        releaseDesign = resolve;
      });
      const implGate = new Promise<void>((resolve) => {
        releaseImpl = resolve;
      });
      let designOpens = 0;
      let implOpens = 0;

      const agent = {
        openStage(input: StageRunInput) {
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => {
              if (input.stage.id === "clarify") {
                return {
                  ok: true as const,
                  envelope: okEnvelope("clarify"),
                };
              }
              if (input.stage.id === "design-doc") {
                designOpens += 1;
                if (designOpens === 1) {
                  return { ok: false as const, reason: "design-fail" };
                }
                await designGate;
                return {
                  ok: true as const,
                  envelope: okEnvelope("design-retry"),
                };
              }
              if (input.stage.id === "implementation-plan") {
                implOpens += 1;
                if (implOpens === 1) {
                  return { ok: false as const, reason: "impl-fail" };
                }
                await implGate;
                return {
                  ok: true as const,
                  envelope: okEnvelope("impl-retry"),
                };
              }
              return {
                ok: true as const,
                envelope: okEnvelope(input.stage.id),
              };
            },
          });
        },
        async runStage(input: StageRunInput) {
          const handle = this.openStage(input);
          const event = await handle.next();
          await handle.close();
          if (event.status === "waiting_for_input") {
            return { ok: false, reason: "unexpected wait" };
          }
          return event.result;
        },
      };

      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: path.join(fixtures, "tasks", "sample.yaml"),
        pipeline: "parallel-retry-fanout",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        const design = detail.stages.find((s) => s.stage_id === "design-doc");
        const impl = detail.stages.find(
          (s) => s.stage_id === "implementation-plan",
        );
        return design?.status === "failed" && impl?.status === "failed";
      });

      const retryDesign = manager.retryStage(started.runId, "design-doc");
      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "running";
      });
      const retryImpl = manager.retryStage(
        started.runId,
        "implementation-plan",
      );

      await waitFor(async () => designOpens >= 2 && implOpens >= 2);

      const abandoned = await manager.abandonStage(
        started.runId,
        "design-doc",
      );
      expect(abandoned.ok).toBe(true);

      releaseImpl();
      await waitFor(async () => {
        const detail = await store.readRun(started.runId);
        return (
          detail.stages.find((s) => s.stage_id === "implementation-plan")
            ?.status === "succeeded"
        );
      });
      const implResult = await retryImpl;
      expect(implResult.ok).toBe(true);

      const designResult = await retryDesign;
      expect(designResult.ok).toBe(true);

      releaseDesign();

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "failed";
      });

      const detail = await store.readRun(started.runId);
      expect(
        detail.stages.find((s) => s.stage_id === "design-doc")?.status,
      ).toBe("failed");
      expect(
        detail.stages.find((s) => s.stage_id === "implementation-plan")
          ?.status,
      ).toBe("succeeded");
    },
    15000,
  );
});
