import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { RunSubmissionExistsError, type RunSubmission, type RunSubmissionRecord } from "../runstore/submission.js";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentPort, OpaqueAnswer } from "../agent/port.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import { globalStageflowHome } from "../project/globalHome.js";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import { normalizeCatalogPath } from "../runstore/normalizeCatalogPath.js";
import {
  durableRootDiskBreakdown,
  readFilesystemSize,
  refreshRunDiskUsage,
  resolveMinFreeDiskFloor,
  type DiskBreakdown,
  type FreeSpaceReader,
} from "../runstore/diskUsage.js";
import { newRunId } from "../runstore/paths.js";
import { loadRunContext } from "./resumeReconstruct.js";
import {
  assertResumableStage,
  reconstructTimedOutAndContinue,
} from "./resumeTimedOut.js";
import { loadTaskFromYamlOutcome } from "../config/loadTask.js";
import {
  buildValidationResult,
  loadPipelineValidated,
} from "../config/validateCatalog.js";
import {
  deriveStatusFromStages,
  findUnhandledFailedStage,
  type RunMeta,
  type RunStore,
} from "../runstore/port.js";
import { buildPipelineDagSnapshotFromLoaded } from "../runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { TaskFile } from "../types/task.js";
import {
  PipelineValidationError,
  QueuedRunActivationAborted,
  startPipeline,
  type PipelineRunResult,
} from "./pipelineRunner.js";
import {
  hydrateScheduleFromStore,
  hydratedScheduleHasRunnableWork,
  resumeRun,
  runPipelineDag,
} from "./pipelineScheduler.js";
import {
  resolveFeedbackLoopDecision,
  type FeedbackLoopDecisionKind,
} from "./feedbackLoopDecision.js";
import {
  RunRetryCoordinator,
  readRetryRootWaitTimeoutMs,
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
import { logger as rootLogger } from "../logging/logger.js";
import { STAGE_ENV_PASSTHROUGH } from "./stageEnvironment.js";
import { proxyHealthFields } from "../net/proxy.js";
import { getContainerLimits } from "./containerLimits.js";
import { stageflowCacheRoot } from "./stageCacheEnv.js";
import { assertClaudeNotRoot, ClaudeRootError } from "../preflight/claudeRoot.js";
import { asAgentBackendId } from "../agent/agentBackend.js";
import {
  INVALID_SLOT_COUNT_MESSAGE,
  parseSlotCount,
  readMaxConcurrentFromGlobal,
  writeMaxConcurrentToGlobal,
} from "./settingsFile.js";
import {
  StageHitlController,
  waitKey,
  type DeliverAnswerResult,
  type HitlSeams,
} from "./stageHitl.js";
import {
  resolveAndValidateCheckout,
  resolveEffectiveGitIdentity,
  stageBindingEnvFromRun,
} from "./stageRoots.js";
import { orchestrateAnswerResume } from "./answerResume.js";
import { reconstructAndContinue as resumeReconstructAndContinue } from "./resumeReconstruct.js";
import { attemptContext, resumeSessionFilePath } from "./stageAttemptContext.js";
import { checkTaskEntryInput, resolveStartTaskInput, type StartTaskInput } from "./taskInput.js";
import {
  markStageInterrupted,
  OPERATOR_CANCEL_REASON,
  syncRunStatusFromStages,
} from "./stageRecovery.js";
import { deleteRunEverywhere } from "./runDeletion.js";
import {
  runRetentionSweep,
  type RetentionSweepReport,
  type RunRetentionSweepOptions,
} from "./runRetentionSweep.js";
import type { A2aStore } from "../a2a/store.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";
import {
  blocksGenericRetry,
  manualRecoveryEligibility,
  readManualRecoveryState,
  type ManualRecoveryEligibility,
} from "./manualRecoveryState.js";
import { resolveWorkspaceBinding, type WorkspaceBinding } from "./workspaceBinding.js";
import {
  derivedBindingKindFromMeta,
  materializeWorkspaceBinding,
  StartLinkError,
  type StartFailureCode,
} from "./repositoryMaterialize.js";

export type BusyCode = "busy_capacity" | "busy_checkout";

export type { StartFailureCode } from "./repositoryMaterialize.js";

export type StartRunResult =
  | {
      ok: true;
      runId: string;
      done: Promise<PipelineRunResult>;
      queued?: boolean;
      queuePosition?: number;
    }
  | {
      ok: false;
      reason: string;
      status?: number;
      code?: StartFailureCode;
      activeCount?: number;
      maxConcurrent?: number;
      activeRunIds?: string[];
      scope?: "global" | "project";
      project_root?: string;
      conflictingRunId?: string;
      conflictingCheckout?: string;
      freeBytes?: number;
      minFreeBytes?: number;
      stderr?: string;
    };

export const PROJECT_ROOT_UNAVAILABLE_REASON = "project_root_unavailable";
export const INSUFFICIENT_DISK_CANCEL_REASON = "insufficient_disk";

export type CapacityHealth = {
  ok: true;
  activeRunIds: string[];
  activeCount: number;
  maxConcurrent: number;
  slotsAvailable: number;
  activeStageProcesses: number;
  maxActiveStageProcesses: number | null;
  disk?: DiskBreakdown;
  stage_env_passthrough?: boolean;
  proxy?: Record<string, unknown>;
  container?: {
    max_old_space_size_mb: number;
    max_active_stage_processes: number;
    memory_limit_bytes: number | null;
    source: string;
  };
  cache?: { root: string };
};

export type StartRunOnceResult =
  | {
      ok: true;
      runId: string;
      /** False only for the caller whose submission durably created this run for the first time. */
      reused: boolean;
      /**
       * Present when this call observed the run being launched in this process — either it launched
       * the run itself, or it piggybacked on another in-flight call to the same submission key while
       * that launch was still starting. Absent when the submission was already durably committed by
       * an earlier, separate call: `reused: true` does not by itself imply `done` is absent, since a
       * piggybacked call is also `reused: true`. Callers that need completion regardless of which case
       * they hit must still fall back to polling run status by `runId`.
       */
      done?: Promise<PipelineRunResult>;
    }
  | Extract<StartRunResult, { ok: false }>;

function existingSubmissionResult(existing: RunSubmissionRecord, request: RunSubmission): StartRunOnceResult {
  if (existing.requestHash !== request.requestHash) {
    return { ok: false, status: 409, reason: "Submission key was already used for different input" };
  }
  return { ok: true, runId: existing.runId, reused: true };
}

export type { DeliverAnswerResult };

export type { RetryStageResult };

export type AbandonStageResult =
  | { ok: true; runId: string; stageId: string }
  | { ok: false; reason: string; status?: number };

export type CancelRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string; status?: number };

export type DeleteRunChannel = "mcp" | "rest" | "cli";

export type DeleteRunResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string; status?: number };

export type GcRunsChannel = "mcp" | "rest" | "cli" | "periodic";

export type GcRunsResult =
  | ({ ok: true } & RetentionSweepReport)
  | { ok: false; reason: string; status?: number };

export const FORCE_DELETE_CANCEL_REASON = "delete_run: force";

export type DecideFeedbackLoopResult =
  | {
      ok: true;
      effect: "extended" | "continued" | "abandoned";
      loopId: string;
    }
  | { ok: false; reason: string; status?: number };

export type StopManualRecoveryResult =
  | { ok: true; runId: string; stageId: string }
  | { ok: false; reason: string; status?: number };

type ActiveEntry = {
  checkoutKey?: string;
  durableCheckoutRoot?: string;
  projectRoot?: string;
  generation: number;
  done?: Promise<unknown>;
};

type SchedulingHalt = { halted: boolean; hostShutdown: boolean };

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_AUTO_RESUMES = 3;
const STARTUP_RECONCILE_REASON = "orphaned_no_worker";
const AUTO_RESUME_CAPPED_REASON = "auto_resume_capped";
export const STAGEFLOW_AUTO_RESUME_INTERRUPTED =
  "STAGEFLOW_AUTO_RESUME_INTERRUPTED";
export const STAGEFLOW_MAX_AUTO_RESUMES = "STAGEFLOW_MAX_AUTO_RESUMES";
const OPERATOR_ABANDON_REASON =
  "process_interrupted: operator abandoned stage";
const log = rootLogger.child({ component: "runtime" });

