import type { AgentPort } from "../agent/port.js";
import { normalizeForkChoice } from "../envelope/forkChoice.js";
import type { RunPipelineDagSnapshot, RunStore, StageSnapshot } from "../runstore/port.js";
import { buildPipelineDagSnapshotFromLoaded } from "../runstore/pipelineDagSnapshot.js";
import { definitionIdForInstance } from "../runstore/stageInstanceId.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { LoadedPipeline, ResolvedPipelineDag } from "../types/pipeline.js";
import type { TaskFile } from "../types/task.js";
import {
  applyCloneForksFromEnvelopes,
  applyCloneForksToSchedule,
  cloneFailureContinuesSchedule,
  cloneFanoutConflict,
  cloneRetryDownstream,
  cloneScheduleAllowsRun,
  isCloneInstance,
  protectedClonableChildIds,
  sequentialFailFastSkipIds,
  sequentialLaterCloneIds,
} from "./cloneSchedule.js";
import { collectDownstreamStageIds } from "./dagTraversal.js";
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
  projectRoot?: string;
  checkoutRoot?: string;
  hitl?: StageHitlController;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
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

export type StageScheduleState =
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
  dag?: RunPipelineDagSnapshot;
};

function asDagSnapshot(dag: ResolvedPipelineDag): RunPipelineDagSnapshot {
  const snapshot = dag as RunPipelineDagSnapshot;
  if (Array.isArray(snapshot.stage_ids)) return snapshot;
  return {
    ...dag,
    stage_ids: dag.nodes.map((n) => n.id),
  };
}

export {
  applyCloneForksFromEnvelopes,
  applyCloneForksToSchedule,
};
export type { ApplyCloneForksResult } from "./cloneSchedule.js";

function synthesizedFailureEnvelope(reason: string): StageEnvelope {
  return { status: "failure", summary: reason, artifacts: [] };
}

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
    case "skipped":
      return "skipped";
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
  const runDetail = await store.readRun(runId);
  const meta = await store.readRunMeta(runId);
  const resolvedDag = meta.pipeline_dag ?? asDagSnapshot(dag);

  const states = new Map<string, StageScheduleState>();
  for (const node of resolvedDag.nodes) {
    states.set(node.id, "pending");
  }

  const completedEnvelopes = await buildCompletedEnvelopesFromRun(
    store,
    runId,
    runDetail.stages,
    resolvedDag,
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
    if (
      state === "failed" &&
      !cloneFailureContinuesSchedule(
        resolvedDag,
        snap.stage_id,
        completedEnvelopes,
      )
    ) {
      schedulingHalted = true;
    }
  }

  return {
    states,
    completedEnvelopes,
    schedulingHalted,
    firstFailureReason: undefined,
    dag: resolvedDag,
  };
}

