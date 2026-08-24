import type { AgentPort } from "../agent/port.js";
import type { RunStore, StageSnapshot } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { LoadedPipeline, ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import type { TaskFile } from "../types/task.js";
import {
  collectDownstreamClosure,
  collectDownstreamStageIds,
} from "./dagTraversal.js";
import {
  buildCompletedEnvelopesFromRun,
  buildStageConfigById,
} from "./envelopeRouting.js";
import { WAIT_WITHOUT_WORKER_DISPATCH } from "./answerResume.js";
import type { PipelineRunResult } from "./pipelineRunner.js";
import type { StageProcessLauncher } from "./stageProcessLauncher.js";
import type { StageExecutionMode } from "./stageConcurrency.js";
import { runStage, isRunStageWaiting } from "./stageRunner.js";
import type { StageHitlController } from "./stageHitl.js";
import { attemptContext } from "./stageAttemptContext.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

type SchedulerPreparedPipeline = {
  task: TaskFile;
  loaded: LoadedPipeline;
  run: { runId: string; workspaceDir: string };
  agent: AgentPort;
  store: RunStore;
  cwd: string;
  checkoutRoot?: string;
  hitl?: StageHitlController;
  operatorCatalog?: OperatorCatalog;
};

export type { SchedulerPreparedPipeline };

type RetryContext = {
  retryRoots: Map<string, number>;
};

export type RetryMutationQueue = {
  enqueue(stageId: string, attempt: number): Promise<void>;
  drainPending(apply: (stageId: string, attempt: number) => void): void;
  pendingStageIds(): ReadonlySet<string>;
};

export type RetryRootTerminalOutcome = "succeeded" | "failed" | "skipped";

export type OnRetryRootTerminal = (
  stageId: string,
  attempt: number,
  outcome: RetryRootTerminalOutcome,
) => void;

type HasWorkOutsideBranchContext = {
  retryRoots?: ReadonlyMap<string, number>;
  pendingDeltaStageIds?: ReadonlySet<string>;
};

type StageScheduleState =
  | "pending"
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type HydratedSchedule = {
  states: Map<string, StageScheduleState>;
  completedEnvelopes: Map<string, StageEnvelope>;
  schedulingHalted: boolean;
  firstFailureReason: string | undefined;
};

export function snapshotToScheduleState(
  snap: { status: StageSnapshot["status"] },
  overrides: ReadonlyMap<string, StageScheduleState>,
  stageId: string,
  executionMode?: StageExecutionMode,
): StageScheduleState {
  const override = overrides.get(stageId);
  if (override !== undefined) return override;
  switch (snap.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "running":
      return "active";
    case "waiting_for_input":
      return executionMode === "process" ? "waiting" : "active";
    default:
      return "pending";
  }
}

export async function hydrateScheduleFromStore(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  executionMode: StageExecutionMode = "process",
): Promise<HydratedSchedule> {
  const states = new Map<string, StageScheduleState>();
  for (const node of dag.nodes) {
    states.set(node.id, "pending");
  }

  const runDetail = await store.readRun(runId);
  const completedEnvelopes = await buildCompletedEnvelopesFromRun(
    store,
    runId,
    runDetail.stages,
  );
  let schedulingHalted = false;
  const overrides = new Map<string, StageScheduleState>();

  for (const snap of runDetail.stages) {
    const state = snapshotToScheduleState(
      snap,
      overrides,
      snap.stage_id,
      executionMode,
    );
    states.set(snap.stage_id, state);
    if (state === "failed") {
      schedulingHalted = true;
    }
  }

  return {
    states,
    completedEnvelopes,
    schedulingHalted,
    firstFailureReason: undefined,
  };
}

export async function hydrateScheduleForRetryRoots(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  retryStageIds: string[],
): Promise<HydratedSchedule> {
  const runDetail = await store.readRun(runId);
  const downstream = collectDownstreamClosure(dag, retryStageIds);
  const retryRootSet = new Set(retryStageIds);
  const completedEnvelopes = await buildCompletedEnvelopesFromRun(
    store,
    runId,
    runDetail.stages,
  );

  const states = new Map<string, StageScheduleState>();
  for (const node of dag.nodes) {
    states.set(node.id, "pending");
  }

  const overrides = new Map<string, StageScheduleState>();
  for (const rootId of retryStageIds) {
    overrides.set(rootId, "pending");
  }
  for (const id of downstream) {
    overrides.set(id, "pending");
  }

  for (const snap of runDetail.stages) {
    const id = snap.stage_id;
    const state = snapshotToScheduleState(snap, overrides, id, "process");
    states.set(id, state);
    if (retryRootSet.has(id) || downstream.has(id)) {
      completedEnvelopes.delete(id);
    }
  }

  return {
    states,
    completedEnvelopes,
    schedulingHalted: false,
    firstFailureReason: undefined,
  };
}

export async function hydrateScheduleForRetry(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  retryStageId: string,
): Promise<HydratedSchedule> {
  return hydrateScheduleForRetryRoots(store, runId, dag, [retryStageId]);
}

export type ResumeRunOptions = {
  prepared: SchedulerPreparedPipeline;
  maxActiveStagesPerRun: number;
  resumeFromStageId: string;
  initialPrior?: StageEnvelope | null;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
};

export async function resumeRun(
  options: ResumeRunOptions,
): Promise<PipelineRunResult> {
  const { prepared, resumeFromStageId, initialPrior } = options;
  const dag = prepared.loaded.dag;
  const downstream = dag.childrenOf[resumeFromStageId];
  if (downstream?.length) {
    return runPipelineDag(options);
  }

  const executionMode = options.executionMode ?? "process";
  const hydrated = await hydrateScheduleFromStore(
    prepared.store,
    prepared.run.runId,
    dag,
    executionMode,
  );
  hydrated.states.set(resumeFromStageId, "succeeded");
  if (initialPrior !== undefined && initialPrior !== null) {
    hydrated.completedEnvelopes.set(resumeFromStageId, initialPrior);
  }

  const hasActive = [...hydrated.states.values()].some((s) => s === "active");
  if (hasActive) {
    return {
      ok: true,
      runDir: prepared.run.workspaceDir,
      runId: prepared.run.runId,
    };
  }

  const allTerminal = dag.nodes.every((node) => {
    const state = hydrated.states.get(node.id);
    return state !== undefined && terminalState(state);
  });

  if (allTerminal) {
    const allSucceeded = dag.nodes.every(
      (node) => hydrated.states.get(node.id) === "succeeded",
    );
    await prepared.store.updateRunStatus(
      prepared.run.runId,
      allSucceeded ? "succeeded" : "failed",
    );
    return {
      ok: allSucceeded,
      runDir: prepared.run.workspaceDir,
      runId: prepared.run.runId,
      ...(allSucceeded
        ? {}
        : { reason: hydrated.firstFailureReason ?? "pipeline incomplete" }),
    };
  }

  return runPipelineDag(options);
}

export type RunPipelineDagOptions = {
  prepared: SchedulerPreparedPipeline;
  maxActiveStagesPerRun: number;
  resumeFromStageId?: string;
  initialPrior?: StageEnvelope | null;
  /** @deprecated Linear pipelines only — skips stages before this declaration index. */
  startAtStageIndex?: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  initialSchedule?: HydratedSchedule;
  retryContext?: RetryContext;
  mutationQueue?: RetryMutationQueue;
  onLoopTick?: () => void | Promise<void>;
  onRetryRootTerminal?: OnRetryRootTerminal;
};

export type RetryRunOptions = {
  prepared: SchedulerPreparedPipeline;
  retryRoots: Map<string, number>;
  maxActiveStagesPerRun: number;
  executionMode?: StageExecutionMode;
  stageProcessLauncher?: StageProcessLauncher;
  mutationQueue?: RetryMutationQueue;
  onLoopTick?: () => void | Promise<void>;
  onRetryRootTerminal?: OnRetryRootTerminal;
};

export async function retryRun(
  options: RetryRunOptions,
): Promise<PipelineRunResult> {
  const { prepared, retryRoots } = options;
  const hydrated = await hydrateScheduleForRetryRoots(
    prepared.store,
    prepared.run.runId,
    prepared.loaded.dag,
    [...retryRoots.keys()],
  );
  return runPipelineDag({
    prepared: options.prepared,
    maxActiveStagesPerRun: options.maxActiveStagesPerRun,
    executionMode: options.executionMode,
    stageProcessLauncher: options.stageProcessLauncher,
    initialSchedule: hydrated,
    retryContext: { retryRoots },
    mutationQueue: options.mutationQueue,
    onLoopTick: options.onLoopTick,
    onRetryRootTerminal: options.onRetryRootTerminal,
  });
}

export function applyRetryRootDelta(
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope>,
  retryRoots: Map<string, number>,
  stageId: string,
  attempt: number,
  clearSchedulingHalt?: () => void,
): void {
  retryRoots.set(stageId, attempt);
  const downstream = collectDownstreamClosure(dag, [stageId]);
  const resetIds = new Set<string>([stageId, ...downstream]);

  for (const id of resetIds) {
    const state = states.get(id);
    if (state === "active" || state === "succeeded") {
      completedEnvelopes.delete(id);
      continue;
    }
    states.set(id, "pending");
    completedEnvelopes.delete(id);
  }
  clearSchedulingHalt?.();
}

export function hasWorkOutsideBranch(
  dag: ResolvedPipelineDag,
  branchRootId: string,
  states: Map<string, StageScheduleState>,
  ctx?: HasWorkOutsideBranchContext,
): boolean {
  const branchIds = new Set([
    branchRootId,
    ...collectDownstreamStageIds(dag, branchRootId),
  ]);
  for (const node of dag.nodes) {
    if (branchIds.has(node.id)) continue;
    const state = states.get(node.id);
    if (state === "pending" || state === "active" || state === "waiting") {
      return true;
    }
  }
  if (ctx?.pendingDeltaStageIds !== undefined) {
    for (const stageId of ctx.pendingDeltaStageIds) {
      if (!branchIds.has(stageId)) {
        return true;
      }
    }
  }
  if (ctx?.retryRoots !== undefined) {
    for (const [rootId] of ctx.retryRoots) {
      if (branchIds.has(rootId)) continue;
      const state = states.get(rootId);
      if (state === "pending" || state === "active" || state === "waiting") {
        return true;
      }
      if (state === "failed") {
        return true;
      }
    }
  }
  return false;
}

function terminalState(status: StageScheduleState): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function sortRunnableIds(
  dag: ResolvedPipelineDag,
  ids: string[],
): string[] {
  const indexById = new Map(
    dag.nodes.map((node) => [node.id, node.stageIndex]),
  );
  return ids.slice().sort(
    (a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0),
  );
}

function isRunnable(
  dag: ResolvedPipelineDag,
  stageId: string,
  states: Map<string, StageScheduleState>,
  schedulingHalted: boolean,
): boolean {
  if (schedulingHalted) return false;
  const state = states.get(stageId);
  if (state !== "pending") return false;
  const node = dag.nodes.find((n) => n.id === stageId);
  if (!node) return false;
  if (node.needs === null) return true;
  return states.get(node.needs) === "succeeded";
}

export async function runPipelineDag(
  options: RunPipelineDagOptions,
): Promise<PipelineRunResult> {
  const { prepared, maxActiveStagesPerRun } = options;
  const executionMode = options.executionMode ?? "process";
  const {
    agent,
    task,
    loaded,
    run,
    store,
    checkoutRoot,
    hitl,
    cwd,
  } = prepared;
  const dag = loaded.dag;
  const stageById = buildStageConfigById(loaded);

  let { states, completedEnvelopes, schedulingHalted, firstFailureReason } =
    options.initialSchedule ??
    (await hydrateScheduleFromStore(store, run.runId, dag, executionMode));

  const retryContext = options.retryContext;

  const resolveLaunchAttempt = async (stageId: string): Promise<number> => {
    if (retryContext) {
      const preCreatedAttempt = retryContext.retryRoots.get(stageId);
      if (preCreatedAttempt !== undefined) {
        return preCreatedAttempt;
      }
      const execution = await store.createStageExecution(run.runId, stageId);
      return execution.attempt;
    }
    const attemptCount = await store.countStageAttempts(run.runId, stageId);
    if (attemptCount === 0) {
      await store.createStageExecution(run.runId, stageId);
    }
    return 1;
  };

  if (options.resumeFromStageId !== undefined) {
    const resumedId = options.resumeFromStageId;
    states.set(resumedId, "succeeded");
    if (options.initialPrior !== undefined && options.initialPrior !== null) {
      completedEnvelopes.set(resumedId, options.initialPrior);
    } else if (!completedEnvelopes.has(resumedId)) {
      try {
        const envelope = await store.readEnvelope(run.runId, resumedId);
        completedEnvelopes.set(resumedId, envelope);
      } catch {
        // prior resolution will fail for downstream if envelope missing
      }
    }
  }

  if (options.startAtStageIndex !== undefined) {
    const startAt = options.startAtStageIndex;
    for (const node of dag.nodes) {
      if (node.stageIndex < startAt) {
        states.set(node.id, "succeeded");
        if (!completedEnvelopes.has(node.id)) {
          try {
            const envelope = await store.readEnvelope(run.runId, node.id);
            completedEnvelopes.set(node.id, envelope);
          } catch {
            // linear shim: upstream envelopes expected on disk
          }
        }
      }
    }
  }

  let activeCount = 0;
  const inFlight = new Set<Promise<void>>();

  const notifyRetryRootTerminal = (
    stageId: string,
    outcome: RetryRootTerminalOutcome,
  ) => {
    if (retryContext === undefined) return;
    const attempt = retryContext.retryRoots.get(stageId);
    if (attempt === undefined) return;
    options.onRetryRootTerminal?.(stageId, attempt, outcome);
  };

  const markSkippedPending = () => {
    for (const node of dag.nodes) {
      if (states.get(node.id) === "pending") {
        states.set(node.id, "skipped");
        notifyRetryRootTerminal(node.id, "skipped");
      }
    }
  };

  const markBranchDownstreamSkipped = (stageId: string) => {
    for (const id of collectDownstreamStageIds(dag, stageId)) {
      if (states.get(id) === "pending") {
        states.set(id, "skipped");
        notifyRetryRootTerminal(id, "skipped");
      }
    }
  };

  const outsideWorkContext = (): HasWorkOutsideBranchContext => ({
    retryRoots: retryContext?.retryRoots,
    pendingDeltaStageIds: options.mutationQueue?.pendingStageIds(),
  });

  const drainRetryMutations = () => {
    if (options.mutationQueue === undefined || retryContext === undefined) {
      return;
    }
    options.mutationQueue.drainPending((stageId, attempt) => {
      applyRetryRootDelta(
        dag,
        states,
        completedEnvelopes,
        retryContext.retryRoots,
        stageId,
        attempt,
        () => {
          schedulingHalted = false;
        },
      );
    });
  };

  const onStageFailure = async (stageId: string, reason: string) => {
    states.set(stageId, "failed");
    notifyRetryRootTerminal(stageId, "failed");
    if (retryContext) {
      markBranchDownstreamSkipped(stageId);
      drainRetryMutations();
      if (!hasWorkOutsideBranch(dag, stageId, states, outsideWorkContext())) {
        schedulingHalted = true;
      }
      if (firstFailureReason === undefined) {
        firstFailureReason = reason;
      }
      return;
    }
    if (!schedulingHalted) {
      schedulingHalted = true;
      firstFailureReason = reason;
    }
  };

  const onStageSuccess = (stageId: string, envelope: StageEnvelope) => {
    states.set(stageId, "succeeded");
    completedEnvelopes.set(stageId, envelope);
    notifyRetryRootTerminal(stageId, "succeeded");
  };

  const launchStage = async (stageId: string): Promise<void> => {
    const stage = stageById.get(stageId);
    if (!stage) {
      await onStageFailure(stageId, `stage config missing for "${stageId}"`);
      return;
    }

    const attempt = await resolveLaunchAttempt(stageId);
    const attemptCtx = attemptContext(attempt);

    if (executionMode === "process") {
      const launcher = options.stageProcessLauncher;
      if (!launcher) {
        await onStageFailure(stageId, "stage process launcher is not configured");
        return;
      }
      const launchResult = await launcher.launch({
        runId: run.runId,
        stageId,
        rootDir: cwd,
        attempt,
        ...(prepared.operatorCatalog !== undefined
          ? { operatorCatalog: prepared.operatorCatalog }
          : {}),
      });
      if (launchResult.type === "succeeded") {
        try {
          const envelope = await store.readEnvelope(run.runId, stageId);
          onStageSuccess(stageId, envelope);
        } catch {
          states.set(stageId, "succeeded");
          notifyRetryRootTerminal(stageId, "succeeded");
        }
        return;
      }
      if (launchResult.type === "waiting") {
        states.set(stageId, "waiting");
        return;
      }
      await onStageFailure(stageId, launchResult.reason);
      return;
    }

    const result = await runStage({
      agent,
      store,
      runId: run.runId,
      stage,
      task,
      dag,
      checkoutRoot,
      workspaceDir: run.workspaceDir,
      hitl,
      attemptCtx,
      factoryCwd: cwd,
      operatorCatalog: prepared.operatorCatalog,
      completedEnvelopes,
    });

    if (isRunStageWaiting(result)) {
      await onStageFailure(stageId, WAIT_WITHOUT_WORKER_DISPATCH);
      return;
    }

    if (!result.ok) {
      await onStageFailure(stageId, result.reason ?? "stage failed");
      return;
    }
    if (result.envelope) {
      onStageSuccess(stageId, result.envelope);
    } else {
      states.set(stageId, "succeeded");
      notifyRetryRootTerminal(stageId, "succeeded");
    }
  };

  const startStage = (stageId: string) => {
    if (states.get(stageId) !== "pending") return;
    states.set(stageId, "active");
    activeCount += 1;
    const taskPromise = launchStage(stageId).finally(() => {
      activeCount -= 1;
      inFlight.delete(taskPromise);
    });
    inFlight.add(taskPromise);
  };

  const pickRunnable = (): string[] => {
    const ids: string[] = [];
    for (const node of dag.nodes) {
      if (isRunnable(dag, node.id, states, schedulingHalted)) {
        ids.push(node.id);
      }
    }
    return sortRunnableIds(dag, ids);
  };

  const allTerminal = (): boolean => {
    for (const node of dag.nodes) {
      const state = states.get(node.id);
      if (state === undefined || !terminalState(state)) {
        return false;
      }
    }
    return true;
  };

  while (!allTerminal()) {
    drainRetryMutations();
    if (options.onLoopTick !== undefined) {
      await options.onLoopTick();
    }
    if (!schedulingHalted) {
      const runnable = pickRunnable();
      for (const stageId of runnable) {
        if (activeCount >= maxActiveStagesPerRun) break;
        startStage(stageId);
      }
    }

    if (inFlight.size === 0) {
      if (schedulingHalted) {
        markSkippedPending();
        break;
      }
      const runnable = pickRunnable();
      if (runnable.length === 0) {
        const hasWaiting = [...states.values()].some((s) => s === "waiting");
        if (hasWaiting) {
          break;
        }
        break;
      }
      continue;
    }

    await Promise.race([
      ...inFlight,
      new Promise<void>((resolve) => setTimeout(resolve, 25)),
    ]);
  }

  if (inFlight.size > 0) {
    await Promise.all(inFlight);
  }

  const hasWaiting = [...states.values()].some((s) => s === "waiting");
  if (hasWaiting && !schedulingHalted) {
    return { ok: true, runDir: run.workspaceDir, runId: run.runId };
  }

  if (schedulingHalted) {
    markSkippedPending();
    if (retryContext === undefined) {
      await store.updateRunStatus(run.runId, "failed");
    }
    return {
      ok: false,
      runDir: run.workspaceDir,
      runId: run.runId,
      reason: firstFailureReason,
    };
  }

  const allSucceeded = dag.nodes.every(
    (node) => states.get(node.id) === "succeeded",
  );
  if (!allSucceeded) {
    if (retryContext === undefined) {
      await store.updateRunStatus(run.runId, "failed");
    }
    return {
      ok: false,
      runDir: run.workspaceDir,
      runId: run.runId,
      reason: firstFailureReason ?? "pipeline incomplete",
    };
  }

  if (retryContext === undefined) {
    await store.updateRunStatus(run.runId, "succeeded");
  }
  return { ok: true, runDir: run.workspaceDir, runId: run.runId };
}
