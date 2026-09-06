import type { FeedbackLoopContext, StageSessionMode } from "../agent/port.js";
import type {
  DeferredFeedbackSendBack,
  FeedbackLoopRecord,
  RunStore,
} from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import {
  acceptFeedbackSendBack,
  hydrateActiveFeedbackScheduleFromStore,
  markFeedbackLoopContinued,
  markFeedbackRouteStageFailed,
  markFeedbackRouteStageRunning,
  markFeedbackRouteStageSucceeded,
  rebindFeedbackRoutePassAttempts,
} from "./feedbackLoopCoordinator.js";
import { postSourceStageIds } from "./feedbackLoopRoute.js";
import {
  applyFeedbackSendBackToSchedule,
  createFeedbackScheduleState,
  isFeedbackHeld,
  releaseFeedbackHold,
  type FeedbackScheduleState,
} from "./feedbackLoopSchedule.js";

type StageScheduleState =
  | "pending"
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type ScheduleProjection = {
  dag: ResolvedPipelineDag;
  states: Map<string, StageScheduleState>;
  completedEnvelopes: Map<string, StageEnvelope>;
};

export type ReplayApplyResult =
  | {
      kind: "applied";
      loopId: string;
      replayId: string;
      retiredSkippedStageIds: string[];
      loop: FeedbackLoopRecord;
    }
  | {
      kind: "idempotent";
      loopId: string;
      replayId: string;
      retiredSkippedStageIds: string[];
      loop: FeedbackLoopRecord;
    }
  | {
      kind: "waiting_for_human";
      loop: FeedbackLoopRecord;
      deferred: DeferredFeedbackSendBack;
      sourceStageId: string;
      sourceAttempt: number;
    }
  | { kind: "rejected"; reason: string };

export type StageLaunchPrep = {
  attempt: number;
  sessionMode?: StageSessionMode;
  priorAttempt?: number;
  feedbackLoopContext?: FeedbackLoopContext;
};

export type ReplayScheduleHandle = {
  readonly feedback: FeedbackScheduleState;
};

export function createReplaySchedule(): ReplayScheduleHandle {
  return { feedback: createFeedbackScheduleState() };
}

export function isHeld(
  schedule: ReplayScheduleHandle,
  stageId: string,
): boolean {
  return isFeedbackHeld(schedule.feedback, stageId);
}

export function launchFor(
  schedule: ReplayScheduleHandle,
  stageId: string,
): StageLaunchPrep | undefined {
  const attempt = schedule.feedback.launchAttemptByStageId.get(stageId);
  if (attempt === undefined) return undefined;
  const sessionMode = schedule.feedback.sessionModeByStageId.get(stageId);
  const priorAttempt = schedule.feedback.priorAttemptByStageId.get(stageId);
  const feedbackLoopContext = schedule.feedback.contextsByStageId.get(stageId);
  return {
    attempt,
    ...(sessionMode !== undefined ? { sessionMode } : {}),
    ...(priorAttempt !== undefined ? { priorAttempt } : {}),
    ...(feedbackLoopContext !== undefined ? { feedbackLoopContext } : {}),
  };
}

export function launchAttemptFor(
  schedule: ReplayScheduleHandle,
  stageId: string,
): number | undefined {
  return schedule.feedback.launchAttemptByStageId.get(stageId);
}

export function clearLaunchPrep(
  schedule: ReplayScheduleHandle,
  stageId: string,
): void {
  schedule.feedback.contextsByStageId.delete(stageId);
  schedule.feedback.sessionModeByStageId.delete(stageId);
  schedule.feedback.priorAttemptByStageId.delete(stageId);
  schedule.feedback.launchAttemptByStageId.delete(stageId);
}

export function releaseHold(schedule: ReplayScheduleHandle): void {
  releaseFeedbackHold(schedule.feedback);
}