export async function hydrateScheduleForRetryRoots(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  retryStageIds: string[],
): Promise<HydratedSchedule> {
  const runDetail = await store.readRun(runId);
  const meta = await store.readRunMeta(runId);
  const resolvedDag = meta.pipeline_dag ?? asDagSnapshot(dag);
  const completedEnvelopes = await buildCompletedEnvelopesFromRun(
    store,
    runId,
    runDetail.stages,
    resolvedDag,
  );
  const downstream = cloneRetryDownstream(resolvedDag, retryStageIds);
  for (const rootId of retryStageIds) {
    for (const id of sequentialLaterCloneIds(
      resolvedDag,
      rootId,
      completedEnvelopes,
    )) {
      downstream.add(id);
    }
  }
  const retryRootSet = new Set(retryStageIds);

  const states = new Map<string, StageScheduleState>();
  for (const node of resolvedDag.nodes) {
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
    dag: resolvedDag,
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
  const meta = await prepared.store.readRunMeta(prepared.run.runId);
  const dag =
    meta.pipeline_dag ?? buildPipelineDagSnapshotFromLoaded(prepared.loaded);
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
      ok: false,
      outcome: "waiting",
      runDir: prepared.run.workspaceDir,
      runId: prepared.run.runId,
    };
  }

  const allTerminal = dag.nodes.every((node) => {
    const state = hydrated.states.get(node.id);
    return state !== undefined && terminalState(state);
  });

  if (allTerminal) {
    const allSucceeded = dag.nodes.every((node) => {
      const s = hydrated.states.get(node.id);
      return s === "succeeded" || s === "skipped";
    });
    await prepared.store.updateRunStatus(
      prepared.run.runId,
      allSucceeded ? "succeeded" : "failed",
    );
    return {
      ok: allSucceeded,
      outcome: allSucceeded ? "succeeded" : "failed",
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
    buildPipelineDagSnapshotFromLoaded(prepared.loaded),
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

function applyForkChoiceToSchedule(
  dag: ResolvedPipelineDag,
  forkStageId: string,
  chosen: Set<string>,
  states: Map<string, StageScheduleState>,
  options?: {
    onSkip?: (childId: string) => void;
    protectedIds?: ReadonlySet<string>;
  },
): void {
  const skipPending = (stageId: string) => {
    if (states.get(stageId) === "pending") {
      states.set(stageId, "skipped");
      options?.onSkip?.(stageId);
    }
  };

  for (const childId of dag.childrenOf[forkStageId] ?? []) {
    if (options?.protectedIds?.has(childId)) continue;
    if (!chosen.has(childId)) {
      skipPending(childId);
      for (const desc of collectDownstreamStageIds(dag, childId)) {
        skipPending(desc);
      }
    }
  }
}

export function applyForkSkipsFromEnvelopes(
  dag: ResolvedPipelineDag,
  states: Map<string, StageScheduleState>,
  completedEnvelopes: Map<string, StageEnvelope>,
): void {
  for (const node of dag.nodes) {
    if (!node.fork) continue;
    const envelope = completedEnvelopes.get(node.id);
    if (!envelope) continue;
    const chosen = normalizeForkChoice(envelope.fork_choice, "stored");
    applyForkChoiceToSchedule(dag, node.id, chosen, states);
  }
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
  const downstream = cloneRetryDownstream(dag, [stageId]);
  const resetIds = new Set<string>([stageId, ...downstream]);
  for (const id of sequentialLaterCloneIds(dag, stageId, completedEnvelopes)) {
    resetIds.add(id);
  }

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
  completedEnvelopes: Map<string, StageEnvelope>,
): boolean {
  if (schedulingHalted) return false;
  const state = states.get(stageId);
  if (state !== "pending") return false;
  return cloneScheduleAllowsRun(dag, stageId, states, completedEnvelopes);
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
    projectRoot,
  } = prepared;
  const factoryCwd = projectRoot ?? cwd ?? process.cwd();
  const fallbackDag = buildPipelineDagSnapshotFromLoaded(loaded);
  let {
    states,
    completedEnvelopes,
    schedulingHalted,
    firstFailureReason,
    dag: hydratedDag,
  } =
    options.initialSchedule ??
    (await hydrateScheduleFromStore(store, run.runId, fallbackDag, executionMode));
  let dag: RunPipelineDagSnapshot = hydratedDag ?? fallbackDag;
  if (hydratedDag === undefined) {
    const meta = await store.readRunMeta(run.runId);
    dag = meta.pipeline_dag ?? fallbackDag;
  }
  const stageById = buildStageConfigById(loaded);

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

  applyForkSkipsFromEnvelopes(dag, states, completedEnvelopes);
  {
    const applied = applyCloneForksFromEnvelopes(
      dag,
      states,
      completedEnvelopes,
    );
    if (applied.dag !== dag) {
      await store.updatePipelineDag(run.runId, applied.dag);
    }
    dag = applied.dag;
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

  const recordCloneFailureEnvelope = async (
    stageId: string,
    reason: string,
    envelope?: StageEnvelope,
  ) => {
    if (!isCloneInstance(dag, stageId)) {
      if (envelope !== undefined) {
        completedEnvelopes.set(stageId, envelope);
      }
      return;
    }
    const failureEnvelope =
      envelope ??
      completedEnvelopes.get(stageId) ??
      synthesizedFailureEnvelope(reason);
    completedEnvelopes.set(stageId, failureEnvelope);
    if (envelope === undefined) {
      try {
        await store.writeEnvelope(run.runId, stageId, failureEnvelope);
      } catch {
      }
    }
  };

  const onStageFailure = async (
    stageId: string,
    reason: string,
    envelope?: StageEnvelope,
  ) => {
    states.set(stageId, "failed");
    notifyRetryRootTerminal(stageId, "failed");
    await recordCloneFailureEnvelope(stageId, reason, envelope);
    if (cloneFailureContinuesSchedule(dag, stageId, completedEnvelopes)) {
      if (firstFailureReason === undefined) {
        firstFailureReason = reason;
      }
      const persistSkipPending = async (id: string) => {
        if (states.get(id) !== "pending") return;
        states.set(id, "skipped");
        notifyRetryRootTerminal(id, "skipped");
        await store.appendStageEvent(run.runId, id, { event: "skipped" });
      };
      for (const id of sequentialFailFastSkipIds(
        dag,
        stageId,
        completedEnvelopes,
      )) {
        await persistSkipPending(id);
      }
      if (retryContext) {
        drainRetryMutations();
      }
      return;
    }
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

  const onStageSuccess = async (stageId: string, envelope: StageEnvelope) => {
    const conflict = cloneFanoutConflict(dag, envelope);
    if (conflict !== undefined) {
      await store.appendStageEvent(run.runId, stageId, {
        event: "failed",
        reason: conflict,
      });
      await onStageFailure(stageId, conflict);
      return;
    }
    states.set(stageId, "succeeded");
    completedEnvelopes.set(stageId, envelope);
    notifyRetryRootTerminal(stageId, "succeeded");
    const node = dag.nodes.find((n) => n.id === stageId);
    const protectedIds = protectedClonableChildIds(dag, stageId, envelope);
    if (node?.fork) {
      const chosen = normalizeForkChoice(envelope.fork_choice, "stored");
      const skippedIds: string[] = [];
      applyForkChoiceToSchedule(dag, stageId, chosen, states, {
        protectedIds,
        onSkip: (id) => {
          notifyRetryRootTerminal(id, "skipped");
          skippedIds.push(id);
        },
      });
      for (const id of skippedIds) {
        await store.appendStageEvent(run.runId, id, { event: "skipped" });
      }
    }
    const applied = applyCloneForksToSchedule(dag, stageId, envelope, states);
    const dagChanged = applied.dag !== dag;
    dag = applied.dag;
    if (dagChanged) {
      await store.updatePipelineDag(run.runId, dag);
    }
    for (const id of applied.skippedIds) {
      notifyRetryRootTerminal(id, "skipped");
      await store.appendStageEvent(run.runId, id, { event: "skipped" });
    }
  };

  const handlePostSuccessError = async (stageId: string, reason: string) => {
    if (states.get(stageId) === "succeeded") {
      completedEnvelopes.delete(stageId);
      await store.appendStageEvent(run.runId, stageId, {
        event: "failed",
        reason,
      });
    }
    await onStageFailure(stageId, reason);
  };

  const launchStage = async (stageId: string): Promise<void> => {
    const definitionId = definitionIdForInstance(dag, stageId);
    const stage = stageById.get(definitionId);
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
        rootDir: factoryCwd,
        attempt,
        ...(prepared.operatorCatalog !== undefined
          ? { operatorCatalog: prepared.operatorCatalog }
          : {}),
        ...(prepared.skipGates ? { skipGates: true } : {}),
      });
      if (launchResult.type === "succeeded") {
        try {
          const envelope = await store.readEnvelope(run.runId, stageId);
          await onStageSuccess(stageId, envelope);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await handlePostSuccessError(stageId, reason);
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
      stageId,
      task,
      dag,
      checkoutRoot,
      workspaceDir: run.workspaceDir,
      hitl,
      attemptCtx,
      factoryCwd,
      operatorCatalog: prepared.operatorCatalog,
      completedEnvelopes,
      skipGates: prepared.skipGates,
    });

    if (isRunStageWaiting(result)) {
      await onStageFailure(stageId, WAIT_WITHOUT_WORKER_DISPATCH);
      return;
    }

    if (!result.ok) {
      await onStageFailure(
        stageId,
        result.reason ?? "stage failed",
        result.envelope,
      );
      return;
    }
    if (result.envelope) {
      try {
        await onStageSuccess(stageId, result.envelope);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await handlePostSuccessError(stageId, reason);
      }
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
      if (isRunnable(dag, node.id, states, schedulingHalted, completedEnvelopes)) {
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
    return {
      ok: false,
      outcome: "waiting",
      runDir: run.workspaceDir,
      runId: run.runId,
    };
  }

  if (schedulingHalted) {
    markSkippedPending();
    if (retryContext === undefined) {
      await store.updateRunStatus(run.runId, "failed");
    }
    return {
      ok: false,
      outcome: "failed",
      runDir: run.workspaceDir,
      runId: run.runId,
      reason: firstFailureReason,
    };
  }

  const allSucceeded = dag.nodes.every((node) => {
    const s = states.get(node.id);
    return s === "succeeded" || s === "skipped";
  });
  if (!allSucceeded) {
    if (retryContext === undefined) {
      await store.updateRunStatus(run.runId, "failed");
    }
    return {
      ok: false,
      outcome: "failed",
      runDir: run.workspaceDir,
      runId: run.runId,
      reason: firstFailureReason ?? "pipeline incomplete",
    };
  }

  await store.updateRunStatus(run.runId, "succeeded");
  return {
    ok: true,
    outcome: "succeeded",
    runDir: run.workspaceDir,
    runId: run.runId,
  };
}
