import type { AgentPort } from "../agent/port.js";
import type { RunDetail, RunStatus, RunStore } from "../runstore/port.js";
import type { PipelineRunResult } from "./pipelineRunner.js";
import {
  retryRun,
  type RetryMutationQueue,
  type SchedulerPreparedPipeline,
} from "./pipelineScheduler.js";
import { loadRunContext } from "./resumeReconstruct.js";
import type { StageExecutionMode } from "./stageConcurrency.js";
import type { StageProcessLauncher } from "./stageProcessLauncher.js";
import type { StageHitlController } from "./stageHitl.js";
import { syncRunStatusFromStages } from "./stageRecovery.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

export class DuplicateRetryRootError extends Error {
  constructor(runId: string, stageId: string) {
    super(`Retry already in progress for run ${runId} stage ${stageId}`);
    this.name = "DuplicateRetryRootError";
  }
}

export class RetryCoordinatorInactiveError extends Error {
  constructor(runId: string) {
    super(`Retry coordinator is not active for run ${runId}`);
    this.name = "RetryCoordinatorInactiveError";
  }
}

export class RetryRootWaitTimeoutError extends Error {
  constructor(runId: string, stageId: string, attempt: number) {
    super(
      `Retry root wait timed out for run ${runId} stage ${stageId} attempt ${attempt}`,
    );
    this.name = "RetryRootWaitTimeoutError";
  }
}

type RootWaiter = {
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RunRetrySession = {
  activeRoots: Map<string, number>;
  orchestrationPromise: Promise<PipelineRunResult>;
  mutationQueue: RetryMutationQueue;
  rejectPendingEnqueues: (reason: Error) => void;
  terminalRoots: Set<string>;
  rootWaiters: Map<string, RootWaiter[]>;
  rejectPendingRootWaiters: (reason: Error) => void;
};

export type RunRetryCoordinatorStartOptions = {
  runId: string;
  roots: Map<string, number>;
  prepared: SchedulerPreparedPipeline;
  maxActiveStagesPerRun: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  onLoopTick?: () => void | Promise<void>;
};

export type RetryStageResult =
  | {
      ok: true;
      runId: string;
      stageId: string;
      attemptIndex: number;
      done?: Promise<PipelineRunResult>;
    }
  | { ok: false; reason: string; status?: number };

export type RetryTrackingPort = {
  ensureResumeTracked(runId: string): Promise<
    | { ok: true; insertedForResume?: boolean }
    | { ok: false; reason: string }
  >;
  onOrchestrationStarted(
    runId: string,
    promise: Promise<PipelineRunResult>,
  ): void;
  rollbackStartTracking(
    runId: string,
    state: {
      insertedForResume: boolean;
      bumpedRunning: boolean;
      priorRunStatus: RunStatus;
    },
  ): Promise<void>;
};

export type RetryStageRequest = {
  runId: string;
  stageId: string;
  store: RunStore;
  agent: AgentPort;
  cwd: string;
  operatorCatalog?: OperatorCatalog;
  maxActiveStagesPerRun: number;
  executionMode: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  hitl: StageHitlController;
  orchestrationConflict: boolean;
  tracking: RetryTrackingPort;
  awaitRoot?: boolean;
  beforeAttemptStart?: (attempt: number) => Promise<void>;
};

export function assertStageRetryEligible(
  detail: RunDetail,
  stageId: string,
  opts?: { recoveryActive?: boolean },
): { ok: true } | { ok: false; reason: string; status: number } {
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
      reason: `Stage is waiting for input and cannot be retried`,
      status: 409,
    };
  }

  const recoveryActive = opts?.recoveryActive === true;
  if (detail.status !== "failed") {
    if (!(detail.status === "running" && recoveryActive)) {
      return {
        ok: false,
        reason: `Run is not failed (status=${detail.status})`,
        status: 409,
      };
    }
  }

  if (stageSnap.status !== "failed") {
    return {
      ok: false,
      reason: `Stage is not failed (status=${stageSnap.status})`,
      status: 409,
    };
  }

  return { ok: true };
}

function mutationKey(stageId: string, attempt: number): string {
  return `${stageId}\0${attempt}`;
}

function rootWaitKey(runId: string, stageId: string, attempt: number): string {
  return `${runId}\0${stageId}\0${attempt}`;
}

function readRetryRootWaitTimeoutMs(): number {
  const raw = process.env.STAGEFLOW_RETRY_ROOT_WAIT_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 30 * 60 * 1000;
}

function logRetryRoots(
  runId: string,
  size: number,
  action: "start" | "add" | "complete",
): void {
  console.info(
    JSON.stringify({ event: "retry_roots", runId, size, action }),
  );
}

