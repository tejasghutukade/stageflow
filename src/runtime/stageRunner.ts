import type { AgentPort, StageHandle, StageRunResult } from "../agent/port.js";
import type { StageLogLine } from "../agent/activity.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { StageConfig } from "../types/stage.js";
import type { TaskFile } from "../types/task.js";
import type { RunStore } from "../runstore/port.js";
import type { StageLogEvent } from "../runstore/port.js";
import { deriveExecutionPatchFromEvent } from "../runstore/stageExecution.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageAttemptContext } from "./stageAttemptContext.js";
import {
  buildStageRoots,
  withResolvedAuthPath,
  type StageRoots,
} from "./stageRoots.js";
import {
  createDefaultHitlQaHooks,
  recordWaitEnter,
  type StageHitlController,
} from "./stageHitl.js";
import {
  openStageAttempt,
  type OperatorCatalog,
} from "./stageAttemptBootstrap.js";

export type RunStageOutcome = StageRunResult | { waiting: true };

export type RunStageYieldLoopResult = StageRunResult | { waiting: true };

export function isRunStageWaiting(
  outcome: RunStageOutcome,
): outcome is { waiting: true } {
  return "waiting" in outcome && outcome.waiting === true;
}

export type RunStageOptions = {
  agent: AgentPort;
  store: RunStore;
  runId: string;
  stage: StageConfig;
  task: TaskFile;
  dag?: ResolvedPipelineDag;
  priorEnvelope?: StageEnvelope | null;
  checkoutRoot?: string;
  workspaceDir?: string;
  hitl?: StageHitlController;
  /** Skip appending `started` (restart reconstruct already past start). */
  skipStarted?: boolean;
  /** When set, used instead of buildStageRoots (worker cursor isolation). */
  roots?: StageRoots;
  /**
   * When set, use this handle instead of openStage (restart: caller opens and
   * may pre-inject the answer before the yield loop).
   */
  existingHandle?: StageHandle;
  workerMode?: boolean;
  attemptCtx?: StageAttemptContext;
  /** Factory project root for credential binding (settings + SF-owned auth). */
  factoryCwd?: string;
  operatorCatalog?: OperatorCatalog;
  completedEnvelopes?: Map<string, StageEnvelope>;
  skipGates?: boolean;
  stageId?: string;
};

const LIFECYCLE_EVENTS = new Set([
  "started",
  "resumed",
  "waiting_for_input",
  "succeeded",
  "failed",
]);

async function ensureStageExecutionForAttempt(
  store: RunStore,
  runId: string,
  stageId: string,
  attempt: number,
): Promise<void> {
  try {
    await store.getStageExecution(runId, stageId, attempt);
  } catch {
    if (attempt !== 1) {
      throw new Error(
        `Stage execution not found: ${runId}/${stageId} attempt ${attempt}`,
      );
    }
    await store.createStageExecution(runId, stageId);
  }
}

async function appendLifecycleEventAndPatchExecution(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  event: StageLogEvent;
  attemptCtx?: StageAttemptContext;
}): Promise<void> {
  const { store, runId, stageId, event, attemptCtx } = options;
  const attemptNum = attemptCtx?.attempt ?? 1;
  const attemptOpt = attemptCtx?.eventOptions();
  await store.appendStageEvent(runId, stageId, event, attemptOpt);
  if (!LIFECYCLE_EVENTS.has(event.event)) return;
  try {
    const execution = await store.getStageExecution(runId, stageId, attemptNum);
    const patch = deriveExecutionPatchFromEvent(event, execution);
    if (Object.keys(patch).length === 0) return;
    await store.updateStageExecution(runId, stageId, attemptNum, patch);
  } catch {
    // no execution row yet
  }
}

async function finalizeStageResult(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  result: StageRunResult;
  activityChain: Promise<void>;
  attemptCtx?: StageAttemptContext;
}): Promise<StageRunResult> {
  const { store, runId, stageId, result, activityChain, attemptCtx } = options;
  const attemptOpt = attemptCtx?.eventOptions();
  await activityChain;

  if (result.envelope) {
    await store.writeEnvelope(runId, stageId, result.envelope, attemptOpt);
  }

  if (!result.ok) {
    await appendLifecycleEventAndPatchExecution({
      store,
      runId,
      stageId,
      event: { event: "failed", reason: result.reason },
      attemptCtx,
    });
    console.error(`Stage ${stageId} failed: ${result.reason}`);
    return result;
  }

  await appendLifecycleEventAndPatchExecution({
    store,
    runId,
    stageId,
    event: { event: "succeeded" },
    attemptCtx,
  });
  console.error(`Stage ${stageId} succeeded.`);
  return result;
}

/**
 * Yield loop: next() until completed; on wait, coordinator enterWait (KTD6).
 */
