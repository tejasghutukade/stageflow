import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentPort, OpaqueAnswer } from "../agent/port.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { loadTaskFromYaml } from "../config/loadTask.js";
import type { RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { TaskFile } from "../types/task.js";
import {
  PipelineValidationError,
  startPipeline,
  type PipelineRunResult,
} from "./pipelineRunner.js";
import { resumeRun } from "./pipelineScheduler.js";
import {
  RunRetryCoordinator,
  type RetryStageResult,
  type RetryTrackingPort,
} from "./runRetryCoordinator.js";
import {
  readMaxActiveStageProcesses,
  readMaxActiveStagesPerRun,
  readStageExecutionMode,
  type StageExecutionMode,
} from "./stageConcurrency.js";
import { StageProcessLauncher } from "./stageProcessLauncher.js";
import {
  INVALID_SLOT_COUNT_MESSAGE,
  parseSlotCount,
  readMaxConcurrentFromFile,
  writeMaxConcurrentToFile,
} from "./settingsFile.js";
import {
  StageHitlController,
  waitKey,
  type DeliverAnswerResult,
  type HitlSeams,
} from "./stageHitl.js";
import {
  resolveAndValidateCheckout,
} from "./stageRoots.js";
import { orchestrateAnswerResume } from "./answerResume.js";
import { reconstructAndContinue as resumeReconstructAndContinue } from "./resumeReconstruct.js";
import { resumeSessionFilePath } from "./stageAttemptContext.js";
import { resolveStartTaskInput, type StartTaskInput } from "./taskInput.js";
import {
  failStageAsInterrupted,
  syncRunStatusFromStages,
} from "./stageRecovery.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

export type BusyCode = "busy_capacity" | "busy_checkout";

export type StartRunResult =
  | { ok: true; runId: string; done: Promise<PipelineRunResult> }
  | {
      ok: false;
      reason: string;
      status?: number;
      code?: BusyCode;
      activeCount?: number;
      maxConcurrent?: number;
      activeRunIds?: string[];
      conflictingRunId?: string;
      conflictingCheckout?: string;
    };

export type CapacityHealth = {
  ok: true;
  activeRunIds: string[];
  activeCount: number;
  maxConcurrent: number;
  slotsAvailable: number;
  activeStageProcesses: number;
  maxActiveStageProcesses: number | null;
};

export type { DeliverAnswerResult };

export type { RetryStageResult };

export type AbandonStageResult =
  | { ok: true; runId: string; stageId: string }
  | { ok: false; reason: string; status?: number };

type ActiveEntry = {
  checkoutKey?: string;
  durableCheckoutRoot?: string;
  generation: number;
};

const DEFAULT_MAX_CONCURRENT = 3;
const STARTUP_RECONCILE_REASON =
  "process_interrupted: no active worker (server restart)";
const OPERATOR_ABANDON_REASON =
  "process_interrupted: operator abandoned stage";

function parseMaxConcurrent(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT;
  return n;
}

async function toCheckoutLeaseKey(absPath: string): Promise<string> {
  try {
    return await realpath(absPath);
  } catch {
    const fallback = path.resolve(absPath);
    console.error(
      `invariant: checkout realpath failed for ${absPath}; using path.resolve fallback ${fallback}`,
    );
    return fallback;
  }
}

export class RunManager {
  private readonly active = new Map<string, ActiveEntry>();
  private readonly checkoutLeases = new Map<string, string>();
  private readonly provisionalIds = new Set<string>();
  private readonly resumeInFlight = new Set<string>();
  private readonly retryInFlight = new Set<string>();
  private trackingGeneration = 0;
  private maxConcurrent: number;
  private readonly maxActiveStagesPerRun: number;
  private readonly executionMode: StageExecutionMode;
  private readonly stageProcessLauncher: StageProcessLauncher | undefined;
  private readonly hitl: StageHitlController;
  private readonly attachedWaiting = new Set<string>();
  private readonly retryCoordinator = new RunRetryCoordinator();
  private readonly retryTracking: RetryTrackingPort = {
    ensureResumeTracked: async (runId) => {
      const wasActive = this.active.has(runId);
      const tracked = await this.ensureResumeTracked(runId);
      if (!tracked.ok) {
        return tracked;
      }
      return { ok: true, insertedForResume: !wasActive };
    },
    onOrchestrationStarted: (runId, promise) => {
      this.registerResumeUntrack(runId, promise);
    },
    rollbackStartTracking: async (runId, state) => {
      if (state.insertedForResume) {
        this.removeActiveEntry(runId, false);
      }
      if (state.bumpedRunning) {
        try {
          await this.options.store.updateRunStatus(runId, state.priorRunStatus);
        } catch {
          // ignore secondary failures
        }
      }
    },
  };
  private readonly cwd: string;

  constructor(
    private readonly options: {
      agent: AgentPort;
      store: RunStore;
      cwd?: string;
      operatorCatalog?: OperatorCatalog;
      seams?: HitlSeams;
      maxConcurrent?: number;
      maxActiveStagesPerRun?: number;
      executionMode?: StageExecutionMode;
      stageProcessLauncher?: StageProcessLauncher;
    },
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.maxConcurrent =
      options.maxConcurrent ??
      readMaxConcurrentFromFile(this.cwd) ??
      parseMaxConcurrent(process.env.STAGEFLOW_MAX_CONCURRENT_RUNS);
    this.maxActiveStagesPerRun = readMaxActiveStagesPerRun(
      process.env,
      options.maxActiveStagesPerRun,
    );
    this.executionMode = readStageExecutionMode(
      process.env,
      options.executionMode,
    );
    this.stageProcessLauncher =
      this.executionMode === "process"
        ? (options.stageProcessLauncher ?? new StageProcessLauncher())
        : undefined;
    this.hitl = new StageHitlController({
      store: options.store,
      seams: options.seams,
    });
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrent(n: number): CapacityHealth {
    const parsed = parseSlotCount(n);
    if (parsed === undefined) {
      throw new Error(INVALID_SLOT_COUNT_MESSAGE);
    }
    this.maxConcurrent = parsed;
    writeMaxConcurrentToFile(this.cwd, parsed);
    return this.getHealth();
  }

  getActiveCount(): number {
    return this.active.size;
  }

  getActiveRunIds(): string[] {
    return [...this.active.keys()];
  }

  getHealth(): CapacityHealth {
    const activeRunIds = this.getActiveRunIds();
    const activeCount = this.getActiveCount();
    const maxConcurrent = this.getMaxConcurrent();
    const maxActiveStageProcessesRaw = readMaxActiveStageProcesses(process.env);
    const activeStageProcesses =
      this.stageProcessLauncher?.activeCount() ?? 0;
    return {
      ok: true,
      activeRunIds,
      activeCount,
      maxConcurrent,
      slotsAvailable: Math.max(0, maxConcurrent - activeCount),
      activeStageProcesses,
      maxActiveStageProcesses: Number.isFinite(maxActiveStageProcessesRaw)
        ? maxActiveStageProcessesRaw
        : null,
    };
  }

  getHitlController(): StageHitlController {
    return this.hitl;
  }

  /**
   * KTD7/KTD8: discover waiting stages from the store; leave waiting; do not
   * auto-resume. Registers each waiting run into the active set (capacity)
   * and re-acquires checkout leases from durable checkout_root (even over soft max).
   */
  async attachWaitingStages(): Promise<
    Array<{ runId: string; stageId: string }>
  > {
    const found: Array<{ runId: string; stageId: string }> = [];
    const runs = await this.options.store.listRuns();
    for (const summary of runs) {
      if (summary.status !== "running") continue;
      let detail;
      try {
        detail = await this.options.store.readRun(summary.run_id);
      } catch {
        continue;
      }
      const waitingStages = detail.stages.filter(
        (s) => s.status === "waiting_for_input",
      );
      if (waitingStages.length === 0) continue;

      const runId = summary.run_id;

      if (this.active.has(runId)) {
        for (const stage of waitingStages) {
          found.push({ runId, stageId: stage.stage_id });
          this.attachedWaiting.add(`${runId}\0${stage.stage_id}`);
        }
        continue;
      }

      let checkoutKey: string | undefined;
      let durableCheckoutRoot: string | undefined;
      try {
        const meta = await this.options.store.readRunMeta(runId);
        const checkoutRoot = meta.checkout_root;
        if (checkoutRoot !== undefined && checkoutRoot !== "") {
          durableCheckoutRoot = checkoutRoot;
          checkoutKey = await toCheckoutLeaseKey(checkoutRoot);
        }
      } catch (err) {
        console.error(
          `invariant: attach failed reading checkout_root for run ${runId}; tracking without checkout lease: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const conflictHolder = this.findActiveCheckoutConflict(
        runId,
        checkoutKey,
        durableCheckoutRoot,
      );
      if (conflictHolder !== undefined) {
        const reason = `duplicate_checkout_attach: checkout already held by ${conflictHolder}`;
        await this.quarantineAttachRun(runId, waitingStages, reason);
        continue;
      }

      if (checkoutKey !== undefined) {
        this.checkoutLeases.set(checkoutKey, runId);
      }

      this.active.set(runId, {
        checkoutKey,
        durableCheckoutRoot,
        generation: ++this.trackingGeneration,
      });
      for (const stage of waitingStages) {
        found.push({ runId, stageId: stage.stage_id });
        this.attachedWaiting.add(`${runId}\0${stage.stage_id}`);
      }
    }
    return found;
  }

  hasActiveWorker(runId: string, stageId: string): boolean {
    if (this.stageProcessLauncher === undefined) {
      return false;
    }
    return this.stageProcessLauncher
      .getActiveStageProcesses()
      .some((entry) => entry.runId === runId && entry.stageId === stageId);
  }

  async reconcileOrphanedStages(): Promise<{
    reconciled: Array<{ runId: string; stageId: string; reason: string }>;
  }> {
    const reconciled: Array<{
      runId: string;
      stageId: string;
      reason: string;
    }> = [];
    const runs = await this.options.store.listRuns();

    for (const summary of runs) {
      let detail;
      try {
        detail = await this.options.store.readRun(summary.run_id);
      } catch (err) {
        console.error(
          `reconcileOrphanedStages: failed to read run ${summary.run_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      const runId = summary.run_id;
      let runChanged = false;

      for (const stage of detail.stages) {
        if (stage.status !== "running") continue;
        if (this.hasActiveWorker(runId, stage.stage_id)) continue;

        try {
          await failStageAsInterrupted({
            store: this.options.store,
            runId,
            stageId: stage.stage_id,
            reason: STARTUP_RECONCILE_REASON,
          });
          reconciled.push({
            runId,
            stageId: stage.stage_id,
            reason: STARTUP_RECONCILE_REASON,
          });
          runChanged = true;
          console.error(
            `reconcileOrphanedStages: failed orphaned stage ${runId}/${stage.stage_id}: ${STARTUP_RECONCILE_REASON}`,
          );
        } catch (err) {
          console.error(
            `reconcileOrphanedStages: failed to reconcile ${runId}/${stage.stage_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      if (runChanged) {
        try {
          await syncRunStatusFromStages(this.options.store, runId);
        } catch (err) {
          console.error(
            `reconcileOrphanedStages: failed to sync run status for ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    if (reconciled.length > 0) {
      console.error(
        `reconcileOrphanedStages: reconciled ${reconciled.length} orphaned stage(s)`,
      );
    }

    return { reconciled };
  }

  async abandonStage(
    runId: string,
    stageId: string,
  ): Promise<AbandonStageResult> {
    let detail;
    try {
      detail = await this.options.store.readRun(runId);
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const stageSnap = detail.stages.find((s) => s.stage_id === stageId);
    if (!stageSnap) {
      return {
        ok: false,
        reason: `Stage not found: ${stageId}`,
        status: 404,
      };
    }

    if (stageSnap.status === "waiting_for_input") {
      return {
        ok: false,
        reason: `Stage is waiting for input and cannot be abandoned`,
        status: 409,
      };
    }

    if (stageSnap.status !== "running") {
      return {
        ok: false,
        reason: `Stage is not running (status=${stageSnap.status})`,
        status: 409,
      };
    }

    if (this.stageProcessLauncher !== undefined) {
      const hasActive = this.stageProcessLauncher
        .getActiveStageProcesses()
        .some((entry) => entry.runId === runId);
      if (hasActive) {
        await this.stageProcessLauncher.cancelRun(runId);
      }
    }

    await failStageAsInterrupted({
      store: this.options.store,
      runId,
      stageId,
      reason: OPERATOR_ABANDON_REASON,
    });
    if (
      this.retryCoordinator.isActive(runId) &&
      this.retryCoordinator.getActiveRoots(runId)?.has(stageId)
    ) {
      this.retryCoordinator.signalExternalRetryRootTerminal(runId, stageId);
    }
    await syncRunStatusFromStages(this.options.store, runId);

    const after = await this.options.store.readRun(runId);
    const hasWaiting = after.stages.some(
      (s) => s.status === "waiting_for_input",
    );
    if (!hasWaiting && this.active.has(runId)) {
      this.removeActiveEntry(runId, false);
    }

    return { ok: true, runId, stageId };
  }

  async startRun(
    input: StartTaskInput & {
      pipeline: string;
      task?: string | TaskFile;
      checkoutOverride?: string;
      skipGates?: boolean;
    },
  ): Promise<StartRunResult> {
    const cwd = this.options.cwd ?? process.cwd();

    let resolved;
    try {
      resolved = resolveStartTaskInput(input, cwd);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 400,
      };
    }

    let taskYaml: string;
    let label: string;
    try {
      if (resolved.kind === "path") {
        taskYaml = await readFile(resolved.taskPath, "utf8");
        label = resolved.taskPath;
      } else {
        taskYaml = resolved.taskYaml;
        label = "task.yaml";
      }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 400,
      };
    }

    return this.reserveAndStartPipeline(
      taskYaml,
      input.pipeline,
      `task file ${label}`,
      cwd,
      input.checkoutOverride,
      input.skipGates,
    );
  }

  async rerun(runId: string): Promise<StartRunResult> {
    const cwd = this.options.cwd ?? process.cwd();

    let pipelineId: string;
    let taskYaml: string;
    try {
      const meta = await this.options.store.readRunMeta(runId);
      pipelineId = meta.pipeline_id;
      taskYaml = await this.options.store.readTaskYaml(runId);
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    return this.reserveAndStartPipeline(
      taskYaml,
      pipelineId,
      `run ${runId} task`,
      cwd,
    );
  }

  async retryStage(runId: string, stageId: string): Promise<RetryStageResult> {
    const retryKey = waitKey(runId, stageId);
    if (this.retryInFlight.has(retryKey)) {
      return {
        ok: false,
        reason: `Retry already in progress for run ${runId} stage ${stageId}`,
        status: 409,
      };
    }

    this.retryInFlight.add(retryKey);

    try {
      const orchestrationConflict =
        this.active.has(runId) &&
        !this.attachedWaiting.has(waitKey(runId, stageId));
      return await this.retryCoordinator.retryStage({
        runId,
        stageId,
        store: this.options.store,
        agent: this.options.agent,
        cwd: this.cwd,
        operatorCatalog: this.options.operatorCatalog,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        hitl: this.hitl,
        orchestrationConflict,
        tracking: this.retryTracking,
      });
    } finally {
      this.retryInFlight.delete(retryKey);
    }
  }

  /**
   * Deliver an operator answer for `(runId, stageId)` (KTD2 / KTD6).
   * Same-process: unparks the live yield loop. After restart: reconstructs
   * the stage session seam and continues that stage (KTD8).
   */
  async deliverAnswer(
    runId: string,
    stageId: string,
    opaqueAnswer: OpaqueAnswer,
  ): Promise<DeliverAnswerResult> {
    const resumeKey = waitKey(runId, stageId);
    const isLive =
      this.executionMode !== "process" &&
      this.hitl.hasLiveWait(runId, stageId);
    if (!isLive) {
      if (this.resumeInFlight.has(resumeKey)) {
        return {
          ok: false,
          reason: `Resume already in progress for run ${runId} stage ${stageId}`,
          status: 409,
        };
      }
      this.resumeInFlight.add(resumeKey);
    }

    let detail;
    try {
      detail = await this.options.store.readRun(runId);
    } catch {
      if (!isLive) this.resumeInFlight.delete(resumeKey);
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const stageSnap = detail.stages.find((s) => s.stage_id === stageId);
    if (!stageSnap) {
      if (!isLive) this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `Stage not found: ${stageId}`,
        status: 404,
      };
    }
    if (stageSnap.status !== "waiting_for_input") {
      if (!isLive) this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `Stage is not waiting for input (status=${stageSnap.status})`,
        status: 409,
      };
    }

    let insertedForResume = false;
    if (!isLive) {
      const wasActive = this.active.has(runId);
      const tracked = await this.ensureResumeTracked(runId);
      if (!tracked.ok) {
        this.resumeInFlight.delete(resumeKey);
        return {
          ok: false,
          reason: tracked.reason,
          status: 409,
        };
      }
      insertedForResume = !wasActive;
    }

    try {
      const prefix = await this.hitl.deliverAnswerPrefix(
        runId,
        stageId,
        opaqueAnswer,
      );
      if (!prefix.ok) {
        if (insertedForResume) {
          this.removeActiveEntry(runId, false);
        }
        return prefix;
      }
      return await orchestrateAnswerResume({
        prefixMode: prefix.mode,
        executionMode: this.executionMode,
        insertedForResume,
        removeInsertedResume: () => {
          this.removeActiveEntry(runId, false);
        },
        registerResumeUntrack: (done) => {
          this.registerResumeUntrack(runId, done);
        },
        resumeViaSubprocess: () =>
          this.resumeViaSubprocess(runId, stageId, opaqueAnswer),
        reconstructAndContinue: () =>
          this.reconstructAndContinue(runId, stageId, opaqueAnswer),
      });
    } finally {
      if (!isLive) {
        this.resumeInFlight.delete(resumeKey);
      }
    }
  }

  private async resumeViaSubprocess(
    runId: string,
    stageId: string,
    opaqueAnswer: OpaqueAnswer,
  ): Promise<{ ok: boolean; reason?: string }> {
    const cwd = this.options.cwd ?? process.cwd();
    const store = this.options.store;
    const launcher = this.stageProcessLauncher;
    if (!launcher) {
      return { ok: false, reason: "stage process launcher is not configured" };
    }

    const latest = await store.getLatestStageExecution(runId, stageId);
    const attempt = latest?.attempt ?? 1;
    const workspaceDir = store.getWorkspaceDir(runId);
    const sessionFilePath = resumeSessionFilePath(workspaceDir, stageId, attempt);
    const eventOptions = { attempt };

    try {
      const launchResult = await launcher.launch({
        runId,
        stageId,
        rootDir: cwd,
        mode: "resume",
        resumeAnswer: opaqueAnswer,
        attempt,
        sessionFilePath,
        ...(this.options.operatorCatalog !== undefined
          ? { operatorCatalog: this.options.operatorCatalog }
          : {}),
      });

      if (launchResult.type === "waiting") {
        return { ok: true };
      }

      if (launchResult.type === "failed") {
        await store.appendStageEvent(
          runId,
          stageId,
          {
            event: "failed",
            reason: launchResult.reason,
          },
          eventOptions,
        );
        await store.updateRunStatus(runId, "failed");
        return { ok: false, reason: launchResult.reason };
      }

      let initialPrior: StageEnvelope | null = null;
      try {
        initialPrior = await store.readEnvelope(runId, stageId);
      } catch {
        // downstream resume may read envelope from store
      }

      const meta = await store.readRunMeta(runId);
      const taskYaml = await store.readTaskYaml(runId);
      const task = loadTaskFromYaml(taskYaml, `run ${runId} task`);
      const loaded = await loadPipeline(meta.pipeline_id, { cwd });

      const rest = await resumeRun({
        prepared: {
          task,
          loaded,
          run: { runId, workspaceDir: store.getWorkspaceDir(runId) },
          agent: this.options.agent,
          store,
          cwd,
          checkoutRoot: meta.checkout_root,
          hitl: this.hitl,
          operatorCatalog: this.options.operatorCatalog,
        },
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        resumeFromStageId: stageId,
        initialPrior,
        executionMode: this.executionMode,
        stageProcessLauncher: launcher,
      });
      if (rest.outcome === "failed") {
        return { ok: false, reason: rest.reason };
      }
      return { ok: true };
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.message
          : `resume failed: ${String(err)}`;
      try {
        await store.appendStageEvent(
          runId,
          stageId,
          {
            event: "failed",
            reason,
          },
          eventOptions,
        );
        await store.updateRunStatus(runId, "failed");
      } catch {
        // ignore secondary failures
      }
      return { ok: false, reason };
    } finally {
      this.attachedWaiting.delete(`${runId}\0${stageId}`);
    }
  }

  private async reconstructAndContinue(
    runId: string,
    stageId: string,
    opaqueAnswer: OpaqueAnswer,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await resumeReconstructAndContinue({
        runId,
        stageId,
        opaqueAnswer,
        agent: this.options.agent,
        store: this.options.store,
        hitl: this.hitl,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        cwd: this.cwd,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        operatorCatalog: this.options.operatorCatalog,
      });
    } finally {
      this.attachedWaiting.delete(`${runId}\0${stageId}`);
    }
  }

  private async reserveAndStartPipeline(
    taskYaml: string,
    pipelineId: string,
    taskLabel: string,
    cwd: string,
    checkoutOverride?: string,
    skipGates?: boolean,
  ): Promise<StartRunResult> {
    let checkoutKey: string | undefined;
    try {
      const task = loadTaskFromYaml(taskYaml, taskLabel);
      const checkoutRoot = await resolveAndValidateCheckout(
        task,
        checkoutOverride,
        cwd,
      );
      checkoutKey =
        checkoutRoot !== undefined
          ? await toCheckoutLeaseKey(checkoutRoot)
          : undefined;
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 400,
      };
    }

    const reserved = this.tryReserve(checkoutKey);
    if (!reserved.ok) return reserved.failure;

    try {
      const started = await startPipeline({
        agent: this.options.agent,
        store: this.options.store,
        taskYaml,
        pipeline: pipelineId,
        cwd,
        checkoutOverride,
        hitl: this.hitl,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        operatorCatalog: this.options.operatorCatalog,
        skipGates,
      });
      this.track(reserved.provisionalId, started.runId, started.done);
      return { ok: true, runId: started.runId, done: started.done };
    } catch (err) {
      this.clearReservation(reserved.provisionalId);
      if (err instanceof PipelineValidationError) {
        throw err;
      }
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 500,
      };
    }
  }

  private busyFailure(
    code: BusyCode,
    extras?: {
      conflictingRunId?: string;
      conflictingCheckout?: string;
    },
  ): Extract<StartRunResult, { ok: false }> {
    const activeRunIds = this.getActiveRunIds();
    const reason =
      code === "busy_capacity"
        ? `Capacity full: ${this.active.size}/${this.maxConcurrent} active runs`
        : `Checkout in use by run ${extras?.conflictingRunId ?? "unknown"}`;
    return {
      ok: false,
      reason,
      status: 409,
      code,
      activeCount: this.active.size,
      maxConcurrent: this.maxConcurrent,
      activeRunIds,
      ...extras,
    };
  }

  private tryReserve(
    checkoutKey: string | undefined,
  ):
    | { ok: true; provisionalId: string }
    | { ok: false; failure: Extract<StartRunResult, { ok: false }> } {
    if (this.active.size >= this.maxConcurrent) {
      return { ok: false, failure: this.busyFailure("busy_capacity") };
    }
    if (checkoutKey !== undefined) {
      const holder = this.checkoutLeases.get(checkoutKey);
      if (holder !== undefined) {
        const conflictingRunId = this.provisionalIds.has(holder)
          ? undefined
          : holder;
        return {
          ok: false,
          failure: this.busyFailure("busy_checkout", {
            conflictingRunId,
            conflictingCheckout: checkoutKey,
          }),
        };
      }
    }

    const provisionalId = randomUUID();
    this.provisionalIds.add(provisionalId);
    this.active.set(provisionalId, {
      checkoutKey,
      generation: ++this.trackingGeneration,
    });
    if (checkoutKey !== undefined) {
      this.checkoutLeases.set(checkoutKey, provisionalId);
    }
    return { ok: true, provisionalId };
  }

  private clearReservation(provisionalId: string): void {
    this.removeActiveEntry(provisionalId, true);
  }

  private track(
    provisionalId: string,
    runId: string,
    done: Promise<unknown>,
  ): void {
    const entry = this.active.get(provisionalId) ?? {
      generation: ++this.trackingGeneration,
    };
    this.active.delete(provisionalId);
    this.provisionalIds.delete(provisionalId);
    const generation = ++this.trackingGeneration;
    this.active.set(runId, { ...entry, generation });
    if (entry.checkoutKey !== undefined) {
      this.checkoutLeases.set(entry.checkoutKey, runId);
    }
    void done.finally(() => {
      this.untrackIfGeneration(runId, generation);
    });
  }

  /**
   * Acquire active tracking + checkout lease for a restart resume before
   * reconstruct starts. Over-max is allowed. Lease held by another run → fail closed.
   */
  private async ensureResumeTracked(
    runId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.active.has(runId)) {
      return { ok: true };
    }

    let checkoutKey: string | undefined;
    let durableCheckoutRoot: string | undefined;
    try {
      const meta = await this.options.store.readRunMeta(runId);
      const checkoutRoot = meta.checkout_root;
      if (checkoutRoot !== undefined && checkoutRoot !== "") {
        durableCheckoutRoot = checkoutRoot;
        checkoutKey = await toCheckoutLeaseKey(checkoutRoot);
      }
    } catch (err) {
      console.error(
        `invariant: trackResume failed reading checkout_root for run ${runId}; continuing without checkout lease: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const conflictHolder = this.findActiveCheckoutConflict(
      runId,
      checkoutKey,
      durableCheckoutRoot,
    );
    if (conflictHolder !== undefined) {
      return {
        ok: false,
        reason: `duplicate_checkout_resume: checkout already held by ${conflictHolder}`,
      };
    }

    if (checkoutKey !== undefined) {
      this.checkoutLeases.set(checkoutKey, runId);
    }
    this.active.set(runId, {
      checkoutKey,
      durableCheckoutRoot,
      generation: ++this.trackingGeneration,
    });
    return { ok: true };
  }

  private registerResumeUntrack(
    runId: string,
    done: Promise<unknown>,
  ): void {
    const entry = this.active.get(runId);
    if (entry === undefined) return;
    const generation = ++this.trackingGeneration;
    this.active.set(runId, { ...entry, generation });
    void done.finally(() => {
      this.untrackIfGeneration(runId, generation);
    });
  }

  private findActiveCheckoutConflict(
    runId: string,
    checkoutKey: string | undefined,
    durableCheckoutRoot: string | undefined,
  ): string | undefined {
    if (checkoutKey !== undefined) {
      const holder = this.checkoutLeases.get(checkoutKey);
      if (holder !== undefined && holder !== runId) {
        return holder;
      }
    }
    for (const [otherId, entry] of this.active) {
      if (otherId === runId) continue;
      if (
        checkoutKey !== undefined &&
        entry.checkoutKey !== undefined &&
        entry.checkoutKey === checkoutKey
      ) {
        return otherId;
      }
      if (
        durableCheckoutRoot !== undefined &&
        durableCheckoutRoot !== "" &&
        entry.durableCheckoutRoot !== undefined &&
        entry.durableCheckoutRoot === durableCheckoutRoot
      ) {
        return otherId;
      }
    }
    return undefined;
  }

  private async quarantineAttachRun(
    runId: string,
    waitingStages: Array<{ stage_id: string }>,
    reason: string,
  ): Promise<void> {
    for (const stage of waitingStages) {
      try {
        await this.options.store.appendStageEvent(runId, stage.stage_id, {
          event: "failed",
          reason,
        });
      } catch {
        // ignore secondary failures — still fail-closed in memory
      }
    }
    try {
      await this.options.store.updateRunStatus(runId, "failed");
    } catch {
      // ignore secondary failures — still fail-closed in memory
    }
    console.error(reason);
  }

  private untrackIfGeneration(runId: string, generation: number): void {
    const entry = this.active.get(runId);
    if (entry === undefined || entry.generation !== generation) return;
    this.removeActiveEntry(runId, false);
  }

  private removeActiveEntry(id: string, isProvisional: boolean): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    if (isProvisional) {
      this.provisionalIds.delete(id);
    }
    if (
      entry.checkoutKey !== undefined &&
      this.checkoutLeases.get(entry.checkoutKey) === id
    ) {
      this.checkoutLeases.delete(entry.checkoutKey);
    }
  }
}