export function activeReplayId(
  schedule: ReplayScheduleHandle,
): string | undefined {
  return schedule.feedback.activeReplayId;
}

export function activeSourceStageId(
  schedule: ReplayScheduleHandle,
): string | undefined {
  return schedule.feedback.sourceStageId;
}

export function activeLoopId(
  schedule: ReplayScheduleHandle,
): string | undefined {
  return schedule.feedback.activeLoopId;
}

export function cohortOverrideMap(
  schedule: ReplayScheduleHandle,
): ReadonlyMap<string, ReadonlySet<string>> {
  return schedule.feedback.activeCloneIdsByForkParent;
}

export function noteActiveCohort(
  schedule: ReplayScheduleHandle,
  forkParent: string,
  cloneStageIds: readonly string[],
): void {
  schedule.feedback.activeCloneIdsByForkParent.set(
    forkParent,
    new Set(cloneStageIds),
  );
}

function armWaitingHold(
  schedule: ReplayScheduleHandle,
  dag: ResolvedPipelineDag,
  sourceStageId: string,
  loopId: string,
): void {
  if (schedule.feedback.activeHoldStageIds.size === 0) {
    schedule.feedback.activeHoldStageIds = new Set(
      postSourceStageIds(dag, sourceStageId),
    );
  }
  schedule.feedback.activeLoopId = loopId;
  schedule.feedback.sourceStageId = sourceStageId;
}

function projectAccepted(
  schedule: ReplayScheduleHandle,
  projection: ScheduleProjection,
  sourceId: string,
  accepted: {
    kind: "accepted" | "idempotent";
    loop: FeedbackLoopRecord;
    replay: { replay_id: string };
    routeStageIds: string[];
    launch: {
      contextsByStageId: Map<string, FeedbackLoopContext>;
      sessionModeByStageId: Map<string, StageSessionMode>;
      priorAttemptByStageId: Map<string, number>;
      launchAttemptByStageId: Map<string, number>;
      supersededCloneIds: ReadonlySet<string>;
    };
  },
): string[] {
  return applyFeedbackSendBackToSchedule({
    dag: projection.dag,
    sourceId,
    routeStageIds: accepted.routeStageIds,
    states: projection.states,
    completedEnvelopes: projection.completedEnvelopes,
    feedback: schedule.feedback,
    loopId: accepted.loop.loop_id,
    replayId: accepted.replay.replay_id,
    contextsByStageId: accepted.launch.contextsByStageId,
    sessionModeByStageId: accepted.launch.sessionModeByStageId,
    priorAttemptByStageId: accepted.launch.priorAttemptByStageId,
    launchAttemptByStageId: accepted.launch.launchAttemptByStageId,
    supersededCloneIds: accepted.launch.supersededCloneIds,
  });
}

export async function applySendBack(options: {
  store: RunStore;
  runId: string;
  sourceNode: ResolvedPipelineStageNode;
  sourceAttempt: number;
  envelope: StageEnvelope;
  schedule: ReplayScheduleHandle;
  projection: ScheduleProjection;
}): Promise<ReplayApplyResult> {
  const accepted = await acceptFeedbackSendBack({
    store: options.store,
    runId: options.runId,
    dag: options.projection.dag,
    sourceNode: options.sourceNode,
    sourceAttempt: options.sourceAttempt,
    envelope: options.envelope,
  });

  if (accepted.kind === "rejected") {
    return { kind: "rejected", reason: accepted.reason };
  }

  if (accepted.kind === "waiting_for_human") {
    armWaitingHold(
      options.schedule,
      options.projection.dag,
      accepted.sourceStageId,
      accepted.loop.loop_id,
    );
    return {
      kind: "waiting_for_human",
      loop: accepted.loop,
      deferred: accepted.deferred,
      sourceStageId: accepted.sourceStageId,
      sourceAttempt: accepted.sourceAttempt,
    };
  }

  const retiredSkippedStageIds = projectAccepted(
    options.schedule,
    options.projection,
    options.sourceNode.id,
    accepted,
  );

  return {
    kind: accepted.kind === "accepted" ? "applied" : "idempotent",
    loopId: accepted.loop.loop_id,
    replayId: accepted.replay.replay_id,
    retiredSkippedStageIds,
    loop: accepted.loop,
  };
}