export async function runStageYieldLoop(options: {
  handle: StageHandle;
  runId: string;
  stageId: string;
  hitl?: StageHitlController;
  workerMode?: boolean;
  store?: RunStore;
  attemptCtx?: StageAttemptContext;
  skipGates?: boolean;
}): Promise<RunStageYieldLoopResult> {
  const { handle, runId, stageId, hitl, workerMode, store, attemptCtx, skipGates } = options;

  while (true) {
    const event = await handle.next();
    if (event.status === "waiting_for_input") {
      if (skipGates) {
        return {
          ok: false,
          reason: "skip-gates: stage requested wait",
        };
      }
      if (workerMode) {
        if (!store) {
          return {
            ok: false,
            reason: "workerMode requires store",
          };
        }
        await recordWaitEnter({
          store,
          runId,
          stageId,
          request: event.request,
          attemptCtx,
          qaHooks: createDefaultHitlQaHooks(store),
        });
        return { waiting: true };
      }
      if (!hitl) {
        return {
          ok: false,
          reason: "stage requested wait but no HITL controller is configured",
        };
      }
      await hitl.enterWait(runId, stageId, handle, event.request, attemptCtx);
      continue;
    }
    return event.result;
  }
}

export async function runStage(
  options: RunStageOptions,
): Promise<RunStageOutcome> {
  const {
    agent,
    store,
    runId,
    stage,
    task,
    dag,
    checkoutRoot,
    workspaceDir,
    hitl,
    skipStarted,
    existingHandle,
    workerMode,
    roots: rootsOverride,
    attemptCtx,
    factoryCwd,
    operatorCatalog,
    completedEnvelopes,
    skipGates,
  } = options;
  const stageId = options.stageId ?? stage.id;
  const attemptOpt = attemptCtx?.eventOptions();
  const baseRoots =
    rootsOverride ??
    buildStageRoots(
      workspaceDir ?? store.getWorkspaceDir(runId),
      stageId,
      checkoutRoot,
      attemptCtx,
    );
  const roots =
    factoryCwd !== undefined
      ? withResolvedAuthPath(baseRoots, factoryCwd)
      : baseRoots;
  const attempt = attemptCtx?.attempt ?? 1;
  await ensureStageExecutionForAttempt(store, runId, stageId, attempt);
  await store.ensureAttemptWorkspace(runId, stageId, attempt);
  if (!skipStarted) {
    await appendLifecycleEventAndPatchExecution({
      store,
      runId,
      stageId,
      event: { event: "started" },
      attemptCtx,
    });
  }
  console.error(`Running stage ${stageId} (${stage.model})...`);

  let activityChain = Promise.resolve();
  const enqueueActivity = (event: StageLogLine) => {
    activityChain = activityChain.then(() =>
      store.appendStageEvent(runId, stageId, event, attemptOpt),
    );
  };

  let handle: StageHandle;
  if (existingHandle) {
    handle = existingHandle;
  } else {
    const opened = await openStageAttempt({
      agent,
      store,
      runId,
      stage,
      stageId,
      task,
      dag: dag ?? {
        nodes: [
          { id: stageId, needs: null, ancestors: [], stageIndex: 0 },
        ],
        roots: [stageId],
        childrenOf: {},
      },
      checkoutRoot,
      workspaceDir: workspaceDir ?? store.getWorkspaceDir(runId),
      factoryCwd,
      attemptCtx,
      operatorCatalog,
      roots,
      completedEnvelopes,
      onActivity: (event) => {
        enqueueActivity(event);
      },
    });
    if (!opened.ok) {
      await appendLifecycleEventAndPatchExecution({
        store,
        runId,
        stageId,
        event: { event: "failed", reason: opened.reason },
        attemptCtx,
      });
      console.error(`Stage ${stageId} failed: ${opened.reason}`);
      return { ok: false, reason: opened.reason };
    }
    handle = opened.handle;
  }

  let outcome: RunStageYieldLoopResult;
  try {
    outcome = await runStageYieldLoop({
      handle,
      runId,
      stageId,
      hitl,
      workerMode,
      store: workerMode ? store : undefined,
      attemptCtx,
      skipGates,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await activityChain;
    hitl?.clearLiveWait(runId, stageId);
    await appendLifecycleEventAndPatchExecution({
      store,
      runId,
      stageId,
      event: { event: "failed", reason },
      attemptCtx,
    });
    console.error(`Stage ${stageId} failed: ${reason}`);
    await handle.close().catch(() => undefined);
    return { ok: false, reason };
  }

  if (isRunStageWaiting(outcome)) {
    await activityChain;
    await handle.close({ park: true }).catch(() => undefined);
    return { waiting: true };
  }

  try {
    return await finalizeStageResult({
      store,
      runId,
      stageId,
      result: outcome,
      activityChain,
      attemptCtx,
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
