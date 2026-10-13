import { describe, expect, it, vi } from "vitest";
import { pipelinePath, catalogLocators, SAMPLE_TASK } from "./helpers/fixturePaths.js";
import { okEnvelope, failEnvelope } from "./helpers/envelopes.js";
import { stageKeyedAgent } from "./helpers/stageKeyedAgent.js";
import { waitFor } from "./helpers/waitFor.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompletedOnlyStageHandle,
  type StagePort,
  type StageRunInput,
} from "../src/agent/port.js";
import {
  fakeHitlResumePath,
  scriptedFakeAgent,
} from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import type {
  RunDetail,
  RunStatus,
  StageSnapshot,
} from "../src/runstore/port.js";
import { RunManager } from "../src/runtime/runManager.js";
import {
  assertStageRetryEligible,
  DuplicateRetryRootError,
  RetryRootWaitTimeoutError,
  RunRetryCoordinator,
  succeededStageRetryBlocker,
  type RetryTrackingPort,
} from "../src/runtime/runRetryCoordinator.js";
import { loadRunContext } from "../src/runtime/resumeReconstruct.js";
import { startPipeline } from "../src/runtime/pipelineRunner.js";
import { reconstructAndContinue } from "../src/runtime/resumeReconstruct.js";
import * as credentialBinding from "../src/runtime/credentialBinding.js";
import {
  readMaxActiveStagesPerRun,
  readStageExecutionMode,
} from "../src/runtime/stageConcurrency.js";
import { StageHitlController } from "../src/runtime/stageHitl.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import {
  normalizePromptIds,
  parseAskOperatorParams,
} from "../src/tools/askOperator.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const hitlPrompt1 = normalizePromptIds(
  parseAskOperatorParams({
    id: "retry-hitl-prompt-1",
    kind: "free_text",
    message: "Need input attempt 1",
  }),
);

const hitlPrompt2 = normalizePromptIds(
  parseAskOperatorParams({
    id: "retry-hitl-prompt-2",
    kind: "free_text",
    message: "Need input attempt 2",
  }),
);

const STARTUP_RECONCILE_REASON = "orphaned_no_worker";

function eligibilityDetail(opts: {
  runStatus: RunStatus;
  stageId?: string;
  stageStatus?: StageSnapshot["status"];
  missingStage?: boolean;
  definitionId?: string;
  envelope?: StageEnvelope | null;
}): RunDetail {
  return {
    run_id: "run-1",
    pipeline_id: "p",
    status: opts.runStatus,
    created_at: "2026-01-01T00:00:00.000Z",
    binding: { kind: "unbound" },
    task_yaml: "",
    stages: opts.missingStage
      ? []
      : [
          {
            stage_id: opts.stageId ?? "design-doc",
            ...(opts.definitionId !== undefined
              ? { definition_id: opts.definitionId }
              : {}),
            status: opts.stageStatus ?? "failed",
            events: [],
            envelope: opts.envelope ?? null,
            artifacts: [],
            attempt_count: 1,
          },
        ],
    pipeline_track: { nodes: [], edges: [] },
    feedback_loops: [],
  };
}

function recordingTracking(): RetryTrackingPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ensureResumeTracked() {
      calls.push("ensure");
      return { ok: true, insertedForResume: true };
    },
    onOrchestrationStarted() {
      calls.push("started");
    },
    async rollbackStartTracking() {
      calls.push("rollback");
    },
  };
}

async function seedLinearReconcilableRun(
  store: ReturnType<typeof createRunStore>,
) {
  const taskYaml = await readFile(
    SAMPLE_TASK,
    "utf8",
  );
  const run = await store.createRun({
    ...catalogLocators("linear-explicit"),
    taskYaml,
    taskId: "sample",
  });
  await store.ensureStageWorkspace(run.runId, "clarify");
  await store.createStageExecution(run.runId, "clarify");
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
  await store.writeEnvelope(run.runId, "clarify", okEnvelope("clarify-ok"));
  await store.ensureStageWorkspace(run.runId, "design-doc");
  await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
  await store.updateRunStatus(run.runId, "running");
  return run;
}

async function createRetryExecution(
  store: ReturnType<typeof createRunStore>,
  runId: string,
  stageId: string,
) {
  const existingAttempts = await store.countStageAttempts(runId, stageId);
  if (existingAttempts === 0) {
    await store.createStageExecution(runId, stageId);
  }
  return store.createStageExecution(runId, stageId);
}

async function startRetryCoordinator(opts: {
  store: ReturnType<typeof createRunStore>;
  runId: string;
  agent: StagePort;
  roots: Map<string, number>;
  onLoopTick?: () => Promise<void>;
  coordinator?: RunRetryCoordinator;
}): Promise<RunRetryCoordinator> {
  const { meta, task, loaded, workspaceDir } = await loadRunContext(
    opts.store,
    opts.runId,
    fixtures,
  );
  const coordinator = opts.coordinator ?? new RunRetryCoordinator();
  coordinator.start({
    runId: opts.runId,
    roots: opts.roots,
    prepared: {
      task,
      loaded,
      run: { runId: opts.runId, workspaceDir },
      agent: opts.agent,
      store: opts.store,
      cwd: fixtures,
      checkoutRoot: meta.checkout_root,
    },
    maxActiveStagesPerRun: readMaxActiveStagesPerRun(process.env),
    executionMode: readStageExecutionMode(process.env),
    ...(opts.onLoopTick !== undefined ? { onLoopTick: opts.onLoopTick } : {}),
  });
  return coordinator;
}