function createMutationQueue(): {
  mutationQueue: RetryMutationQueue;
  rejectPendingEnqueues: (reason: Error) => void;
} {
  const pendingDeltas: Array<{ stageId: string; attempt: number }> = [];
  const waiters = new Map<
    string,
    Array<{ resolve: () => void; reject: (reason: Error) => void }>
  >();

  const rejectPendingEnqueues = (reason: Error) => {
    pendingDeltas.length = 0;
    for (const list of waiters.values()) {
      for (const waiter of list) {
        waiter.reject(reason);
      }
    }
    waiters.clear();
  };

  const mutationQueue: RetryMutationQueue = {
    enqueue(stageId, attempt) {
      return new Promise<void>((resolve, reject) => {
        pendingDeltas.push({ stageId, attempt });
        const key = mutationKey(stageId, attempt);
        const list = waiters.get(key) ?? [];
        list.push({ resolve, reject });
        waiters.set(key, list);
      });
    },
    drainPending(apply) {
      for (const delta of pendingDeltas.splice(0)) {
        apply(delta.stageId, delta.attempt);
        const key = mutationKey(delta.stageId, delta.attempt);
        const list = waiters.get(key);
        if (list !== undefined) {
          for (const waiter of list) {
            waiter.resolve();
          }
          waiters.delete(key);
        }
      }
    },
    pendingStageIds() {
      return new Set(pendingDeltas.map((delta) => delta.stageId));
    },
  };

  return { mutationQueue, rejectPendingEnqueues };
}

export class RunRetryCoordinator {
  private readonly sessions = new Map<string, RunRetrySession>();

  isActive(runId: string): boolean {
    return this.sessions.has(runId);
  }

  getOrchestrationPromise(runId: string): Promise<PipelineRunResult> | undefined {
    return this.sessions.get(runId)?.orchestrationPromise;
  }

  getActiveRoots(runId: string): ReadonlyMap<string, number> | undefined {
    return this.sessions.get(runId)?.activeRoots;
  }

  signalExternalRetryRootTerminal(runId: string, stageId: string): void {
    const session = this.sessions.get(runId);
    if (session === undefined) return;
    const attempt = session.activeRoots.get(stageId);
    if (attempt === undefined) return;
    const key = rootWaitKey(runId, stageId, attempt);
    if (session.terminalRoots.has(key)) return;
    session.terminalRoots.add(key);
    const list = session.rootWaiters.get(key);
    if (list === undefined) return;
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    session.rootWaiters.delete(key);
  }

  start(options: RunRetryCoordinatorStartOptions): void {
    const { runId, roots } = options;
    if (this.sessions.has(runId)) {
      throw new Error(`Retry coordinator already active for run ${runId}`);
    }

    const activeRoots = new Map(roots);
    const { mutationQueue, rejectPendingEnqueues } = createMutationQueue();
    const store = options.prepared.store;
    const terminalRoots = new Set<string>();
    const rootWaiters = new Map<string, RootWaiter[]>();

    const resolveRootWaiters = (key: string) => {
      const list = rootWaiters.get(key);
      if (list === undefined) return;
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      rootWaiters.delete(key);
    };

    const rejectPendingRootWaiters = (reason: Error) => {
      for (const list of rootWaiters.values()) {
        for (const waiter of list) {
          clearTimeout(waiter.timer);
          waiter.reject(reason);
        }
      }
      rootWaiters.clear();
    };

    const orchestrationPromise = retryRun({
      prepared: options.prepared,
      retryRoots: activeRoots,
      maxActiveStagesPerRun: options.maxActiveStagesPerRun,
      executionMode: options.executionMode,
      stageProcessLauncher: options.stageProcessLauncher,
      mutationQueue,
      onLoopTick: options.onLoopTick,
      onRetryRootTerminal: (stageId, attempt) => {
        const key = rootWaitKey(runId, stageId, attempt);
        terminalRoots.add(key);
        resolveRootWaiters(key);
      },
    }).finally(async () => {
      try {
        await syncRunStatusFromStages(store, runId);
      } catch {
        // ignore secondary failures
      }
      logRetryRoots(runId, activeRoots.size, "complete");
      rejectPendingRootWaiters(new RetryCoordinatorInactiveError(runId));
      rejectPendingEnqueues(new RetryCoordinatorInactiveError(runId));
      this.sessions.delete(runId);
    });

    this.sessions.set(runId, {
      activeRoots,
      orchestrationPromise,
      mutationQueue,
      rejectPendingEnqueues,
      terminalRoots,
      rootWaiters,
      rejectPendingRootWaiters,
    });
    logRetryRoots(runId, activeRoots.size, "start");
  }

  async addRoot(runId: string, stageId: string, attempt: number): Promise<void> {
    const session = this.sessions.get(runId);
    if (session === undefined) {
      throw new RetryCoordinatorInactiveError(runId);
    }
    if (session.activeRoots.has(stageId)) {
      throw new DuplicateRetryRootError(runId, stageId);
    }
    session.activeRoots.set(stageId, attempt);
    await session.mutationQueue.enqueue(stageId, attempt);
    logRetryRoots(runId, session.activeRoots.size, "add");
  }