function parseMaxConcurrent(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_CONCURRENT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== raw.trim()) {
    throw new Error(
      `Invalid value for STAGEFLOW_MAX_CONCURRENT_RUNS: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function parseMaxQueued(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_QUEUED;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_QUEUED;
  return n;
}

export function isAutoResumeInterruptedEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[STAGEFLOW_AUTO_RESUME_INTERRUPTED];
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

export function parseMaxAutoResumes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[STAGEFLOW_MAX_AUTO_RESUMES];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_AUTO_RESUMES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_AUTO_RESUMES;
  return n;
}

type AdmissionQueueEntry = { runId: string; createdAt: string };

/** Private FIFO-per-project_root + round-robin dequeue (KTD3). */
class AdmissionQueue {
  private readonly byRoot = new Map<string, AdmissionQueueEntry[]>();
  private rrOrder: string[] = [];
  private rrIndex = 0;

  get size(): number {
    let n = 0;
    for (const list of this.byRoot.values()) n += list.length;
    return n;
  }

  clear(): void {
    this.byRoot.clear();
    this.rrOrder = [];
    this.rrIndex = 0;
  }

  enqueue(projectRoot: string, entry: AdmissionQueueEntry): number {
    let list = this.byRoot.get(projectRoot);
    if (list === undefined) {
      list = [];
      this.byRoot.set(projectRoot, list);
      this.rrOrder.push(projectRoot);
    }
    list.push(entry);
    return this.size;
  }

  requeueFront(projectRoot: string, entry: AdmissionQueueEntry): void {
    let list = this.byRoot.get(projectRoot);
    if (list === undefined) {
      list = [];
      this.byRoot.set(projectRoot, list);
      this.rrOrder.push(projectRoot);
    }
    list.unshift(entry);
  }

  remove(runId: string): boolean {
    for (const [root, list] of this.byRoot) {
      const idx = list.findIndex((e) => e.runId === runId);
      if (idx < 0) continue;
      list.splice(idx, 1);
      if (list.length === 0) {
        this.byRoot.delete(root);
        const orderIdx = this.rrOrder.indexOf(root);
        if (orderIdx >= 0) {
          this.rrOrder.splice(orderIdx, 1);
          if (this.rrOrder.length === 0) {
            this.rrIndex = 0;
          } else if (orderIdx < this.rrIndex) {
            this.rrIndex -= 1;
          } else if (this.rrIndex >= this.rrOrder.length) {
            this.rrIndex = 0;
          }
        }
      }
      return true;
    }
    return false;
  }

  positionOf(runId: string): number | undefined {
    let position = 0;
    const rootCount = this.rrOrder.length;
    if (rootCount === 0) return undefined;
    const heads = this.rrOrder.map((root) => ({
      root,
      list: this.byRoot.get(root) ?? [],
      i: 0,
    }));
    let rr = this.rrIndex % rootCount;
    let remaining = this.size;
    while (remaining > 0) {
      let advanced = false;
      for (let step = 0; step < rootCount; step++) {
        const slot = heads[(rr + step) % rootCount];
        if (slot === undefined || slot.i >= slot.list.length) continue;
        const entry = slot.list[slot.i];
        slot.i += 1;
        remaining -= 1;
        position += 1;
        advanced = true;
        if (entry?.runId === runId) return position;
        rr = (rr + step + 1) % rootCount;
        break;
      }
      if (!advanced) break;
    }
    return undefined;
  }

  dequeueNext(
    skipRoots?: ReadonlySet<string>,
  ): { projectRoot: string; entry: AdmissionQueueEntry } | undefined {
    if (this.rrOrder.length === 0) return undefined;
    const start = this.rrIndex % this.rrOrder.length;
    for (let step = 0; step < this.rrOrder.length; step++) {
      const idx = (start + step) % this.rrOrder.length;
      const root = this.rrOrder[idx];
      if (root === undefined) continue;
      if (skipRoots?.has(root)) continue;
      const list = this.byRoot.get(root);
      if (list === undefined || list.length === 0) continue;
      const entry = list.shift();
      if (entry === undefined) continue;
      if (list.length === 0) {
        this.byRoot.delete(root);
        this.rrOrder.splice(idx, 1);
        if (this.rrOrder.length === 0) {
          this.rrIndex = 0;
        } else {
          this.rrIndex = idx % this.rrOrder.length;
        }
      } else {
        this.rrIndex = (idx + 1) % this.rrOrder.length;
      }
      return { projectRoot: root, entry };
    }
    return undefined;
  }
}

type PendingQueuedStart = {
  taskYaml: string;
  pipeline: string | InlinePipelineDefinition;
  taskLabel: string;
  cwd: string;
  projectRoot: string;
  checkoutOverride?: string;
  skipGates?: boolean;
  ciIdentity?: {
    gitSha?: string;
    ciPrUrl?: string;
    ciJobUrl?: string;
  };
  taskPath?: string;
  submission?: RunSubmission;
  pinned?: { ref: string; resolvedSha: string };
  pathCheckoutRoot?: string;
  binding: WorkspaceBinding;
  checkoutKey?: string;
};

type QueuedDoneDeferred = {
  promise: Promise<PipelineRunResult>;
  resolve: (result: PipelineRunResult) => void;
};

async function toCheckoutLeaseKey(absPath: string): Promise<string> {
  try {
    return await realpath(absPath);
  } catch {
    const fallback = path.resolve(absPath);
    log.error(
      "checkout.realpath_failed",
      `invariant: checkout realpath failed for ${absPath}; using path.resolve fallback ${fallback}`,
      { abs_path: absPath, fallback },
    );
    return fallback;
  }
}

export class RunManager {
  private readonly submissionsInFlight = new Map<string, { requestHash: string; result: Promise<StartRunOnceResult> }>();
  private readonly active = new Map<string, ActiveEntry>();
  private readonly schedulingHalts = new Map<string, SchedulingHalt>();
  private readonly checkoutLeases = new Map<string, string>();
  private readonly provisionalIds = new Set<string>();
  private readonly admissionQueue = new AdmissionQueue();
  private readonly pendingQueuedStarts = new Map<string, PendingQueuedStart>();
  private readonly queuedDone = new Map<string, QueuedDoneDeferred>();
  private admissionDrainInFlight = false;
  private readonly resumeInFlight = new Set<string>();
  private readonly retryInFlight = new Set<string>();
  private readonly retryStartOwner = new Map<string, string>();
  private readonly retryStartWaiters = new Map<string, Set<() => void>>();
  private trackingGeneration = 0;
  private maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxConcurrentPerProject: number | undefined;
  private readonly maxActiveStagesPerRun: number;
  private readonly executionMode: StageExecutionMode;
  private readonly stageProcessLauncher: StageProcessLauncher | undefined;
  private a2aStore: A2aStore | undefined;
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
      this.notifyRetryStartWaiters(runId);
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
  private readonly projectRoot: string;
  private readonly isGitProject: boolean;
  private acceptingWork = true;

  constructor(
    private readonly options: {
      agent: AgentPort;
      store: RunStore;
      cwd?: string;
      projectRoot?: string;
      isGitProject?: boolean;
      operatorCatalog?: OperatorCatalog;
      seams?: HitlSeams;
      maxConcurrent?: number;
      maxQueued?: number;
      maxConcurrentPerProject?: number;
      maxActiveStagesPerRun?: number;
      executionMode?: StageExecutionMode;
      stageProcessLauncher?: StageProcessLauncher;
      a2aStore?: A2aStore;
      knownWritableProjectRoots?: () =>
        | Iterable<string>
        | Promise<Iterable<string>>;
      freeSpaceReader?: FreeSpaceReader;
      /** Test-only: await before materialize when activating a queued run. */
      onBeforeQueuedMaterialize?: (runId: string) => void | Promise<void>;
    },
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.projectRoot = options.projectRoot ?? this.cwd;
    this.isGitProject = options.isGitProject ?? false;
    this.a2aStore = options.a2aStore;
    this.maxConcurrent =
      options.maxConcurrent ??
      readMaxConcurrentFromGlobal() ??
      parseMaxConcurrent(process.env.STAGEFLOW_MAX_CONCURRENT_RUNS);
    this.maxQueued =
      options.maxQueued ?? parseMaxQueued(process.env.STAGEFLOW_MAX_QUEUED);
    this.maxConcurrentPerProject = options.maxConcurrentPerProject;
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
    writeMaxConcurrentToGlobal(parsed);
    return this.getHealth();
  }

  getActiveCount(): number {
    return this.active.size;
  }

  stopAcceptingWork(): void {
    this.acceptingWork = false;
    for (const halt of this.schedulingHalts.values()) {
      halt.halted = true;
      halt.hostShutdown = true;
    }
  }

  isAcceptingWork(): boolean {
    return this.acceptingWork;
  }

  async drainActiveStages(options: {
    deadlineMs: number;
    isEscalated?: () => boolean;
  }): Promise<{ forced: boolean }> {
    for (const halt of this.schedulingHalts.values()) {
      halt.halted = true;
      halt.hostShutdown = true;
    }

    const launcher = this.stageProcessLauncher;
    if (launcher === undefined || launcher.activeCount() === 0) {
      return { forced: false };
    }

    const previouslyActive = launcher.getActiveStageProcesses();
    const seenRuns = new Set<string>();
    for (const { runId, stageId } of previouslyActive) {
      await markStageInterrupted({
        store: this.options.store,
        runId,
        stageId,
        reason: "host_shutdown",
        status: "interrupted",
      });
      seenRuns.add(runId);
    }
    for (const runId of seenRuns) {
      await syncRunStatusFromStages(this.options.store, runId).catch(
        () => undefined,
      );
    }

    launcher.signalAllActive("SIGTERM");

    while (
      launcher.activeCount() > 0 &&
      Date.now() < options.deadlineMs &&
      !(options.isEscalated?.() ?? false)
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    const remaining = launcher.getActiveStageProcesses();
    if (remaining.length === 0) {
      return { forced: false };
    }

    launcher.signalAllActive("SIGKILL");
    const killWaitUntil = Date.now() + 500;
    while (launcher.activeCount() > 0 && Date.now() < killWaitUntil) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }

    return { forced: true };
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
    const limits = getContainerLimits();
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
      stage_env_passthrough:
        process.env[STAGE_ENV_PASSTHROUGH]?.trim() === "all",
      proxy: proxyHealthFields(process.env),
      container: {
        max_old_space_size_mb: limits.maxOldSpaceSizeMb,
        max_active_stage_processes: limits.maxActiveStageProcesses,
        memory_limit_bytes: limits.memoryLimitBytes ?? null,
        source: limits.source,
      },
      cache: { root: stageflowCacheRoot() },
    };
  }

  getPerProjectCapacity(): {
    maxConcurrent: number | undefined;
    projects: Array<{
      project_root: string;
      activeCount: number;
      maxConcurrent: number | undefined;
    }>;
  } {
    const byRoot = new Map<string, number>();
    for (const entry of this.active.values()) {
      const root = entry.projectRoot ?? this.projectRoot;
      byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
    }
    return {
      maxConcurrent: this.maxConcurrentPerProject,
      projects: [...byRoot.entries()].map(([project_root, activeCount]) => ({
        project_root,
        activeCount,
        maxConcurrent: this.maxConcurrentPerProject,
      })),
    };
  }

  private countActiveForProject(projectRoot: string): number {
    const normalized = normalizeCatalogPath(projectRoot);
    let n = 0;
    for (const entry of this.active.values()) {
      const root = normalizeCatalogPath(entry.projectRoot ?? this.projectRoot);
      if (root === normalized) n += 1;
    }
    return n;
  }

  /** Capacity plus on-demand durable-root disk breakdown (KTD16). */
  async getHealthWithDisk(): Promise<CapacityHealth> {
    const base = this.getHealth();
    try {
      const disk = await durableRootDiskBreakdown(globalStageflowHome());
      return { ...base, disk };
    } catch {
      return {
        ...base,
        disk: {
          runs_bytes: 0,
          worktrees_bytes: 0,
          repos_bytes: 0,
          state_db_bytes: 0,
          a2a_artifacts_bytes: 0,
          cache_bytes: 0,
          free_bytes: 0,
        },
      };
    }
  }

  /** Refresh cached `disk_bytes` for one run after a terminal transition. */
  async refreshRunDiskBytes(runId: string): Promise<void> {
    await refreshRunDiskUsage(this.options.store, runId);
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
        const kind = derivedBindingKindFromMeta(meta);
        if (kind === "checkout") {
          const checkoutRoot = meta.checkout_root;
          if (checkoutRoot !== undefined && checkoutRoot !== "") {
            durableCheckoutRoot = checkoutRoot;
            checkoutKey = await toCheckoutLeaseKey(checkoutRoot);
          }
        }
      } catch (err) {
        log
          .child({ run_id: runId })
          .error(
            "attach.checkout_root_failed",
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
      let meta;
      try {
        meta = await this.options.store.readRunMeta(summary.run_id);
      } catch (err) {
        log
          .child({ run_id: summary.run_id })
          .error(
            "reconcile.read_meta_failed",
            `reconcileOrphanedStages: failed to read run meta ${summary.run_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        continue;
      }

      if (meta.status === "queued") continue;

      let detail;
      try {
        detail = await this.options.store.readRun(summary.run_id);
      } catch (err) {
        log
          .child({ run_id: summary.run_id })
          .error(
            "reconcile.read_run_failed",
            `reconcileOrphanedStages: failed to read run ${summary.run_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        continue;
      }

      const runId = summary.run_id;
      const cancelled = meta.status === "cancelled";
      let runChanged = false;

      for (const stage of detail.stages) {
        if (cancelled) {
          if (
            stage.status !== "pending" &&
            stage.status !== "running" &&
            stage.status !== "waiting_for_input"
          ) {
            continue;
          }
          try {
            await markStageInterrupted({
              store: this.options.store,
              runId,
              stageId: stage.stage_id,
              reason: OPERATOR_CANCEL_REASON,
              status: "failed",
            });
            reconciled.push({
              runId,
              stageId: stage.stage_id,
              reason: OPERATOR_CANCEL_REASON,
            });
            runChanged = true;
            log
              .child({ run_id: runId, stage_id: stage.stage_id })
              .error(
                "reconcile.orphaned_stage",
                `reconcileOrphanedStages: failed orphaned stage ${runId}/${stage.stage_id}: ${OPERATOR_CANCEL_REASON}`,
                { reason: OPERATOR_CANCEL_REASON },
              );
          } catch (err) {
            log
              .child({ run_id: runId, stage_id: stage.stage_id })
              .error(
                "reconcile.stage_failed",
                `reconcileOrphanedStages: failed to reconcile ${runId}/${stage.stage_id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
          }
          continue;
        }

        if (stage.status !== "running") continue;
        if (this.hasActiveWorker(runId, stage.stage_id)) continue;

        try {
          await markStageInterrupted({
            store: this.options.store,
            runId,
            stageId: stage.stage_id,
            reason: STARTUP_RECONCILE_REASON,
            status: "interrupted",
          });
          reconciled.push({
            runId,
            stageId: stage.stage_id,
            reason: STARTUP_RECONCILE_REASON,
          });
          runChanged = true;
          log
            .child({ run_id: runId, stage_id: stage.stage_id })
            .error(
              "reconcile.orphaned_stage",
              `reconcileOrphanedStages: interrupted orphaned stage ${runId}/${stage.stage_id}: ${STARTUP_RECONCILE_REASON}`,
              { reason: STARTUP_RECONCILE_REASON },
            );
        } catch (err) {
          log
            .child({ run_id: runId, stage_id: stage.stage_id })
            .error(
              "reconcile.stage_failed",
              `reconcileOrphanedStages: failed to reconcile ${runId}/${stage.stage_id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
        }
      }

      if (runChanged && !cancelled) {
        try {
          await syncRunStatusFromStages(this.options.store, runId);
        } catch (err) {
          log
            .child({ run_id: runId })
            .error(
              "reconcile.sync_status_failed",
              `reconcileOrphanedStages: failed to sync run status for ${runId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
        }
      }
    }

    if (reconciled.length > 0) {
      log.error(
        "reconcile.complete",
        `reconcileOrphanedStages: reconciled ${reconciled.length} orphaned stage(s)`,
        { count: reconciled.length },
      );
    }

    return { reconciled };
  }

  async autoResumeInterruptedStages(): Promise<{
    resumed: Array<{ runId: string; stageId: string }>;
    capped: Array<{ runId: string; stageId: string }>;
    skipped: Array<{ runId: string; stageId: string; reason: string }>;
  }> {
    const resumed: Array<{ runId: string; stageId: string }> = [];
    const capped: Array<{ runId: string; stageId: string }> = [];
    const skipped: Array<{ runId: string; stageId: string; reason: string }> =
      [];
    if (!isAutoResumeInterruptedEnabled()) {
      return { resumed, capped, skipped };
    }
    const maxAutoResumes = parseMaxAutoResumes();
    const interrupted =
      await this.options.store.listInterruptedStageExecutions();
    for (const execution of interrupted) {
      const runId = execution.run_id;
      const stageId = execution.stage_id;
      const attempt = execution.attempt;
      const latest = await this.options.store.getLatestStageExecution(
        runId,
        stageId,
      );
      if (latest === null || latest.attempt !== attempt) {
        skipped.push({
          runId,
          stageId,
          reason: "interrupted attempt is not the latest",
        });
        continue;
      }
      if (execution.auto_resume_count >= maxAutoResumes) {
        try {
          await markStageInterrupted({
            store: this.options.store,
            runId,
            stageId,
            reason: AUTO_RESUME_CAPPED_REASON,
            status: "interrupted",
            attemptCtx: attemptContext(attempt),
          });
          capped.push({ runId, stageId });
          log
            .child({ run_id: runId, stage_id: stageId, attempt })
            .info(
              "auto_resume.capped",
              `autoResumeInterruptedStages: capped ${runId}/${stageId} at ${execution.auto_resume_count}`,
              { auto_resume_count: execution.auto_resume_count },
            );
        } catch (err) {
          skipped.push({
            runId,
            stageId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }
      try {
        await this.options.store.updateStageExecution(runId, stageId, attempt, {
          auto_resume_count: execution.auto_resume_count + 1,
        });
        const result = await this.resumeTimedOutStage(runId, stageId, {
          source: "auto",
        });
        if (result.ok) {
          resumed.push({ runId, stageId });
        } else {
          skipped.push({
            runId,
            stageId,
            reason: result.reason ?? "auto resume failed",
          });
        }
      } catch (err) {
        skipped.push({
          runId,
          stageId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { resumed, capped, skipped };
  }

  async resumeStalledSchedules(): Promise<Array<{ runId: string }>> {
    const resumed: Array<{ runId: string }> = [];
    const runs = await this.options.store.listRuns();
    for (const summary of runs) {
      if (summary.status !== "running") continue;
      const runId = summary.run_id;
      if (this.active.has(runId)) continue;
      try {
        if (await this.tryResumeStalledSchedule(runId)) {
          resumed.push({ runId });
        }
      } catch (err) {
        log
          .child({ run_id: runId })
          .error(
            "resume.stalled_failed",
            `resumeStalledSchedules: failed to resume ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
      }
    }
    return resumed;
  }

  /** Rebuild in-memory admission queue from persisted `queued` rows (R27). */
  async reenqueuePersistedQueuedRuns(): Promise<void> {
    const queued = await this.options.store.listRuns({ status: "queued" });
    const ordered = [...queued].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    this.admissionQueue.clear();
    for (const row of ordered) {
      const root = normalizeCatalogPath(row.project_root ?? this.projectRoot);
      this.admissionQueue.enqueue(root, {
        runId: row.run_id,
        createdAt: row.created_at,
      });
      this.ensureQueuedDone(row.run_id);
    }
    await this.drainAdmissionQueue();
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

    await markStageInterrupted({
      store: this.options.store,
      runId,
      stageId,
      reason: OPERATOR_ABANDON_REASON,
      status: "failed",
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

  async cancelRun(runId: string, reason: string): Promise<CancelRunResult> {
    let meta;
    try {
      meta = await this.options.store.readRunMeta(runId);
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    if (meta.status === "cancelled") {
      return { ok: true, runId };
    }

    if (meta.status === "succeeded" || meta.status === "failed") {
      return {
        ok: false,
        reason: `Run is ${meta.status} and cannot be cancelled`,
        status: 409,
      };
    }

    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      return {
        ok: false,
        reason: "Cancel reason is required",
        status: 400,
      };
    }

    await this.options.store.updateRunStatus(runId, "cancelled");
    await this.options.store.setCancelReason(runId, trimmedReason);
    await this.refreshRunDiskBytes(runId).catch(() => undefined);

    const halt = this.schedulingHalts.get(runId);
    if (halt !== undefined) {
      halt.halted = true;
    }

    this.admissionQueue.remove(runId);
    this.pendingQueuedStarts.delete(runId);
    this.resolveQueuedDone(runId, {
      ok: false,
      outcome: "cancelled",
      runDir: this.options.store.getWorkspaceDir(runId),
      runId,
      reason: trimmedReason,
    });

    if (this.stageProcessLauncher !== undefined) {
      await this.stageProcessLauncher.cancelRun(runId);
    }

    const detail = await this.options.store.readRun(runId);
    for (const stage of detail.stages) {
      if (
        stage.status !== "pending" &&
        stage.status !== "running" &&
        stage.status !== "waiting_for_input"
      ) {
        continue;
      }
      const wasWaiting = stage.status === "waiting_for_input";
      await markStageInterrupted({
        store: this.options.store,
        runId,
        stageId: stage.stage_id,
        reason: OPERATOR_CANCEL_REASON,
        status: "failed",
      });
      if (wasWaiting) {
        this.hitl.clearLiveWait(runId, stage.stage_id);
      }
    }

    if (this.active.has(runId)) {
      this.removeActiveEntry(runId, false);
    }

    return { ok: true, runId };
  }

  setA2aStore(store: A2aStore): void {
    this.a2aStore = store;
  }

  async deleteRun(
    runId: string,
    options: { force?: boolean; channel: DeleteRunChannel } = {
      channel: "rest",
    },
  ): Promise<DeleteRunResult> {
    const force = options.force === true;
    const channel = options.channel;

    let meta;
    try {
      meta = await this.options.store.readRunMeta(runId);
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const activeStatus =
      meta.status === "created" ||
      meta.status === "queued" ||
      meta.status === "running";
    if (activeStatus && !force) {
      return {
        ok: false,
        reason: `Run is ${meta.status} and cannot be deleted without force`,
        status: 409,
      };
    }

    if (activeStatus && force) {
      const settle = this.active.get(runId)?.done;
      const cancelled = await this.cancelRun(runId, FORCE_DELETE_CANCEL_REASON);
      if (!cancelled.ok && cancelled.status !== 404) {
        return cancelled;
      }
      if (settle !== undefined) {
        try {
          await this.waitForPromise(settle, 30_000);
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
            status: 500,
          };
        }
      }
    }

    const a2aStore = this.a2aStore;
    if (a2aStore === undefined) {
      return {
        ok: false,
        reason: "A2A store is not available for delete_run",
        status: 500,
      };
    }

    try {
      await deleteRunEverywhere(this.options.store, a2aStore, runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Run not found:")) {
        return { ok: false, reason: message, status: 404 };
      }
      return { ok: false, reason: message, status: 500 };
    }

    log.child({ run_id: runId }).info("delete_run", "run deleted", {
      force,
      channel,
    });

    return { ok: true, runId };
  }

  async gcRuns(
    options: {
      execute?: boolean;
      channel?: GcRunsChannel;
    } & Pick<RunRetentionSweepOptions, "now" | "windows" | "env" | "artifactMaxBytes" | "bareCacheTtlMs"> = {},
  ): Promise<GcRunsResult> {
    const execute = options.execute === true;
    const channel = options.channel ?? "rest";

    let report: RetentionSweepReport;
    try {
      report = await runRetentionSweep(this.options.store, this.a2aStore, {
        execute,
        now: options.now,
        windows: options.windows,
        env: options.env,
        artifactMaxBytes: options.artifactMaxBytes,
        bareCacheTtlMs: options.bareCacheTtlMs,
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 500,
      };
    }

    if (execute) {
      for (const runId of report.slimmed) {
        await this.refreshRunDiskBytes(runId).catch(() => undefined);
      }
      log.info("run_retention_sweep", "retention sweep executed", {
        channel,
        slimmed: report.slimmed,
        purged: report.purged,
        bareCachesEvicted: report.bareCachesEvicted,
      });
    }

    return { ok: true, ...report };
  }

  private async waitForPromise(
    promise: Promise<unknown>,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Timed out waiting for run to settle after force cancel`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async startRunOnce(
    input: Parameters<RunManager["startRun"]>[0],
    submission: RunSubmission,
  ): Promise<StartRunOnceResult> {
    if (!submission.key.trim() || submission.key.length > 256 || !/^[a-f0-9]{64}$/.test(submission.requestHash)) {
      return { ok: false, status: 400, reason: "Submission requires a key and SHA-256 request hash" };
    }
    const pending = this.submissionsInFlight.get(submission.key);
    if (pending) {
      if (pending.requestHash !== submission.requestHash) {
        return { ok: false, status: 409, reason: "Submission key was already used for different input" };
      }
      const result = await pending.result;
      return result.ok ? { ...result, reused: true } : result;
    }
    const result = this.startSubmittedRun(input, submission);
    this.submissionsInFlight.set(submission.key, { requestHash: submission.requestHash, result });
    try {
      return await result;
    } finally {
      this.submissionsInFlight.delete(submission.key);
    }
  }

  private async startSubmittedRun(
    input: Parameters<RunManager["startRun"]>[0],
    submission: RunSubmission,
  ): Promise<StartRunOnceResult> {
    const existing = await this.options.store.getRunBySubmission(submission.key);
    if (existing) return existingSubmissionResult(existing, submission);
    try {
      const result = await this.startRun(input, submission);
      return result.ok ? { ok: true, runId: result.runId, reused: false, done: result.done } : result;
    } catch (error) {
      if (error instanceof RunSubmissionExistsError) return existingSubmissionResult(error.submission, submission);
      throw error;
    }
  }

  async startRun(
    input: StartTaskInput & {
      pipeline: string | InlinePipelineDefinition;
      task?: string | TaskFile;
      checkoutOverride?: string;
      skipGates?: boolean;
      gitSha?: string;
      ciPrUrl?: string;
      ciJobUrl?: string;
    },
    submission?: RunSubmission,
  ): Promise<StartRunResult> {
    if (!this.acceptingWork) {
      return {
        ok: false,
        reason: "Host is shutting down",
        status: 503,
        code: "shutting_down",
      };
    }
    const cwd = this.options.cwd ?? process.cwd();
    // An inline pipeline has no filesystem anchor to derive a project root from.
    const derivedProjectRoot =
      typeof input.pipeline === "string"
        ? (findProjectRoot(path.dirname(path.resolve(cwd, input.pipeline))) ??
          this.projectRoot)
        : this.projectRoot;

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
      {
        gitSha: input.gitSha,
        ciPrUrl: input.ciPrUrl,
        ciJobUrl: input.ciJobUrl,
      },
      derivedProjectRoot,
      resolved.kind === "path" ? resolved.taskPath : undefined,
      submission,
    );
  }

  async rerun(
    runId: string,
    options?: { pinned?: boolean },
  ): Promise<StartRunResult> {
    if (!this.acceptingWork) {
      return {
        ok: false,
        reason: "Host is shutting down",
        status: 503,
        code: "shutting_down",
      };
    }
    const cwd = this.options.cwd ?? process.cwd();

    let pipeline: string;
    let taskYaml: string;
    let rerunCwd = cwd;
    let rerunProjectRoot: string | undefined;
    let pinned:
      | { ref: string; resolvedSha: string }
      | undefined;
    try {
      const meta = await this.options.store.readRunMeta(runId);
      if (!meta.pipeline_path) {
        return {
          ok: false,
          reason: `Run ${runId} is missing pipeline_path; re-run requires stored catalog locators.`,
          status: 400,
        };
      }
      pipeline = normalizeCatalogPath(meta.pipeline_path);
      rerunCwd = meta.project_root
        ? normalizeCatalogPath(meta.project_root)
        : cwd;
      rerunProjectRoot = meta.project_root
        ? normalizeCatalogPath(meta.project_root)
        : undefined;
      taskYaml = await this.options.store.readTaskYaml(runId);
      if (options?.pinned) {
        if (
          meta.resolved_sha === undefined ||
          meta.resolved_sha === "" ||
          meta.ref === undefined ||
          meta.ref === ""
        ) {
          return {
            ok: false,
            reason: `Run ${runId} has no resolved_sha/ref to pin`,
            status: 400,
            code: "pinned_sha_unavailable",
          };
        }
        pinned = { ref: meta.ref, resolvedSha: meta.resolved_sha };
      }
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    return this.reserveAndStartPipeline(
      taskYaml,
      pipeline,
      `run ${runId} task`,
      rerunCwd,
      undefined,
      undefined,
      undefined,
      rerunProjectRoot,
      undefined,
      undefined,
      pinned,
    );
  }

  async retryStage(runId: string, stageId: string): Promise<RetryStageResult> {
    return this.retryStageInternal(runId, stageId, true);
  }

  async resumeTimedOutStage(
    runId: string,
    stageId: string,
    options?: { source?: "explicit" | "auto" },
  ): Promise<RetryStageResult> {
    if (!this.acceptingWork) {
      return {
        ok: false,
        reason: "Host is shutting down",
        status: 503,
        code: "shutting_down",
      };
    }
    const resumeKey = waitKey(runId, stageId);
    if (this.resumeInFlight.has(resumeKey) || this.retryInFlight.has(resumeKey)) {
      return {
        ok: false,
        reason: `Resume already in progress for run ${runId} stage ${stageId}`,
        status: 409,
      };
    }
    this.resumeInFlight.add(resumeKey);

    let detail;
    try {
      detail = await this.options.store.readRun(runId);
    } catch {
      this.resumeInFlight.delete(resumeKey);
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const stageSnap = detail.stages.find((s) => s.stage_id === stageId);
    if (!stageSnap) {
      this.resumeInFlight.delete(resumeKey);
      return { ok: false, reason: `Stage not found: ${stageId}`, status: 404 };
    }
    const eligibility = assertResumableStage(
      stageSnap.status,
      stageSnap.events,
    );
    if (!eligibility.ok) {
      this.resumeInFlight.delete(resumeKey);
      return eligibility;
    }

    const latest = await this.options.store.getLatestStageExecution(
      runId,
      stageId,
    );
    const attemptIndex = latest?.attempt ?? 1;
    if ((options?.source ?? "explicit") === "explicit" && latest !== null) {
      await this.options.store.updateStageExecution(
        runId,
        stageId,
        attemptIndex,
        { auto_resume_count: 0 },
      );
    }
    const wasActive = this.active.has(runId);
    const tracked = await this.ensureResumeTracked(runId);
    if (!tracked.ok) {
      this.resumeInFlight.delete(resumeKey);
      return { ok: false, reason: tracked.reason, status: 409 };
    }
    const insertedForResume = !wasActive;

    try {
      const runProjectRoot = detail.project_root ?? this.projectRoot;
      const done = reconstructTimedOutAndContinue({
        runId,
        stageId,
        agent: this.options.agent,
        store: this.options.store,
        hitl: this.hitl,
        executionMode: this.executionMode,
        cwd: runProjectRoot,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        factoryCwd: runProjectRoot,
        ...(this.stageProcessLauncher !== undefined
          ? { stageProcessLauncher: this.stageProcessLauncher }
          : {}),
        ...(this.options.operatorCatalog !== undefined
          ? { operatorCatalog: this.options.operatorCatalog }
          : {}),
      });
      this.registerResumeUntrack(runId, done);
      const outcome = await done;
      if (!outcome.ok) {
        if (insertedForResume) {
          this.removeActiveEntry(runId, false);
        }
        const missingSession =
          outcome.reason !== undefined &&
          outcome.reason.startsWith("missing session to resume");
        return {
          ok: false,
          reason: outcome.reason ?? "timeout resume failed",
          status: missingSession ? 409 : 500,
        };
      }
      return { ok: true, runId, stageId, attemptIndex };
    } finally {
      this.resumeInFlight.delete(resumeKey);
    }
  }

  async recoverManualStage(
    runId: string,
    stageId: string,
    guidance?: string,
  ): Promise<RetryStageResult> {
    return this.recoverManualStageInternal(runId, stageId, guidance, true);
  }

  async recoverManualStageUntilStop(
    runId: string,
    stageId: string,
    guidance?: string,
  ): Promise<
    | { ok: true; pipeline: PipelineRunResult }
    | Extract<RetryStageResult, { ok: false }>
  > {
    const retryKey = waitKey(runId, stageId);
    const retried = await this.recoverManualStageInternal(
      runId,
      stageId,
      guidance,
      false,
    );
    if (!retried.ok) return retried;
    try {
      if (retried.done === undefined) {
        return {
          ok: false,
          reason: `Recovery orchestration did not start for run ${runId} stage ${stageId}`,
          status: 500,
        };
      }
      return { ok: true, pipeline: await retried.done };
    } finally {
      this.retryInFlight.delete(retryKey);
    }
  }

  private async recoverManualStageInternal(
    runId: string,
    stageId: string,
    guidance: string | undefined,
    awaitRoot: boolean,
  ): Promise<RetryStageResult> {
    if (guidance !== undefined && guidance.trim().length > 4_000) {
      return {
        ok: false,
        reason: "Manual recovery guidance must be 4,000 characters or fewer",
        status: 400,
      };
    }
    const eligibility = await this.manualRecoveryEligibility(runId, stageId);
    if (!eligibility.ok) return eligibility;
    return this.retryStageInternal(runId, stageId, awaitRoot, {
      manualRecovery: true,
      beforeAttemptStart: async (attempt) => {
        await this.options.store.appendStageEvent(
          runId,
          stageId,
          {
            event: "manual_recovery_requested",
            ...(guidance !== undefined && guidance.trim() !== ""
              ? { guidance: guidance.trim() }
              : {}),
          },
          { attempt },
        );
      },
    });
  }

  async stopManualRecovery(
    runId: string,
    stageId: string,
  ): Promise<StopManualRecoveryResult> {
    const eligibility = await this.manualRecoveryEligibility(runId, stageId);
    if (!eligibility.ok) return eligibility;
    await this.options.store.appendStageEvent(
      runId,
      stageId,
      { event: "manual_recovery_stopped" },
      { attempt: eligibility.failedAttempt },
    );
    return { ok: true, runId, stageId };
  }

  async retryStageUntilStop(
    runId: string,
    stageId: string,
  ): Promise<
    | { ok: true; pipeline: PipelineRunResult }
    | Extract<RetryStageResult, { ok: false }>
  > {
    const retryKey = waitKey(runId, stageId);
    const retried = await this.retryStageInternal(runId, stageId, false);
    if (!retried.ok) return retried;
    try {
      if (retried.done === undefined) {
        return {
          ok: false,
          reason: `Retry orchestration did not start for run ${runId} stage ${stageId}`,
          status: 500,
        };
      }
      const pipeline = await retried.done;
      return { ok: true, pipeline };
    } finally {
      this.retryInFlight.delete(retryKey);
    }
  }

  private async retryStageInternal(
    runId: string,
    stageId: string,
    awaitRoot: boolean,
    options?: {
      manualRecovery?: boolean;
      beforeAttemptStart?: (attempt: number) => Promise<void>;
    },
  ): Promise<RetryStageResult> {
    if (!this.acceptingWork) {
      return {
        ok: false,
        reason: "Host is shutting down",
        status: 503,
        code: "shutting_down",
      };
    }
    const retryKey = waitKey(runId, stageId);
    if (this.retryInFlight.has(retryKey)) {
      return {
        ok: false,
        reason: `Retry already in progress for run ${runId} stage ${stageId}`,
        status: 409,
        code: "retry_in_progress",
      };
    }
    this.retryInFlight.add(retryKey);

    if (
      options?.manualRecovery !== true &&
      await this.blocksGenericRetry(runId, stageId)
    ) {
      this.retryInFlight.delete(retryKey);
      return {
        ok: false,
        reason: "Stage uses manual recovery; use the manual recovery action instead of retry",
        status: 409,
        code: "manual_recovery_required",
      };
    }

    try {
      let meta: RunMeta | undefined;
      let orchestrationConflict =
        this.active.has(runId) &&
        !this.attachedWaiting.has(waitKey(runId, stageId));
      if (!this.retryCoordinator.isActive(runId)) {
        const entry = this.active.get(runId);
        const pending = entry?.done;
        const generation = entry?.generation;
        if (
          orchestrationConflict &&
          pending !== undefined &&
          (await this.isStartRunWindingDown(runId))
        ) {
          if (this.claimRetryStart(runId, stageId)) {
            await this.awaitStartRunWindDown(runId, pending, generation);
          } else {
            await this.waitForRetryCoordinatorOrOwnerRelease(runId);
          }
        } else if (!this.claimRetryStart(runId, stageId)) {
          await this.waitForRetryCoordinatorOrOwnerRelease(runId);
        }
        let detail;
        try {
          detail = await this.options.store.readRun(runId);
          meta = await this.options.store.readRunMeta(runId);
        } catch {
          this.retryInFlight.delete(retryKey);
          return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
        }
        orchestrationConflict =
          this.active.has(runId) &&
          !this.attachedWaiting.has(waitKey(runId, stageId)) &&
          !this.retryCoordinator.isActive(runId);
        if (
          orchestrationConflict &&
          !(await this.isStartRunWindingDown(runId))
        ) {
          const hasActiveStage = detail.stages.some(
            (stage) =>
              stage.status === "running" ||
              stage.status === "waiting_for_input",
          );
          if (!hasActiveStage) {
            orchestrationConflict = false;
          }
        }
      }
      if (meta === undefined) {
        try {
          meta = await this.options.store.readRunMeta(runId);
        } catch {
          this.retryInFlight.delete(retryKey);
          return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
        }
      }
      const result = await this.retryCoordinator.retryStage({
        runId,
        stageId,
        store: this.options.store,
        agent: this.options.agent,
        cwd: meta.project_root ?? this.projectRoot,
        operatorCatalog: this.options.operatorCatalog,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        hitl: this.hitl,
        orchestrationConflict,
        tracking: this.retryTracking,
        awaitRoot,
        ...(options?.beforeAttemptStart !== undefined
          ? { beforeAttemptStart: options.beforeAttemptStart }
          : {}),
      });
      if (!result.ok || awaitRoot !== false) {
        this.retryInFlight.delete(retryKey);
      }
      return result;
    } catch (err) {
      this.retryInFlight.delete(retryKey);
      throw err;
    } finally {
      this.releaseRetryStart(runId, stageId);
    }
  }

  private async isStartRunWindingDown(runId: string): Promise<boolean> {
    try {
      const detail = await this.options.store.readRun(runId);
      const meta = await this.options.store.readRunMeta(runId);
      let hasPending = false;
      for (const stage of detail.stages) {
        if (
          stage.status === "running" ||
          stage.status === "waiting_for_input"
        ) {
          return false;
        }
        if (stage.status === "pending") hasPending = true;
      }
      return (
        findUnhandledFailedStage(detail.stages, meta.pipeline_dag) !==
          undefined || !hasPending
      );
    } catch {
      return false;
    }
  }

  private async awaitStartRunWindDown(
    runId: string,
    pending: Promise<unknown>,
    generation: number | undefined,
  ): Promise<void> {
    let pendingError: unknown;
    const settled = pending.then(
      () => undefined,
      (err: unknown) => {
        pendingError = err;
      },
    );
    const timedOut = await this.raceRetryRootTimeout(settled);
    const after = this.active.get(runId);
    const leftGeneration =
      after === undefined || after.generation !== generation;
    if (pendingError !== undefined && !leftGeneration) {
      throw pendingError instanceof Error
        ? pendingError
        : new Error(String(pendingError));
    }
    if (timedOut && !leftGeneration) {
      return;
    }
  }

  private async raceRetryRootTimeout(
    promise: Promise<void>,
  ): Promise<boolean> {
    const ms = readRetryRootWaitTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private claimRetryStart(runId: string, stageId: string): boolean {
    const owner = this.retryStartOwner.get(runId);
    if (owner !== undefined && owner !== stageId) return false;
    this.retryStartOwner.set(runId, stageId);
    return true;
  }

  private releaseRetryStart(runId: string, stageId: string): void {
    if (this.retryStartOwner.get(runId) !== stageId) return;
    this.retryStartOwner.delete(runId);
    this.notifyRetryStartWaiters(runId);
  }

  private notifyRetryStartWaiters(runId: string): void {
    const waiters = this.retryStartWaiters.get(runId);
    if (waiters === undefined) return;
    this.retryStartWaiters.delete(runId);
    for (const resolve of waiters) resolve();
  }

  private async waitForRetryCoordinatorOrOwnerRelease(
    runId: string,
  ): Promise<void> {
    if (
      this.retryCoordinator.isActive(runId) ||
      !this.retryStartOwner.has(runId)
    ) {
      return;
    }
    let onReady: (() => void) | undefined;
    const watched = new Promise<void>((resolve) => {
      const list = this.retryStartWaiters.get(runId) ?? new Set();
      onReady = () => resolve();
      list.add(onReady);
      this.retryStartWaiters.set(runId, list);
      if (
        this.retryCoordinator.isActive(runId) ||
        !this.retryStartOwner.has(runId)
      ) {
        resolve();
      }
    });
    try {
      await this.raceRetryRootTimeout(watched);
    } finally {
      if (onReady !== undefined) {
        const list = this.retryStartWaiters.get(runId);
        if (list !== undefined) {
          list.delete(onReady);
          if (list.size === 0) this.retryStartWaiters.delete(runId);
        }
      }
    }
  }

  private async manualRecoveryEligibility(
    runId: string,
    stageId: string,
  ): Promise<ManualRecoveryEligibility> {
    try {
      const eligibility = manualRecoveryEligibility(
        await readManualRecoveryState(this.options.store, runId, stageId),
      );
      if (!eligibility.ok) {
        return {
          ...eligibility,
          reason:
            eligibility.reason === "Stage is not configured for manual recovery"
              ? `${eligibility.reason}: ${stageId}`
              : eligibility.reason === "Stage not found"
                ? `${eligibility.reason}: ${stageId}`
                : eligibility.reason,
        };
      }
      return eligibility;
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }
  }

  private async blocksGenericRetry(
    runId: string,
    stageId: string,
  ): Promise<boolean> {
    try {
      return blocksGenericRetry(
        await readManualRecoveryState(this.options.store, runId, stageId),
      );
    } catch {
      return false;
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

  /**
   * Resolve a feedback-loop wait_for_human decision after the scheduler has
   * exited waiting (host-down / HTTP / CLI). Persist-only resolve, then
   * resume orchestration for extend/continue.
   */
  async decideFeedbackLoop(
    runId: string,
    stageId: string,
    input: {
      decision: FeedbackLoopDecisionKind;
      loopId?: string;
      reason?: string;
    },
  ): Promise<DecideFeedbackLoopResult> {
    const resumeKey = waitKey(runId, stageId);
    if (this.resumeInFlight.has(resumeKey)) {
      return {
        ok: false,
        reason: `Resume already in progress for run ${runId} stage ${stageId}`,
        status: 409,
      };
    }
    this.resumeInFlight.add(resumeKey);

    let detail;
    try {
      detail = await this.options.store.readRun(runId);
    } catch {
      this.resumeInFlight.delete(resumeKey);
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const stageSnap = detail.stages.find((s) => s.stage_id === stageId);
    if (!stageSnap) {
      this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `Stage not found: ${stageId}`,
        status: 404,
      };
    }

    const active = detail.active_feedback_loop;
    if (
      active === undefined ||
      active.state !== "waiting_for_human"
    ) {
      this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: "no feedback loop is waiting_for_human",
        status: 409,
      };
    }
    if (active.source_stage_id !== stageId) {
      this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `stage "${stageId}" is not the feedback loop source (expected ${active.source_stage_id})`,
        status: 409,
      };
    }
    if (
      input.loopId !== undefined &&
      input.loopId !== active.loop_id
    ) {
      this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `feedback loop not found: ${input.loopId}`,
        status: 404,
      };
    }
    if (stageSnap.status !== "waiting_for_input") {
      this.resumeInFlight.delete(resumeKey);
      return {
        ok: false,
        reason: `Stage is not waiting for input (status=${stageSnap.status})`,
        status: 409,
      };
    }

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
    const insertedForResume = !wasActive;

    try {
      const decided = await resolveFeedbackLoopDecision({
        store: this.options.store,
        runId,
        decision: input.decision,
        loopId: input.loopId ?? active.loop_id,
        reason: input.reason,
      });
      if (!decided.ok) {
        if (insertedForResume) {
          this.removeActiveEntry(runId, false);
        }
        return { ok: false, reason: decided.reason, status: 409 };
      }

      if (decided.effect === "abandoned") {
        if (insertedForResume) {
          this.removeActiveEntry(runId, false);
        }
        return {
          ok: true,
          effect: "abandoned",
          loopId: decided.loop.loop_id,
        };
      }

      const { meta, task, loaded } = await loadRunContext(
        this.options.store,
        runId,
        this.cwd,
      );
      const runProjectRoot = meta.project_root ?? this.projectRoot;
      const done = runPipelineDag({
        prepared: {
          task,
          loaded,
          run: {
            runId,
            workspaceDir: this.options.store.getWorkspaceDir(runId),
          },
          agent: this.options.agent,
          store: this.options.store,
          cwd: runProjectRoot,
          projectRoot: runProjectRoot,
          checkoutRoot: meta.checkout_root,
          hitl: this.hitl,
          operatorCatalog: this.options.operatorCatalog,
        },
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        schedulingHalt: this.ensureSchedulingHalt(runId),
      });
      this.registerResumeUntrack(runId, done);
      const rest = await done;
      if (rest.outcome === "failed") {
        return {
          ok: false,
          reason: rest.reason ?? "pipeline failed after feedback decision",
          status: 500,
        };
      }
      return {
        ok: true,
        effect: decided.effect === "extended" ? "extended" : "continued",
        loopId: decided.loop.loop_id,
      };
    } catch (err) {
      if (insertedForResume) {
        this.removeActiveEntry(runId, false);
      }
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 500,
      };
    } finally {
      this.resumeInFlight.delete(resumeKey);
    }
  }

  private async resumeViaSubprocess(
    runId: string,
    stageId: string,
    opaqueAnswer: OpaqueAnswer,
  ): Promise<{ ok: boolean; reason?: string }> {
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
      const runMeta = await store.readRunMeta(runId);
      const runProjectRoot = runMeta.project_root ?? this.projectRoot;
      const { meta, task, loaded } = await loadRunContext(
        store,
        runId,
        runProjectRoot,
      );
      const stageBinding = stageBindingEnvFromRun({
        meta,
        task,
        runWorkspaceDir: workspaceDir,
        hostEnv: process.env,
      });
      const launchResult = await launcher.launch({
        runId,
        stageId,
        rootDir: runProjectRoot,
        mode: "resume",
        resumeAnswer: opaqueAnswer,
        attempt,
        sessionFilePath,
        env: stageBinding.env,
        bindingKind: stageBinding.kind,
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

      const rest = await resumeRun({
        prepared: {
          task,
          loaded,
          run: { runId, workspaceDir: store.getWorkspaceDir(runId) },
          agent: this.options.agent,
          store,
          cwd: meta.project_root ?? this.projectRoot,
          projectRoot: meta.project_root ?? this.projectRoot,
          checkoutRoot: meta.checkout_root,
          hitl: this.hitl,
          operatorCatalog: this.options.operatorCatalog,
        },
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        resumeFromStageId: stageId,
        initialPrior,
        executionMode: this.executionMode,
        stageProcessLauncher: launcher,
        schedulingHalt: this.ensureSchedulingHalt(runId),
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
        factoryCwd: this.projectRoot,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        operatorCatalog: this.options.operatorCatalog,
      });
    } finally {
      this.attachedWaiting.delete(`${runId}\0${stageId}`);
    }
  }

  private async reserveAndStartPipeline(
    taskYaml: string,
    pipeline: string | InlinePipelineDefinition,
    taskLabel: string,
    cwd: string,
    checkoutOverride?: string,
    skipGates?: boolean,
    ciIdentity?: {
      gitSha?: string;
      ciPrUrl?: string;
      ciJobUrl?: string;
    },
    projectRoot?: string,
    taskPath?: string,
    submission?: RunSubmission,
    pinned?: { ref: string; resolvedSha: string },
  ): Promise<StartRunResult> {
    const resolvedProjectRoot = normalizeCatalogPath(
      projectRoot ?? this.projectRoot,
    );
    let task: TaskFile;
    let checkoutKey: string | undefined;
    let pathCheckoutRoot: string | undefined;
    let binding: WorkspaceBinding;
    let pipelineId: string;
    let pipelineDag: ReturnType<typeof buildPipelineDagSnapshotFromLoaded>;
    let pipelinePath: string | undefined;
    try {
      const loadedTask = loadTaskFromYamlOutcome(taskYaml, taskLabel);
      if (!loadedTask.ok) {
        const issue = loadedTask.issues[0];
        return {
          ok: false,
          reason: issue?.message ?? "Invalid task",
          status: 400,
          ...(issue?.code !== undefined
            ? { code: issue.code as StartFailureCode }
            : {}),
        };
      }
      task = loadedTask.value;
      const bindingOutcome = resolveWorkspaceBinding(task, { checkoutOverride });
      if (!bindingOutcome.ok) {
        const issue = bindingOutcome.issues[0];
        return {
          ok: false,
          reason: issue?.message ?? "Invalid workspace binding",
          status: 400,
          ...(issue?.code !== undefined
            ? { code: issue.code as StartFailureCode }
            : {}),
        };
      }
      binding = bindingOutcome.value;
      if (binding.kind === "checkout") {
        pathCheckoutRoot = await resolveAndValidateCheckout(
          task,
          checkoutOverride,
          cwd,
        );
        checkoutKey =
          pathCheckoutRoot !== undefined
            ? await toCheckoutLeaseKey(pathCheckoutRoot)
            : undefined;
      }

      const loadResult = await loadPipelineValidated(pipeline, {
        cwd,
        projectRoot: resolvedProjectRoot,
        validateStages: true,
      });
      if (!loadResult.ok) {
        throw new PipelineValidationError(
          buildValidationResult("pipeline", loadResult.findings, false),
        );
      }
      const pairing = checkTaskEntryInput(task, loadResult.loaded, {
        cwd,
        taskPath,
      });
      if (pairing.some((finding) => finding.severity === "error")) {
        throw new PipelineValidationError(
          buildValidationResult("pipeline", pairing, false),
        );
      }
      pipelineId = loadResult.loaded.pipeline.id;
      pipelineDag = buildPipelineDagSnapshotFromLoaded(loadResult.loaded);
      pipelinePath =
        typeof pipeline === "string"
          ? normalizeCatalogPath(loadResult.loaded.pipelinePath)
          : undefined;
      try {
        const pipelineAgent = asAgentBackendId(loadResult.loaded.pipeline.agent);
        assertClaudeNotRoot({ backendId: pipelineAgent });
        for (const stage of loadResult.loaded.stages) {
          assertClaudeNotRoot({
            backendId: asAgentBackendId(stage.agent) ?? pipelineAgent,
          });
        }
      } catch (err) {
        if (err instanceof ClaudeRootError) {
          return { ok: false, reason: err.message, status: 400, code: err.code };
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof PipelineValidationError) throw err;
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        status: 400,
      };
    }

    const diskGate = await this.checkDiskFloorAdmission();
    if (diskGate !== undefined) return diskGate;

    const admitted = this.tryAdmitOrEnqueue(checkoutKey, resolvedProjectRoot);
    if (admitted.action === "reject") return admitted.failure;

    if (admitted.action === "enqueue") {
      const runId = newRunId();
      const gitIdentity = resolveEffectiveGitIdentity(
        process.env,
        task.git_identity,
      );
      const created = await this.options.store.createRun({
        submission,
        runId,
        pipelineId,
        taskYaml,
        taskId: task.id,
        pipelineDag,
        pipelinePath,
        taskPath: taskPath
          ? normalizeCatalogPath(path.resolve(cwd, taskPath))
          : undefined,
        projectRoot: resolvedProjectRoot,
        gitSha: ciIdentity?.gitSha,
        ciPrUrl: ciIdentity?.ciPrUrl,
        ciJobUrl: ciIdentity?.ciJobUrl,
        gitAuthorName: gitIdentity.name,
        gitAuthorEmail: gitIdentity.email,
        status: "queued",
      });
      const meta = await this.options.store.readRunMeta(created.runId);
      const queuePosition = this.admissionQueue.enqueue(resolvedProjectRoot, {
        runId: created.runId,
        createdAt: meta.created_at,
      });
      this.pendingQueuedStarts.set(created.runId, {
        taskYaml,
        pipeline,
        taskLabel,
        cwd,
        projectRoot: resolvedProjectRoot,
        checkoutOverride,
        skipGates,
        ciIdentity,
        taskPath,
        submission,
        pinned,
        pathCheckoutRoot,
        binding,
        checkoutKey,
      });
      const done = this.ensureQueuedDone(created.runId);
      return {
        ok: true,
        runId: created.runId,
        done,
        queued: true,
        queuePosition,
      };
    }

    const runId = newRunId();
    let rollback: () => Promise<void> = async () => {};
    try {
      const { materialized, rollback: linkRollback } =
        await materializeWorkspaceBinding({
          runId,
          task,
          binding,
          checkoutRoot: pathCheckoutRoot,
          pinned,
        });
      rollback = linkRollback;

      const schedulingHalt = this.ensureSchedulingHalt(materialized.runId);
      const started = await startPipeline({
        submission,
        agent: this.options.agent,
        store: this.options.store,
        taskYaml,
        taskPath,
        pipeline,
        cwd,
        projectRoot: resolvedProjectRoot,
        checkoutOverride,
        runId: materialized.runId,
        checkoutRoot: materialized.checkoutRoot,
        repository: materialized.repository,
        ref: materialized.ref,
        resolvedSha: materialized.resolvedSha,
        runBranch: materialized.runBranch,
        gitSha: ciIdentity?.gitSha,
        ciPrUrl: ciIdentity?.ciPrUrl,
        ciJobUrl: ciIdentity?.ciJobUrl,
        hitl: this.hitl,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        operatorCatalog: this.options.operatorCatalog,
        skipGates,
        schedulingHalt,
      });
      this.track(admitted.provisionalId, started.runId, started.done);
      return { ok: true, runId: started.runId, done: started.done };
    } catch (err) {
      await rollback().catch(() => undefined);
      this.clearReservation(admitted.provisionalId);
      if (err instanceof PipelineValidationError || err instanceof RunSubmissionExistsError) {
        throw err;
      }
      if (err instanceof StartLinkError) {
        return {
          ok: false,
          reason: err.message,
          status: err.status,
          code: err.code,
          ...(err.stderr !== undefined ? { stderr: err.stderr } : {}),
        };
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
      scope?: "global" | "project";
      project_root?: string;
      activeCount?: number;
      maxConcurrent?: number;
    },
  ): Extract<StartRunResult, { ok: false }> {
    const activeRunIds = this.getActiveRunIds();
    const scope = extras?.scope ?? "global";
    const activeCount = extras?.activeCount ?? this.active.size;
    const maxConcurrent = extras?.maxConcurrent ?? this.maxConcurrent;
    const reason =
      code === "busy_capacity"
        ? scope === "project"
          ? `Project capacity full: ${activeCount}/${maxConcurrent} active runs for ${extras?.project_root ?? "project"}`
          : this.active.size >= this.maxConcurrent &&
              this.admissionQueue.size >= this.maxQueued &&
              this.maxQueued > 0
            ? `Admission queue full: ${this.admissionQueue.size}/${this.maxQueued} queued runs`
            : `Capacity full: ${this.active.size}/${this.maxConcurrent} active runs`
        : `Checkout in use by run ${extras?.conflictingRunId ?? "unknown"}`;
    return {
      ok: false,
      reason,
      status: 409,
      code,
      activeCount,
      maxConcurrent,
      activeRunIds,
      scope,
      ...(extras?.project_root !== undefined
        ? { project_root: extras.project_root }
        : {}),
      ...(extras?.conflictingRunId !== undefined
        ? { conflictingRunId: extras.conflictingRunId }
        : {}),
      ...(extras?.conflictingCheckout !== undefined
        ? { conflictingCheckout: extras.conflictingCheckout }
        : {}),
    };
  }

  private insufficientDiskFailure(
    freeBytes: number,
    minFreeBytes: number,
  ): Extract<StartRunResult, { ok: false }> {
    return {
      ok: false,
      reason: `Insufficient free disk: ${freeBytes} bytes free, floor ${minFreeBytes} bytes`,
      status: 409,
      code: "insufficient_disk",
      freeBytes,
      minFreeBytes,
    };
  }

  private async checkDiskFloorAdmission(): Promise<
    Extract<StartRunResult, { ok: false }> | undefined
  > {
    try {
      const readFree =
        this.options.freeSpaceReader ?? readFilesystemSize;
      const size = await readFree(globalStageflowHome());
      const minFreeBytes = resolveMinFreeDiskFloor(
        process.env.STAGEFLOW_MIN_FREE_DISK_BYTES,
        size.totalBytes,
      );
      if (size.freeBytes < minFreeBytes) {
        return this.insufficientDiskFailure(size.freeBytes, minFreeBytes);
      }
      return undefined;
    } catch (err) {
      // Default floor is always active via resolveMinFreeDiskFloor — fail closed.
      return {
        ok: false,
        reason: `Disk free-space check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: 503,
        code: "disk_check_failed",
      };
    }
  }

  private async isProjectRootAvailable(projectRoot: string): Promise<boolean> {
    const provider = this.options.knownWritableProjectRoots;
    if (provider !== undefined) {
      const roots = [...(await provider())].map((r) => normalizeCatalogPath(r));
      const normalized = normalizeCatalogPath(projectRoot);
      return roots.includes(normalized);
    }
    try {
      await access(projectRoot, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private tryAdmitOrEnqueue(
    checkoutKey: string | undefined,
    projectRoot: string = this.projectRoot,
  ):
    | { action: "reserve"; provisionalId: string }
    | { action: "enqueue" }
    | { action: "reject"; failure: Extract<StartRunResult, { ok: false }> } {
    if (checkoutKey !== undefined) {
      const holder = this.checkoutLeases.get(checkoutKey);
      if (holder !== undefined) {
        const conflictingRunId = this.provisionalIds.has(holder)
          ? undefined
          : holder;
        return {
          action: "reject",
          failure: this.busyFailure("busy_checkout", {
            conflictingRunId,
            conflictingCheckout: checkoutKey,
          }),
        };
      }
    }

    const normalizedRoot = normalizeCatalogPath(projectRoot);
    if (this.maxConcurrentPerProject !== undefined) {
      const projectActive = this.countActiveForProject(normalizedRoot);
      if (projectActive >= this.maxConcurrentPerProject) {
        return {
          action: "reject",
          failure: this.busyFailure("busy_capacity", {
            scope: "project",
            project_root: normalizedRoot,
            activeCount: projectActive,
            maxConcurrent: this.maxConcurrentPerProject,
          }),
        };
      }
    }

    if (this.active.size < this.maxConcurrent) {
      const provisionalId = randomUUID();
      this.provisionalIds.add(provisionalId);
      this.active.set(provisionalId, {
        checkoutKey,
        projectRoot: normalizedRoot,
        generation: ++this.trackingGeneration,
      });
      if (checkoutKey !== undefined) {
        this.checkoutLeases.set(checkoutKey, provisionalId);
      }
      return { action: "reserve", provisionalId };
    }

    if (this.admissionQueue.size < this.maxQueued) {
      return { action: "enqueue" };
    }

    return {
      action: "reject",
      failure: this.busyFailure("busy_capacity", { scope: "global" }),
    };
  }

  private tryReserve(
    checkoutKey: string | undefined,
    projectRoot: string = this.projectRoot,
  ):
    | { ok: true; provisionalId: string }
    | { ok: false; failure: Extract<StartRunResult, { ok: false }> } {
    const admitted = this.tryAdmitOrEnqueue(checkoutKey, projectRoot);
    if (admitted.action === "reserve") {
      return { ok: true, provisionalId: admitted.provisionalId };
    }
    if (admitted.action === "enqueue") {
      return { ok: false, failure: this.busyFailure("busy_capacity") };
    }
    return { ok: false, failure: admitted.failure };
  }

  private ensureQueuedDone(runId: string): Promise<PipelineRunResult> {
    const existing = this.queuedDone.get(runId);
    if (existing !== undefined) return existing.promise;
    let resolve!: (result: PipelineRunResult) => void;
    const promise = new Promise<PipelineRunResult>((res) => {
      resolve = res;
    });
    this.queuedDone.set(runId, { promise, resolve });
    return promise;
  }

  private resolveQueuedDone(runId: string, result: PipelineRunResult): void {
    const deferred = this.queuedDone.get(runId);
    if (deferred === undefined) return;
    this.queuedDone.delete(runId);
    deferred.resolve(result);
  }

  private attachQueuedDone(
    runId: string,
    done: Promise<PipelineRunResult>,
  ): void {
    void done.then(
      (result) => this.resolveQueuedDone(runId, result),
      (err) =>
        this.resolveQueuedDone(runId, {
          ok: false,
          outcome: "failed",
          runDir: this.options.store.getWorkspaceDir(runId),
          runId,
          reason: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  private async drainAdmissionQueue(): Promise<void> {
    if (!this.acceptingWork) return;
    if (this.admissionDrainInFlight) return;
    this.admissionDrainInFlight = true;
    try {
      const blockedRoots = new Set<string>();
      while (this.acceptingWork && this.active.size < this.maxConcurrent) {
        const next = this.admissionQueue.dequeueNext(blockedRoots);
        if (next === undefined) break;
        const outcome = await this.startDequeuedAdmission(next);
        if (outcome === "checkout_busy") {
          this.admissionQueue.requeueFront(next.projectRoot, next.entry);
          blockedRoots.add(next.projectRoot);
          continue;
        }
        if (outcome === "project_capacity_busy") {
          // Already requeued once inside startDequeuedAdmission.
          blockedRoots.add(next.projectRoot);
          continue;
        }
        if (outcome === "capacity_busy") {
          // Already requeued once inside startDequeuedAdmission.
          break;
        }
      }
    } finally {
      this.admissionDrainInFlight = false;
    }
  }

  private async startDequeuedAdmission(next: {
    projectRoot: string;
    entry: AdmissionQueueEntry;
  }): Promise<
    | "started"
    | "checkout_busy"
    | "project_capacity_busy"
    | "capacity_busy"
    | "cancelled"
  > {
    if (!this.acceptingWork) {
      this.admissionQueue.requeueFront(next.projectRoot, next.entry);
      return "capacity_busy";
    }
    const { runId } = next.entry;
    let meta;
    try {
      meta = await this.options.store.readRunMeta(runId);
    } catch {
      this.pendingQueuedStarts.delete(runId);
      return "cancelled";
    }
    if (meta.status !== "queued") {
      this.pendingQueuedStarts.delete(runId);
      return "cancelled";
    }

    if (!(await this.isProjectRootAvailable(next.projectRoot))) {
      await this.cancelRun(runId, PROJECT_ROOT_UNAVAILABLE_REASON);
      return "cancelled";
    }

    const diskGate = await this.checkDiskFloorAdmission();
    if (diskGate !== undefined) {
      await this.cancelRun(runId, INSUFFICIENT_DISK_CANCEL_REASON);
      return "cancelled";
    }

    const pending = this.pendingQueuedStarts.get(runId);
    let taskYaml: string;
    let task: TaskFile;
    let binding: WorkspaceBinding;
    let pathCheckoutRoot: string | undefined;
    let checkoutKey: string | undefined;
    let pipeline: string | InlinePipelineDefinition;
    let cwd: string;
    let projectRoot: string;
    let checkoutOverride: string | undefined;
    let skipGates: boolean | undefined;
    let ciIdentity: PendingQueuedStart["ciIdentity"];
    let taskPath: string | undefined;
    let submission: RunSubmission | undefined;
    let pinned: PendingQueuedStart["pinned"];

    try {
      if (pending !== undefined) {
        taskYaml = pending.taskYaml;
        binding = pending.binding;
        pathCheckoutRoot = pending.pathCheckoutRoot;
        checkoutKey = pending.checkoutKey;
        pipeline = pending.pipeline;
        cwd = pending.cwd;
        projectRoot = pending.projectRoot;
        checkoutOverride = pending.checkoutOverride;
        skipGates = pending.skipGates;
        ciIdentity = pending.ciIdentity;
        taskPath = pending.taskPath;
        submission = pending.submission;
        pinned = pending.pinned;
        const loadedTask = loadTaskFromYamlOutcome(taskYaml, pending.taskLabel);
        if (!loadedTask.ok) {
          await this.cancelRun(
            runId,
            loadedTask.issues[0]?.message ?? "Invalid task",
          );
          return "cancelled";
        }
        task = loadedTask.value;
      } else {
        taskYaml = await this.options.store.readTaskYaml(runId);
        const loadedTask = loadTaskFromYamlOutcome(
          taskYaml,
          `run ${runId} task`,
        );
        if (!loadedTask.ok) {
          await this.cancelRun(
            runId,
            loadedTask.issues[0]?.message ?? "Invalid task",
          );
          return "cancelled";
        }
        task = loadedTask.value;
        const bindingOutcome = resolveWorkspaceBinding(task, {});
        if (!bindingOutcome.ok) {
          await this.cancelRun(
            runId,
            bindingOutcome.issues[0]?.message ?? "Invalid workspace binding",
          );
          return "cancelled";
        }
        binding = bindingOutcome.value;
        cwd = meta.project_root ?? this.cwd;
        projectRoot = normalizeCatalogPath(meta.project_root ?? this.projectRoot);
        if (binding.kind === "checkout") {
          pathCheckoutRoot = await resolveAndValidateCheckout(task, undefined, cwd);
          checkoutKey =
            pathCheckoutRoot !== undefined
              ? await toCheckoutLeaseKey(pathCheckoutRoot)
              : undefined;
        }
        if (!meta.pipeline_path) {
          await this.cancelRun(runId, "pipeline_path unavailable after restart");
          return "cancelled";
        }
        pipeline = normalizeCatalogPath(meta.pipeline_path);
        taskPath = meta.task_path;
        ciIdentity = {
          gitSha: meta.git_sha,
          ciPrUrl: meta.ci_pr_url,
          ciJobUrl: meta.ci_job_url,
        };
      }
    } catch (err) {
      await this.cancelRun(
        runId,
        err instanceof Error ? err.message : String(err),
      );
      return "cancelled";
    }

    const reserved = this.tryReserve(checkoutKey, projectRoot);
    if (!reserved.ok) {
      if (reserved.failure.code === "busy_checkout") {
        return "checkout_busy";
      }
      this.admissionQueue.requeueFront(next.projectRoot, next.entry);
      if (
        reserved.failure.code === "busy_capacity" &&
        reserved.failure.scope === "project"
      ) {
        return "project_capacity_busy";
      }
      return "capacity_busy";
    }

    let rollback: () => Promise<void> = async () => {};
    try {
      if (this.options.onBeforeQueuedMaterialize !== undefined) {
        await this.options.onBeforeQueuedMaterialize(runId);
      }
      const { materialized, rollback: linkRollback } =
        await materializeWorkspaceBinding({
          runId,
          task,
          binding,
          checkoutRoot: pathCheckoutRoot,
          pinned,
        });
      rollback = linkRollback;

      let metaAfterMaterialize;
      try {
        metaAfterMaterialize = await this.options.store.readRunMeta(runId);
      } catch {
        await rollback().catch(() => undefined);
        this.clearReservation(reserved.provisionalId);
        this.pendingQueuedStarts.delete(runId);
        return "cancelled";
      }
      if (metaAfterMaterialize.status !== "queued") {
        await rollback().catch(() => undefined);
        this.clearReservation(reserved.provisionalId);
        this.pendingQueuedStarts.delete(runId);
        this.schedulingHalts.delete(runId);
        return "cancelled";
      }

      const schedulingHalt = this.ensureSchedulingHalt(runId);
      const started = await startPipeline({
        submission,
        agent: this.options.agent,
        store: this.options.store,
        taskYaml,
        taskPath,
        pipeline,
        cwd,
        projectRoot,
        checkoutOverride,
        runId: materialized.runId,
        reuseExistingRun: true,
        checkoutRoot: materialized.checkoutRoot,
        repository: materialized.repository,
        ref: materialized.ref,
        resolvedSha: materialized.resolvedSha,
        runBranch: materialized.runBranch,
        gitSha: ciIdentity?.gitSha,
        ciPrUrl: ciIdentity?.ciPrUrl,
        ciJobUrl: ciIdentity?.ciJobUrl,
        hitl: this.hitl,
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        operatorCatalog: this.options.operatorCatalog,
        skipGates,
        schedulingHalt,
      });
      this.pendingQueuedStarts.delete(runId);
      this.track(reserved.provisionalId, started.runId, started.done);
      this.attachQueuedDone(started.runId, started.done);
      return "started";
    } catch (err) {
      await rollback().catch(() => undefined);
      this.clearReservation(reserved.provisionalId);
      this.pendingQueuedStarts.delete(runId);
      this.schedulingHalts.delete(runId);
      if (err instanceof QueuedRunActivationAborted) {
        return "cancelled";
      }
      const reason =
        err instanceof StartLinkError
          ? err.code
          : err instanceof Error
            ? err.message
            : String(err);
      await this.cancelRun(runId, reason);
      return "cancelled";
    }
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
    this.active.set(runId, { ...entry, generation, done });
    if (entry.checkoutKey !== undefined) {
      this.checkoutLeases.set(entry.checkoutKey, runId);
    }
    void done.finally(() => {
      this.untrackIfGeneration(runId, generation);
    });
  }

  private async tryResumeStalledSchedule(runId: string): Promise<boolean> {
    const detail = await this.options.store.readRun(runId);
    const meta = await this.options.store.readRunMeta(runId);
    if (
      detail.stages.some(
        (stage) =>
          stage.status === "running" || stage.status === "waiting_for_input",
      )
    ) {
      return false;
    }
    if (deriveStatusFromStages(detail.stages, meta.pipeline_dag) !== "running") {
      return false;
    }
    const dag = meta.pipeline_dag;
    if (dag === undefined) return false;

    const hydrated = await hydrateScheduleFromStore(
      this.options.store,
      runId,
      dag,
      this.executionMode,
    );
    if (!hydratedScheduleHasRunnableWork(hydrated)) return false;

    const tracked = await this.ensureResumeTracked(runId);
    if (!tracked.ok) {
      log
        .child({ run_id: runId })
        .error(
          "resume.track_failed",
          `resumeStalledSchedules: ${tracked.reason}`,
        );
      return false;
    }

    try {
      const runProjectRoot = meta.project_root ?? this.projectRoot;
      const { meta: loadedMeta, task, loaded, workspaceDir } =
        await loadRunContext(this.options.store, runId, this.cwd);
      const promise = runPipelineDag({
        prepared: {
          task,
          loaded,
          run: { runId, workspaceDir },
          agent: this.options.agent,
          store: this.options.store,
          cwd: runProjectRoot,
          projectRoot: runProjectRoot,
          checkoutRoot: loadedMeta.checkout_root,
          hitl: this.hitl,
          operatorCatalog: this.options.operatorCatalog,
        },
        maxActiveStagesPerRun: this.maxActiveStagesPerRun,
        executionMode: this.executionMode,
        stageProcessLauncher: this.stageProcessLauncher,
        initialSchedule: hydrated,
        schedulingHalt: this.ensureSchedulingHalt(runId),
      }).finally(() => {
        void syncRunStatusFromStages(this.options.store, runId).catch(() => {});
      });
      this.registerResumeUntrack(runId, promise);
      return true;
    } catch (err) {
      this.removeActiveEntry(runId, false);
      throw err;
    }
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
      const kind = derivedBindingKindFromMeta(meta);
      if (kind === "checkout") {
        const checkoutRoot = meta.checkout_root;
        if (checkoutRoot !== undefined && checkoutRoot !== "") {
          durableCheckoutRoot = checkoutRoot;
          checkoutKey = await toCheckoutLeaseKey(checkoutRoot);
        }
      }
    } catch (err) {
      log
        .child({ run_id: runId })
        .error(
          "resume.checkout_root_failed",
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
    this.active.set(runId, { ...entry, generation, done });
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
    log.child({ run_id: runId }).error("attach.quarantined", reason);
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
    this.schedulingHalts.delete(id);
    if (isProvisional) {
      this.provisionalIds.delete(id);
    }
    if (
      entry.checkoutKey !== undefined &&
      this.checkoutLeases.get(entry.checkoutKey) === id
    ) {
      this.checkoutLeases.delete(entry.checkoutKey);
    }
    if (!isProvisional) {
      void this.drainAdmissionQueue();
    }
  }

  private ensureSchedulingHalt(runId: string): SchedulingHalt {
    let halt = this.schedulingHalts.get(runId);
    if (halt === undefined) {
      halt = {
        halted: !this.acceptingWork,
        hostShutdown: !this.acceptingWork,
      };
      this.schedulingHalts.set(runId, halt);
    }
    return halt;
  }
}