export async function onRouteStageRunning(options: {
  store: RunStore;
  runId: string;
  schedule: ReplayScheduleHandle;
  stageId: string;
}): Promise<void> {
  await markFeedbackRouteStageRunning({
    store: options.store,
    runId: options.runId,
    replayId: options.schedule.feedback.activeReplayId,
    stageId: options.stageId,
  });
}

export async function onRouteStageSucceeded(options: {
  store: RunStore;
  runId: string;
  schedule: ReplayScheduleHandle;
  stageId: string;
  envelope: StageEnvelope;
}): Promise<void> {
  await markFeedbackRouteStageSucceeded({
    store: options.store,
    runId: options.runId,
    replayId: options.schedule.feedback.activeReplayId,
    stageId: options.stageId,
    envelope: options.envelope,
  });
  clearLaunchPrep(options.schedule, options.stageId);
}

export async function onRouteStageFailed(options: {
  store: RunStore;
  runId: string;
  schedule: ReplayScheduleHandle;
  stageId: string;
}): Promise<void> {
  await markFeedbackRouteStageFailed(
    options.store,
    options.runId,
    options.schedule.feedback.activeReplayId,
    options.stageId,
  );
}

export async function hydrateFromStore(
  schedule: ReplayScheduleHandle,
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
): Promise<
  | { loop: FeedbackLoopRecord; replay: { replay_id: string } }
  | undefined
> {
  return hydrateActiveFeedbackScheduleFromStore(
    store,
    runId,
    dag,
    schedule.feedback,
  );
}

export async function rebindRouteAttempts(
  schedule: ReplayScheduleHandle,
  store: RunStore,
  runId: string,
  overrides: ReadonlyMap<string, number>,
): Promise<void> {
  const replayId = schedule.feedback.activeReplayId;
  if (replayId === undefined || overrides.size === 0) return;
  await rebindFeedbackRoutePassAttempts(store, runId, replayId, overrides);
  for (const [stageId, attempt] of overrides) {
    if (!schedule.feedback.launchAttemptByStageId.has(stageId)) continue;
    schedule.feedback.launchAttemptByStageId.set(stageId, attempt);
  }
}

export async function onContinued(options: {
  store: RunStore;
  runId: string;
  sourceStageId: string;
  envelope: StageEnvelope;
  schedule: ReplayScheduleHandle;
}): Promise<void> {
  await markFeedbackLoopContinued({
    store: options.store,
    runId: options.runId,
    sourceStageId: options.sourceStageId,
    envelope: options.envelope,
  });
  releaseHold(options.schedule);
}

export async function resolveDecision(options: {
  store: RunStore;
  runId: string;
  decision: import("./feedbackLoopDecision.js").FeedbackLoopDecisionKind;
  loopId?: string;
  reason?: string;
  schedule: ReplayScheduleHandle;
  projection: ScheduleProjection;
  sourceNode: ResolvedPipelineStageNode;
}): Promise<
  import("./feedbackLoopDecision.js").ResolveFeedbackLoopDecisionResult
> {
  const { resolveFeedbackLoopDecision } = await import(
    "./feedbackLoopDecision.js"
  );
  return resolveFeedbackLoopDecision({
    store: options.store,
    runId: options.runId,
    decision: options.decision,
    loopId: options.loopId,
    reason: options.reason,
    schedule: {
      dag: options.projection.dag,
      sourceNode: options.sourceNode,
      states: options.projection.states,
      completedEnvelopes: options.projection.completedEnvelopes,
      feedback: options.schedule.feedback,
    },
  });
}