  async retryStage(req: RetryStageRequest): Promise<RetryStageResult> {
    const { runId, stageId, store, tracking } = req;

    let detail;
    try {
      detail = await store.readRun(runId);
    } catch {
      return { ok: false, reason: `Run not found: ${runId}`, status: 404 };
    }

    const recoveryActive = this.isActive(runId);

    const eligibility = assertStageRetryEligible(detail, stageId, {
      recoveryActive,
    });
    if (!eligibility.ok) {
      return {
        ok: false,
        reason: eligibility.reason,
        status: eligibility.status,
      };
    }

    if (recoveryActive) {
      if (this.getActiveRoots(runId)?.has(stageId)) {
        return {
          ok: false,
          reason: `Retry already in progress for run ${runId} stage ${stageId}`,
          status: 409,
        };
      }
    }

    if (!recoveryActive && req.orchestrationConflict) {
      return {
        ok: false,
        reason: `Run ${runId} already has active orchestration`,
        status: 409,
      };
    }

    const priorRunStatus = detail.status;
    let insertedForResume = false;
    let bumpedRunning = false;

    try {
      if (!recoveryActive) {
        const tracked = await tracking.ensureResumeTracked(runId);
        if (!tracked.ok) {
          return {
            ok: false,
            reason: tracked.reason,
            status: 409,
          };
        }
        insertedForResume = tracked.insertedForResume === true;

        if (priorRunStatus === "failed") {
          await store.updateRunStatus(runId, "running");
          bumpedRunning = true;
        }
      }

      const existingAttempts = await store.countStageAttempts(runId, stageId);
      if (existingAttempts === 0) {
        const snap = detail.stages.find((s) => s.stage_id === stageId);
        if (
          snap &&
          (snap.status === "failed" || snap.status === "succeeded")
        ) {
          await store.createStageExecution(runId, stageId);
        }
      }
      const execution = await store.createStageExecution(runId, stageId);
      await req.beforeAttemptStart?.(execution.attempt);

      const { meta, task, loaded, workspaceDir } = await loadRunContext(
        store,
        runId,
        req.cwd,
      );

      const prepared = {
        task,
        loaded,
        run: { runId, workspaceDir },
        agent: req.agent,
        store,
        cwd: req.cwd,
        checkoutRoot: meta.checkout_root,
        hitl: req.hitl,
        operatorCatalog: req.operatorCatalog,
      };

      if (recoveryActive) {
        await this.addRoot(runId, stageId, execution.attempt);
      } else {
        this.start({
          runId,
          roots: new Map([[stageId, execution.attempt]]),
          prepared,
          maxActiveStagesPerRun: req.maxActiveStagesPerRun,
          executionMode: req.executionMode,
          stageProcessLauncher: req.stageProcessLauncher,
        });
        const orchestrationPromise = this.getOrchestrationPromise(runId);
        if (orchestrationPromise !== undefined) {
          tracking.onOrchestrationStarted(runId, orchestrationPromise);
        }
      }

      if (req.awaitRoot !== false) {
        await this.waitForRoot(runId, stageId, store);
      }

      return {
        ok: true,
        runId,
        stageId,
        attemptIndex: execution.attempt,
        done: this.getOrchestrationPromise(runId),
      };
    } catch (err) {
      await tracking.rollbackStartTracking(runId, {
        insertedForResume,
        bumpedRunning,
        priorRunStatus,
      });
      if (err instanceof DuplicateRetryRootError) {
        return { ok: false, reason: err.message, status: 409 };
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason, status: 500 };
    }
  }

  async waitForRoot(
    runId: string,
    stageId: string,
    _store: RunStore,
  ): Promise<void> {
    const session = this.sessions.get(runId);
    if (session === undefined) {
      throw new RetryCoordinatorInactiveError(runId);
    }
    const expectedAttempt = session.activeRoots.get(stageId);
    if (expectedAttempt === undefined) {
      throw new Error(`Retry root not registered for stage ${stageId}`);
    }

    const key = rootWaitKey(runId, stageId, expectedAttempt);
    if (session.terminalRoots.has(key)) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = session.rootWaiters.get(key);
        if (list !== undefined) {
          const remaining = list.filter((waiter) => waiter.timer !== timer);
          if (remaining.length === 0) {
            session.rootWaiters.delete(key);
          } else {
            session.rootWaiters.set(key, remaining);
          }
        }
        reject(new RetryRootWaitTimeoutError(runId, stageId, expectedAttempt));
      }, readRetryRootWaitTimeoutMs());

      const waiter: RootWaiter = { resolve, reject, timer };
      const list = session.rootWaiters.get(key) ?? [];
      list.push(waiter);
      session.rootWaiters.set(key, list);
    });
  }
}