async function seedParallelReconcilableRun(
  store: ReturnType<typeof createRunStore>,
) {
  const taskYaml = await readFile(
    SAMPLE_TASK,
    "utf8",
  );
  const run = await store.createRun({
    ...catalogLocators("parallel-retry-fanout"),
    taskYaml,
    taskId: "sample",
  });
  await store.ensureStageWorkspace(run.runId, "clarify");
  await store.createStageExecution(run.runId, "clarify");
  await store.appendStageEvent(run.runId, "clarify", { event: "started" });
  await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
  await store.writeEnvelope(run.runId, "clarify", okEnvelope("clarify-ok"));
  await store.ensureStageWorkspace(run.runId, "design-doc");
  await store.createStageExecution(run.runId, "design-doc");
  await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
  await store.appendStageEvent(run.runId, "design-doc", { event: "succeeded" });
  await store.writeEnvelope(run.runId, "design-doc", okEnvelope("design-ok"));
  await store.appendStageEvent(run.runId, "implementation-plan", {
    event: "started",
  });
  await store.updateRunStatus(run.runId, "running");
  return run;
}

describe("assertStageRetryEligible", () => {
  const forkEnvelope: StageEnvelope = {
    status: "success",
    summary: "fork",
    artifacts: [],
    fork_choice: ["branch-a"],
  };

  it.each([
    {
      name: "waiting_for_input stage (AE-S4-1)",
      detail: eligibilityDetail({
        runStatus: "failed",
        stageStatus: "waiting_for_input",
      }),
      stageId: "design-doc",
      status: 409,
      reason: /waiting for input/i,
    },
    {
      name: "missing stage",
      detail: eligibilityDetail({ runStatus: "failed", missingStage: true }),
      stageId: "design-doc",
      status: 404,
    },
    {
      name: "not-failed run when recoveryActive is false",
      detail: eligibilityDetail({ runStatus: "running", stageStatus: "failed" }),
      stageId: "design-doc",
      options: { recoveryActive: false },
      status: 409,
      reason: /run is not failed/i,
    },
    {
      name: "run that is neither failed, succeeded, nor recovering",
      detail: eligibilityDetail({ runStatus: "created", stageStatus: "failed" }),
      stageId: "design-doc",
      options: { recoveryActive: true },
      status: 409,
      reason: /run is not failed or succeeded/i,
    },
    {
      name: "stage that is neither failed nor succeeded",
      detail: eligibilityDetail({ runStatus: "failed", stageStatus: "pending" }),
      stageId: "design-doc",
      status: 409,
      reason: /stage is not failed or succeeded/i,
    },
    {
      name: "succeeded clone-instance stage",
      detail: eligibilityDetail({
        runStatus: "succeeded",
        stageStatus: "succeeded",
        stageId: "design-doc#1",
        definitionId: "design-doc",
      }),
      stageId: "design-doc#1",
      status: 409,
      reason: /clone instance/i,
    },
    {
      name: "succeeded fork stage with a recorded fork_choice",
      detail: eligibilityDetail({
        runStatus: "succeeded",
        stageStatus: "succeeded",
        envelope: forkEnvelope,
      }),
      stageId: "design-doc",
      status: 409,
      reason: /fork_choice/i,
    },
  ])("rejects $name", ({ detail, stageId, options, status, reason }) => {
    const result = assertStageRetryEligible(detail, stageId, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(status);
      if (reason) expect(result.reason).toMatch(reason);
    }
  });

  it.each([
    {
      name: "persisted meta is failed even if projected status is running",
      detail: eligibilityDetail({ runStatus: "running", stageStatus: "failed" }),
      options: { persistedStatus: "failed" as const },
    },
    {
      name: "a running run with a failed stage when recoveryActive is true",
      detail: eligibilityDetail({ runStatus: "running", stageStatus: "failed" }),
      options: { recoveryActive: true },
    },
    {
      name: "a succeeded run with a plain succeeded stage",
      detail: eligibilityDetail({
        runStatus: "succeeded",
        stageStatus: "succeeded",
      }),
      options: undefined,
    },
  ])("allows retry when $name", ({ detail, options }) => {
    expect(assertStageRetryEligible(detail, "design-doc", options)).toEqual({
      ok: true,
    });
  });

  it("allows retry of an accepted-failed parent while the join is still pending", () => {
    const result = assertStageRetryEligible(
      {
        run_id: "run-1",
        pipeline_id: "diamond-fan-in-accepted",
        status: "running",
        created_at: "2026-01-01T00:00:00.000Z",
        binding: { kind: "unbound" },
        task_yaml: "",
        stages: [
          {
            stage_id: "research",
            status: "failed",
            events: [],
            envelope: null,
            artifacts: [],
            attempt_count: 1,
          },
          {
            stage_id: "synthesize",
            status: "pending",
            events: [],
            envelope: null,
            artifacts: [],
            attempt_count: 0,
          },
        ],
        pipeline_track: { nodes: [], edges: [] },
        feedback_loops: [],
      },
      "research",
      {
        persistedStatus: "running",
        dag: {
          nodes: [
            {
              id: "research",
              needs: null,
              needsEdges: [],
              ancestors: [],
              stageIndex: 0,
            },
            {
              id: "synthesize",
              needs: null,
              needsEdges: [
                { id: "research", on: ["succeeded", "failed", "skipped"] },
              ],
              ancestors: ["research"],
              stageIndex: 1,
            },
          ],
          roots: ["research"],
          childrenOf: { research: ["synthesize"] },
        },
      },
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("succeededStageRetryBlocker", () => {
  function stageSnap(
    overrides: Partial<StageSnapshot> = {},
  ): StageSnapshot {
    return {
      stage_id: "design-doc",
      status: "succeeded",
      events: [],
      envelope: null,
      artifacts: [],
      attempt_count: 1,
      ...overrides,
    };
  }

  it.each([
    {
      name: "a clone-instance stage snapshot",
      snap: stageSnap({ stage_id: "design-doc#1", definition_id: "design-doc" }),
      reason: /clone instance/i,
    },
    {
      name: "a fork stage with a recorded fork_choice",
      snap: stageSnap({
        envelope: {
          status: "success",
          summary: "fork",
          artifacts: [],
          fork_choice: ["branch-a"],
        },
      }),
      reason: /fork_choice/i,
    },
  ])("blocks $name", ({ snap, reason }) => {
    expect(succeededStageRetryBlocker(snap)).toMatch(reason);
  });

  it("allows a plain succeeded stage", () => {
    const reason = succeededStageRetryBlocker(stageSnap());
    expect(reason).toBeUndefined();
  });

  it("does not block a stage with the same definition_id as its own stage_id", () => {
    const reason = succeededStageRetryBlocker(
      stageSnap({ stage_id: "design-doc", definition_id: "design-doc" }),
    );
    expect(reason).toBeUndefined();
  });
});

describe("RunRetryCoordinator.retryStage", () => {
  it("rejects orchestrationConflict without tracking when inactive (AE-S4-2)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-s4-conflict-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      SAMPLE_TASK,
      "utf8",
    );
    const run = await store.createRun({
      ...catalogLocators("linear-explicit"),
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "design-doc");
    await store.createStageExecution(run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await store.appendStageEvent(run.runId, "design-doc", {
      event: "failed",
      reason: "design-fail",
    });
    await store.updateRunStatus(run.runId, "failed");

    const tracking = recordingTracking();
    const coordinator = new RunRetryCoordinator();
    const result = await coordinator.retryStage({
      runId: run.runId,
      stageId: "design-doc",
      store,
      agent: scriptedFakeAgent([]),
      cwd: fixtures,
      maxActiveStagesPerRun: readMaxActiveStagesPerRun(process.env),
      executionMode: readStageExecutionMode(process.env),
      hitl: new StageHitlController({ store }),
      orchestrationConflict: true,
      tracking,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.reason).toMatch(/already has active orchestration/);
    }
    expect(tracking.calls).toEqual([]);
    expect(coordinator.isActive(run.runId)).toBe(false);
  });
});

describe("runtime stage retry", () => {
  it("retryStage resolves credentials against the run's own project_root, not the constructing manager's cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-cred-root-"));
    const store = createRunStore({ rootDir: root });
    const elsewhere = await mkdtemp(
      path.join(tmpdir(), "sf-retry-cred-elsewhere-"),
    );

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
      { type: "emit", envelope: okEnvelope("design-ok-retry") },
      { type: "emit", envelope: okEnvelope("plan-ok") },
    ]);

    const startManager = new RunManager({ agent, store, cwd: fixtures });
    const started = await startManager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "failed"
      );
    });

    const meta = await store.readRunMeta(started.runId);
    expect(meta.project_root).toBeDefined();

    const credentialBindingSpy = vi.spyOn(
      credentialBinding,
      "resolveCredentialBinding",
    );

    // Constructed pointed at an unrelated directory, sharing only the store —
    // proves retryStage uses the run's own stored project_root, not this
    // manager's own cwd/projectRoot.
    const elsewhereManager = new RunManager({ agent, store, cwd: elsewhere });
    const retry = await elsewhereManager.retryStage(started.runId, "design-doc");
    expect(retry).toMatchObject({ ok: true });

    const capturedRoots = credentialBindingSpy.mock.calls.map((call) => call[0]);
    expect(capturedRoots.length).toBeGreaterThan(0);
    expect(capturedRoots).toContain(meta.project_root);
    expect(capturedRoots).not.toContain(elsewhere);
  });

  it("waits for original startRun done before retry when still tracked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-wait-winddown-"));
    const store = createRunStore({ rootDir: root });
    let releaseFailedWrite!: () => void;
    const holdFailedWrite = new Promise<void>((resolve) => {
      releaseFailedWrite = resolve;
    });
    let heldFirstFailed = false;
    const originalUpdate = store.updateRunStatus.bind(store);
    store.updateRunStatus = async (runId, status) => {
      if (status === "failed" && !heldFirstFailed) {
        heldFirstFailed = true;
        await holdFailedWrite;
      }
      return originalUpdate(runId, status);
    };

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
      { type: "emit", envelope: okEnvelope("design-ok-retry") },
      { type: "emit", envelope: okEnvelope("plan-ok") },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "failed"
      );
    });

    const retryPromise = manager.retryStage(started.runId, "design-doc");
    await waitFor(async () => manager.getActiveRunIds().includes(started.runId));
    const mid = await store.readRun(started.runId);
    expect(
      mid.stages.find((s) => s.stage_id === "design-doc")?.attempt_count,
    ).toBe(1);

    releaseFailedWrite();
    const retry = await retryPromise;
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.attemptIndex).toBe(2);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
  });

  it("bounds startRun wind-down wait so retry does not hang forever", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-wait-timeout-winddown-"));
    const store = createRunStore({ rootDir: root });
    const holdFailedWrite = new Promise<void>(() => {});
    let heldFirstFailed = false;
    const originalUpdate = store.updateRunStatus.bind(store);
    store.updateRunStatus = async (runId, status) => {
      if (status === "failed" && !heldFirstFailed) {
        heldFirstFailed = true;
        await holdFailedWrite;
      }
      return originalUpdate(runId, status);
    };

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "failed"
      );
    });

    const prevTimeout = process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS;
    process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS = "100";
    const startedAt = Date.now();
    try {
      const retry = await manager.retryStage(started.runId, "design-doc");
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(retry.ok).toBe(false);
      if (!retry.ok) {
        expect(retry.status).toBe(409);
      }
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS;
      } else {
        process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS = prevTimeout;
      }
    }
  }, 10000);

  it("AE1: linear retry with cascade succeeds on same runId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-ae1-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
      { type: "emit", envelope: okEnvelope("design-ok-retry") },
      { type: "emit", envelope: okEnvelope("plan-ok") },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const retry = await manager.retryStage(started.runId, "design-doc");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.runId).toBe(started.runId);
    expect(retry.attemptIndex).toBe(2);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    expect(design?.status).toBe("succeeded");
    expect(design?.attempt_count).toBe(2);
  });

  it("retries an already-succeeded stage and re-settles the run to succeeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-succeeded-stage-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: okEnvelope("design-ok") },
      { type: "emit", envelope: okEnvelope("plan-ok") },
      { type: "emit", envelope: okEnvelope("design-ok-retry") },
      { type: "emit", envelope: okEnvelope("plan-ok-retry") },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const beforeDetail = await store.readRun(started.runId);
    const designBefore = beforeDetail.stages.find(
      (s) => s.stage_id === "design-doc",
    );
    expect(designBefore?.status).toBe("succeeded");
    expect(designBefore?.attempt_count).toBe(1);

    const updateRunStatusSpy = vi.spyOn(store, "updateRunStatus");

    const retry = await manager.retryStage(started.runId, "design-doc");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.runId).toBe(started.runId);
    expect(retry.attemptIndex).toBe(2);

    expect(
      updateRunStatusSpy.mock.calls.some(
        ([, status]) => status === "running",
      ),
    ).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    expect(design?.status).toBe("succeeded");
    expect(design?.attempt_count).toBe(2);
    const plan = detail.stages.find(
      (s) => s.stage_id === "implementation-plan",
    );
    expect(plan?.status).toBe("succeeded");
    expect(plan?.attempt_count).toBe(2);

    updateRunStatusSpy.mockRestore();
  });

  it("AE4: retry fails again records attempt 2 and run failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-ae4-"));
    const store = createRunStore({ rootDir: root });
    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail-1") },
      { type: "emit", envelope: failEnvelope("design-fail-2") },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });

    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const retry = await manager.retryStage(started.runId, "design-doc");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.attemptIndex).toBe(2);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    expect(design?.status).toBe("failed");
    expect(design?.attempt_count).toBe(2);
  });

  it.each([
    {
      name: "succeeded sibling is untouched and run succeeds",
      implBehavior: { type: "emit" as const, envelope: okEnvelope("impl-plan") },
      implStatus: "succeeded",
      finalRun: "succeeded",
    },
    {
      name: "failed sibling is untouched and run stays failed",
      implBehavior: { type: "emit" as const, envelope: failEnvelope("impl-fail") },
      implStatus: "failed",
      finalRun: "failed",
    },
  ])(
    "retry on one failed branch: $name",
    async ({ implBehavior, implStatus, finalRun }) => {
      const root = await mkdtemp(path.join(tmpdir(), "sf-retry-sibling-"));
      const store = createRunStore({ rootDir: root });
      const agent = stageKeyedAgent({
        clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
        "design-doc": [
          { type: "emit", envelope: failEnvelope("design-fail") },
          { type: "emit", envelope: okEnvelope("design-retry") },
        ],
        "implementation-plan": [implBehavior],
        "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
      });

      const manager = new RunManager({ agent, store, cwd: fixtures });
      const started = await manager.startRun({
        task: SAMPLE_TASK,
        pipeline: pipelinePath("parallel-retry-fanout"),
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === "failed";
      });
      expect(agent.openCounts.get("implementation-plan")).toBe(1);

      const retry = await manager.retryStage(started.runId, "design-doc");
      expect(retry.ok).toBe(true);

      await waitFor(async () => {
        const meta = await store.readRunMeta(started.runId);
        return meta.status === finalRun;
      });

      const detail = await store.readRun(started.runId);
      expect(
        detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
      ).toBe(implStatus);
      expect(agent.openCounts.get("implementation-plan")).toBe(1);
      expect(agent.openCounts.get("design-doc")).toBe(2);
      expect(agent.openCounts.get("join-doc")).toBe(1);
    },
  );

  it("rejects retrying a succeeded stage while the run is still running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-elig-running-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = {
      openStage(input: StageRunInput) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            if (input.stage.id === "design-doc") {
              await gate;
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
          return { ok: false, reason: "wait" };
        }
        return event.result;
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      const design = detail.stages.find((s) => s.stage_id === "design-doc");
      return design?.status === "running";
    });

    const retry = await manager.retryStage(started.runId, "clarify");
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.status).toBe(409);
      expect(retry.reason).toMatch(/run is not failed or succeeded/i);
    }

    release();
    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });
  });

  it("rejects concurrent retry on same stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-mutex-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let designOpens = 0;

    const agent = {
      openStage(input: StageRunInput) {
        return createCompletedOnlyStageHandle({
          stageId: input.stage.id,
          run: async () => {
            if (input.stage.id === "design-doc") {
              designOpens += 1;
              if (designOpens === 1) {
                return { ok: false as const, reason: "fail" };
              }
              await gate;
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
          return { ok: false, reason: "wait" };
        }
        return event.result;
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const first = manager.retryStage(started.runId, "design-doc");
    const second = await manager.retryStage(started.runId, "design-doc");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
    }

    release();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    while (manager.getActiveCount() > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  it("allows concurrent retry on different failed stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-concurrent-diff-"));
    const store = createRunStore({ rootDir: root });
    let releaseDesign!: () => void;
    const designGate = new Promise<void>((resolve) => {
      releaseDesign = resolve;
    });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail") },
        { type: "emit", envelope: okEnvelope("design-retry") },
      ],
      "implementation-plan": [
        { type: "emit", envelope: failEnvelope("impl-fail") },
        { type: "emit", envelope: okEnvelope("impl-retry") },
      ],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });
    let designOpens = 0;
    const baseOpenStage = agent.openStage.bind(agent);
    agent.openStage = (input) => {
      if (input.stage.id === "design-doc") {
        designOpens += 1;
        const handle = baseOpenStage(input);
        if (designOpens >= 2) {
          const baseNext = handle.next.bind(handle);
          handle.next = async () => {
            const event = await baseNext();
            if (event.status !== "waiting_for_input") {
              await designGate;
            }
            return event;
          };
        }
        return handle;
      }
      return baseOpenStage(input);
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
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
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "running"
      );
    });
    const implResult = await manager.retryStage(
      started.runId,
      "implementation-plan",
    );
    expect(implResult.ok).toBe(true);
    if (implResult.ok) {
      expect(implResult.attemptIndex).toBe(2);
    }

    releaseDesign();
    const designResult = await retryDesign;
    expect(designResult.ok).toBe(true);
    if (designResult.ok) {
      expect(designResult.attemptIndex).toBe(2);
    }

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    for (const stageId of ["design-doc", "implementation-plan"]) {
      expect(
        detail.stages.find((s) => s.stage_id === stageId)?.attempt_count,
      ).toBe(2);
    }
    expect(agent.openCounts.get("design-doc")).toBe(2);
    expect(agent.openCounts.get("implementation-plan")).toBe(2);
    expect(agent.openCounts.get("join-doc")).toBe(1);
  }, 15000);

  it("coordinator rejects duplicate addRoot for same stageId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-coord-dup-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = scriptedFakeAgent([
      { type: "emit", envelope: okEnvelope("clarify-ok") },
      { type: "emit", envelope: failEnvelope("design-fail") },
      { type: "never_emit" },
    ]);

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const execution = await store.createStageExecution(
      started.runId,
      "design-doc",
    );

    const coordinator = await startRetryCoordinator({
      store,
      runId: started.runId,
      agent,
      roots: new Map([["design-doc", execution.attempt]]),
      onLoopTick: async () => {
        await gate;
      },
    });

    await expect(
      coordinator.addRoot(started.runId, "design-doc", execution.attempt + 1),
    ).rejects.toBeInstanceOf(DuplicateRetryRootError);

    release();
    await coordinator.getOrchestrationPromise(started.runId);
  });

  it("AE2 addRoot await merge: resolves only after applyRetryRootDelta", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-ae2-merge-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail") },
        { type: "emit", envelope: okEnvelope("design-retry") },
      ],
      "implementation-plan": [
        { type: "emit", envelope: failEnvelope("impl-fail") },
        { type: "emit", envelope: okEnvelope("impl-retry") },
      ],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const designExecution = await createRetryExecution(
      store,
      started.runId,
      "design-doc",
    );
    const implExecution = await createRetryExecution(
      store,
      started.runId,
      "implementation-plan",
    );

    let loopBlocked!: () => void;
    const loopBlockedPromise = new Promise<void>((resolve) => {
      loopBlocked = resolve;
    });

    const coordinator = await startRetryCoordinator({
      store,
      runId: started.runId,
      agent,
      roots: new Map([["design-doc", designExecution.attempt]]),
      onLoopTick: async () => {
        loopBlocked();
        await gate;
      },
    });

    await loopBlockedPromise;
    let addRootResolved = false;
    const addRootPromise = coordinator
      .addRoot(started.runId, "implementation-plan", implExecution.attempt)
      .then(() => {
        addRootResolved = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(addRootResolved).toBe(false);

    release();
    await addRootPromise;
    expect(addRootResolved).toBe(true);

    await coordinator.getOrchestrationPromise(started.runId);
    expect(agent.openCounts.get("implementation-plan")).toBe(2);
    expect(agent.openCounts.get("design-doc")).toBe(2);
  });

  it("waitForRoot AE3: event-driven resolution without store polling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-wait-event-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail") },
        { type: "emit", envelope: okEnvelope("design-retry") },
      ],
      "implementation-plan": [{ type: "emit", envelope: failEnvelope("impl-fail") }],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const designExecution = await createRetryExecution(
      store,
      started.runId,
      "design-doc",
    );

    const coordinator = await startRetryCoordinator({
      store,
      runId: started.runId,
      agent,
      roots: new Map([["design-doc", designExecution.attempt]]),
    });

    const readRunSpy = vi.spyOn(store, "readRun");
    const readRunCallsBeforeWait = readRunSpy.mock.calls.length;
    const waitPromise = coordinator.waitForRoot(
      started.runId,
      "design-doc",
      store,
    );
    await waitPromise;
    const readRunCallsDuringWait =
      readRunSpy.mock.calls.length - readRunCallsBeforeWait;
    expect(readRunCallsDuringWait).toBe(0);

    readRunSpy.mockRestore();
    await coordinator.getOrchestrationPromise(started.runId);
    expect(agent.openCounts.get("design-doc")).toBe(2);
  });

  it("waitForRoot AE3: throws RetryRootWaitTimeoutError when terminal never emitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-wait-timeout-"));
    const store = createRunStore({ rootDir: root });
    const neverGate = new Promise<void>(() => {});

    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail") },
        { type: "never_emit" },
      ],
      "implementation-plan": [{ type: "emit", envelope: failEnvelope("impl-fail") }],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const designExecution = await createRetryExecution(
      store,
      started.runId,
      "design-doc",
    );

    const prevTimeout = process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS;
    process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS = "100";

    const coordinator = await startRetryCoordinator({
      store,
      runId: started.runId,
      agent,
      roots: new Map([["design-doc", designExecution.attempt]]),
      onLoopTick: async () => {
        await neverGate;
      },
    });

    try {
      await expect(
        coordinator.waitForRoot(started.runId, "design-doc", store),
      ).rejects.toBeInstanceOf(RetryRootWaitTimeoutError);
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS;
      } else {
        process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS = prevTimeout;
      }
    }
  });

  it("AE1 halt-unstick: gated B failure + queued addRoot(C) race", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-halt-unstick-"));
    const store = createRunStore({ rootDir: root });
    let releaseDesign!: () => void;
    const designGate = new Promise<void>((resolve) => {
      releaseDesign = resolve;
    });
    let designRetryOpens = 0;

    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail-1") },
        { type: "emit", envelope: failEnvelope("design-fail-2") },
      ],
      "implementation-plan": [
        { type: "emit", envelope: failEnvelope("impl-fail-1") },
        { type: "emit", envelope: okEnvelope("impl-retry") },
      ],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });
    const baseOpenStage = agent.openStage.bind(agent);
    agent.openStage = (input) => {
      if (input.stage.id === "design-doc") {
        designRetryOpens += 1;
        if (designRetryOpens >= 2) {
          agent.openCounts.set(
            "design-doc",
            (agent.openCounts.get("design-doc") ?? 0) + 1,
          );
          return createCompletedOnlyStageHandle({
            stageId: input.stage.id,
            run: async () => {
              await designGate;
              return { ok: false as const, reason: "design-fail-2" };
            },
          });
        }
      }
      return baseOpenStage(input);
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const designExecution = await createRetryExecution(
      store,
      started.runId,
      "design-doc",
    );
    const implExecution = await createRetryExecution(
      store,
      started.runId,
      "implementation-plan",
    );

    let addedImplRoot = false;
    const coordinator = new RunRetryCoordinator();
    await startRetryCoordinator({
      coordinator,
      store,
      runId: started.runId,
      agent,
      roots: new Map([["design-doc", designExecution.attempt]]),
      onLoopTick: async () => {
        if (!addedImplRoot) {
          void coordinator.addRoot(
            started.runId,
            "implementation-plan",
            implExecution.attempt,
          );
          addedImplRoot = true;
        }
      },
    });

    await waitFor(async () => designRetryOpens >= 2);
    releaseDesign();

    const waitForImpl = coordinator.waitForRoot(
      started.runId,
      "implementation-plan",
      store,
    );
    await coordinator.getOrchestrationPromise(started.runId);
    await waitForImpl;

    expect(agent.openCounts.get("implementation-plan")).toBe(2);
    expect(agent.openCounts.get("design-doc")).toBe(2);

    const detail = await store.readRun(started.runId);
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");
    expect(impl?.status).toBe("succeeded");
    expect(impl?.attempt_count).toBe(2);
  }, 15000);

  it("retry settlement writes run status once; failed branch does not skip retried sibling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-ae4-status-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify") }],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail-1") },
        { type: "emit", envelope: failEnvelope("design-fail-2") },
      ],
      "implementation-plan": [
        { type: "emit", envelope: failEnvelope("impl-fail-1") },
        { type: "emit", envelope: okEnvelope("impl-retry") },
      ],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const designExecution = await createRetryExecution(
      store,
      started.runId,
      "design-doc",
    );
    const implExecution = await createRetryExecution(
      store,
      started.runId,
      "implementation-plan",
    );

    const updateStatusSpy = vi.spyOn(store, "updateRunStatus");

    await store.updateRunStatus(started.runId, "running");

    const coordinator = await startRetryCoordinator({
      store,
      runId: started.runId,
      agent,
      roots: new Map([
        ["design-doc", designExecution.attempt],
        ["implementation-plan", implExecution.attempt],
      ]),
    });

    const callsBeforeOrchestration = updateStatusSpy.mock.calls.length;
    await coordinator.getOrchestrationPromise(started.runId);
    const settlementCalls = updateStatusSpy.mock.calls.slice(
      callsBeforeOrchestration,
    );

    expect(settlementCalls).toHaveLength(1);
    expect(settlementCalls[0]).toEqual([started.runId, "failed"]);

    const detail = await store.readRun(started.runId);
    expect(detail.status).toBe("failed");
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    const impl = detail.stages.find((s) => s.stage_id === "implementation-plan");
    expect(design?.status).toBe("failed");
    expect(design?.attempt_count).toBe(2);
    expect(impl?.status).toBe("succeeded");
    expect(impl?.attempt_count).toBe(2);
    expect(agent.openCounts.get("join-doc")).toBeUndefined();

    updateStatusSpy.mockRestore();
  });

  it("process mode retry passes attempt to launcher", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-process-"));
    const store = createRunStore({ rootDir: root });
    const agent = { openStage: vi.fn(), runStage: vi.fn() };

    const launch = vi.fn(async ({ runId, stageId, attempt }: {
      runId: string;
      stageId: string;
      attempt?: number;
    }) => {
      if (stageId === "design-doc" && attempt === 1) {
        await store.appendStageEvent(runId, stageId, { event: "started" }, { attempt: 1 });
        await store.appendStageEvent(
          runId,
          stageId,
          { event: "failed", reason: "fail" },
          { attempt: 1 },
        );
        return { type: "failed" as const, reason: "fail" };
      }
      await store.appendStageEvent(runId, stageId, { event: "started" }, {
        attempt: attempt ?? 1,
      });
      await store.writeEnvelope(runId, stageId, okEnvelope(stageId), {
        attempt: attempt ?? 1,
      });
      await store.appendStageEvent(runId, stageId, { event: "succeeded" }, {
        attempt: attempt ?? 1,
      });
      return { type: "succeeded" as const };
    });

    const manager = new RunManager({
      agent,
      store,
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncher,
    });

    const started = await startPipeline({
      agent,
      store,
      taskPath: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
      cwd: fixtures,
      executionMode: "process",
      stageProcessLauncher: { launch } as unknown as StageProcessLauncher,
    });

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

    expect(
      launch.mock.calls.some(
        (call) =>
          call[0].stageId === "design-doc" && call[0].attempt === 2,
      ),
    ).toBe(true);
  });

  it(
    "retry HITL stage starts fresh session and co-located prompt on attempt 2",
    async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-hitl-session-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [{ type: "emit", envelope: okEnvelope("clarify-ok") }],
      "design-doc": [
        {
          type: "wait_then_emit",
          waitRequests: [hitlPrompt1],
          envelope: failEnvelope("design-fail"),
        },
        {
          type: "wait_then_emit",
          waitRequests: [hitlPrompt2],
          envelope: okEnvelope("design-retry-ok"),
        },
      ],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("plan-ok") },
      ],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "waiting_for_input"
      );
    });

    const firstAnswer = await manager.deliverAnswer(
      started.runId,
      "design-doc",
      {
        promptId: hitlPrompt1.id,
        kind: "free_text",
        text: "answer-1",
      },
    );
    expect(firstAnswer.ok).toBe(true);

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const attempt1Events = await store.listStageEvents(
      started.runId,
      "design-doc",
      1,
    );
    expect(attempt1Events.some((e) => e.event === "operator_prompt")).toBe(true);
    expect(attempt1Events.some((e) => e.event === "waiting_for_input")).toBe(
      true,
    );

    const retryPromise = manager.retryStage(started.runId, "design-doc");

    await waitFor(async () => {
      const attempt2Events = await store.listStageEvents(
        started.runId,
        "design-doc",
        2,
      );
      return (
        attempt2Events.some((e) => e.event === "operator_prompt") &&
        attempt2Events.some((e) => e.event === "waiting_for_input")
      );
    });

    const detail = await store.readRun(started.runId);
    const design = detail.stages.find((s) => s.stage_id === "design-doc");
    expect(design?.status).toBe("waiting_for_input");
    expect(design?.pending_prompt).toBeDefined();

    const attempt2Events = await store.listStageEvents(
      started.runId,
      "design-doc",
      2,
    );
    expect(attempt2Events.some((e) => e.event === "operator_prompt")).toBe(true);
    expect(attempt2Events.some((e) => e.event === "waiting_for_input")).toBe(
      true,
    );
    expect(agent.openCounts.get("design-doc")).toBe(2);

    await manager.deliverAnswer(started.runId, "design-doc", {
      promptId: hitlPrompt2.id,
      kind: "free_text",
      text: "answer-2",
    });

    const retry = await retryPromise;
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.attemptIndex).toBe(2);
    },
    15000,
  );

  it("R8: reconcile unblocks resumeRun after parallel HITL answer", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sf-retry-reconcile-hitl-"),
    );
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      SAMPLE_TASK,
      "utf8",
    );
    const run = await store.createRun({
      ...catalogLocators("parallel-retry-fanout"),
      taskYaml,
      taskId: "sample",
    });

    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    await store.appendStageEvent(run.runId, "clarify", { event: "succeeded" });
    await store.createStageExecution(run.runId, "clarify");
    await store.writeEnvelope(run.runId, "clarify", okEnvelope("clarify-ok"));

    await store.ensureStageWorkspace(run.runId, "design-doc");
    await store.appendStageEvent(run.runId, "design-doc", { event: "started" });
    await writeFile(
      fakeHitlResumePath(
        buildStageRoots(run.workspaceDir, "design-doc"),
        "design-doc",
      ),
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: okEnvelope("design-ok"),
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

    const agent = stageKeyedAgent({
      "design-doc": [
        {
          type: "wait_then_emit",
          waitRequests: ["need-input"],
          envelope: okEnvelope("design-ok"),
        },
      ],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("impl-retry") },
      ],
      "join-doc": [{ type: "emit", envelope: okEnvelope("join") }],
    });

    const bootManager = new RunManager({ agent, store, cwd: fixtures });
    await bootManager.attachWaitingStages();
    await bootManager.reconcileOrphanedStages();

    const delivered = await bootManager.deliverAnswer(
      run.runId,
      "design-doc",
      "approved",
    );
    expect(delivered.ok).toBe(true);

    await waitFor(async () => {
      const detail = await store.readRun(run.runId);
      return (
        detail.stages.find((s) => s.stage_id === "design-doc")?.status ===
        "succeeded"
      );
    });

    const mid = await store.readRun(run.runId);
    expect(
      mid.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("interrupted");
    expect(mid.status).toBe("running");

    const retry = await bootManager.retryStage(run.runId, "implementation-plan");
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.status).toBe(409);
      expect(retry.reason).toMatch(/not failed or succeeded/i);
    }
  });

  it("retry downstream after upstream succeeded on attempt 2", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-upstream-a2-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      clarify: [
        { type: "emit", envelope: failEnvelope("clarify-fail-1") },
        { type: "emit", envelope: okEnvelope("clarify-ok-attempt-2") },
      ],
      "design-doc": [
        { type: "emit", envelope: failEnvelope("design-fail-1") },
        { type: "emit", envelope: okEnvelope("design-ok-retry") },
      ],
      "implementation-plan": [
        { type: "emit", envelope: okEnvelope("plan-ok") },
      ],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("linear-explicit"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const retryClarify = await manager.retryStage(started.runId, "clarify");
    expect(
      retryClarify.ok,
      retryClarify.ok ? undefined : retryClarify.reason,
    ).toBe(true);
    if (!retryClarify.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    if (retryClarify.done !== undefined) {
      await retryClarify.done;
    }

    const workspaceDir = store.getWorkspaceDir(started.runId);
    await expect(store.readEnvelope(started.runId, "clarify")).resolves.toMatchObject(
      { summary: "clarify-ok-attempt-2" },
    );

    const retryDesign = await manager.retryStage(started.runId, "design-doc");
    expect(
      retryDesign.ok,
      retryDesign.ok ? undefined : retryDesign.reason,
    ).toBe(true);
    if (!retryDesign.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    const detail = await store.readRun(started.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "clarify")?.attempt_count,
    ).toBe(2);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.attempt_count,
    ).toBe(2);
  });

  it("keeps run running during dual retry then settles failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-dual-status-"));
    const store = createRunStore({ rootDir: root });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
              return { ok: false as const, reason: "design-fail" };
            }
            if (input.stage.id === "implementation-plan") {
              implOpens += 1;
              if (implOpens === 1) {
                return { ok: false as const, reason: "impl-fail" };
              }
              await gate;
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
          return { ok: false, reason: "wait" };
        }
        return event.result;
      },
    };

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("parallel-retry-fanout"),
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

    const retryImpl = manager.retryStage(started.runId, "implementation-plan");
    await waitFor(async () => {
      const detail = await store.readRun(started.runId);
      return (
        detail.stages.find((s) => s.stage_id === "implementation-plan")
          ?.status === "running"
      );
    });
    const designResult = await manager.retryStage(
      started.runId,
      "design-doc",
    );
    expect(designResult.ok).toBe(true);

    release();
    await retryImpl;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const detail = await store.readRun(started.runId);
    expect(
      detail.stages.find((s) => s.stage_id === "design-doc")?.status,
    ).toBe("failed");
    expect(
      detail.stages.find((s) => s.stage_id === "implementation-plan")?.status,
    ).toBe("succeeded");
  }, 15000);

  it("AE3: reconstructAndContinue runs without RunManager", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-retry-ae3-"));
    const store = createRunStore({ rootDir: root });
    const taskYaml = await readFile(
      SAMPLE_TASK,
      "utf8",
    );
    const run = await store.createRun({
      ...catalogLocators("single"),
      taskYaml,
      taskId: "sample",
    });
    await store.ensureStageWorkspace(run.runId, "clarify");
    await store.appendStageEvent(run.runId, "clarify", { event: "started" });
    const resumePath = fakeHitlResumePath(
      buildStageRoots(run.workspaceDir, "clarify"),
      "clarify",
    );
    await writeFile(
      resumePath,
      `${JSON.stringify({
        waitRequests: ["need-input"],
        envelope: okEnvelope("clarify-ok"),
        waitIndex: 1,
      })}\n`,
      "utf8",
    );
    await store.appendStageEvent(run.runId, "clarify", {
      event: "waiting_for_input",
    });

    const agent = scriptedFakeAgent([
      {
        type: "wait_then_emit",
        waitRequests: ["need-input"],
        envelope: okEnvelope("clarify-ok"),
      },
    ]);
    const hitl = new StageHitlController({ store });

    const outcome = await reconstructAndContinue({
      runId: run.runId,
      stageId: "clarify",
      opaqueAnswer: "direct-resume",
      agent,
      store,
      hitl,
      executionMode: readStageExecutionMode(process.env),
      cwd: fixtures,
      maxActiveStagesPerRun: readMaxActiveStagesPerRun(process.env),
      executionMode: readStageExecutionMode(process.env),
    });
    expect(outcome.ok).toBe(true);

    const done = await store.readRun(run.runId);
    expect(done.status).toBe("succeeded");
    expect(done.stages.find((s) => s.stage_id === "clarify")?.status).toBe(
      "succeeded",
    );
  });
});
