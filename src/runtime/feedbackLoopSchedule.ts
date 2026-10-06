import type { FeedbackLoopContext, StageSessionMode } from "../agent/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import { postSourceStageIds } from "./feedbackLoopRoute.js";

type StageScheduleState =
  | "pending"
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type FeedbackScheduleState = {
  activeHoldStageIds: Set<string>;
  contextsByStageId: Map<string, FeedbackLoopContext>;
  sessionModeByStageId: Map<string, StageSessionMode>;
  priorAttemptByStageId: Map<string, number>;
  launchAttemptByStageId: Map<string, number>;
  activeLoopId?: string;
  activeReplayId?: string;
  sourceStageId?: string;
  /**
   * Fork-parent → active cohort clone ids. An empty set means the prior
   * cohort was superseded and a fresh fan-out has not minted yet (joins wait).
   */
  activeCloneIdsByForkParent: Map<string, Set<string>>;
};

export function createFeedbackScheduleState(): FeedbackScheduleState {
  return {
    activeHoldStageIds: new Set(),
    contextsByStageId: new Map(),
    sessionModeByStageId: new Map(),
    priorAttemptByStageId: new Map(),
    launchAttemptByStageId: new Map(),
    activeCloneIdsByForkParent: new Map(),
  };
}

export function applyFeedbackSendBackToSchedule(options: {
  dag: ResolvedPipelineDag;
  sourceId: string;
  routeStageIds: string[];
  states: Map<string, StageScheduleState>;
  completedEnvelopes: Map<string, StageEnvelope>;
  feedback: FeedbackScheduleState;
  loopId: string;
  replayId: string;
  contextsByStageId: Map<string, FeedbackLoopContext>;
  sessionModeByStageId: Map<string, StageSessionMode>;
  priorAttemptByStageId: Map<string, number>;
  launchAttemptByStageId: Map<string, number>;
  supersededCloneIds?: ReadonlySet<string>;
}): string[] {
  const {
    dag,
    sourceId,
    routeStageIds,
    states,
    completedEnvelopes,
    feedback,
  } = options;

  const routeSet = new Set(routeStageIds);
  const retiredSkippedIds: string[] = [];

  for (const cloneId of options.supersededCloneIds ?? []) {
    if (routeSet.has(cloneId)) continue;
    const state = states.get(cloneId);
    if (state !== "skipped") {
      states.set(cloneId, "skipped");
      retiredSkippedIds.push(cloneId);
    }
    completedEnvelopes.delete(cloneId);
    for (const desc of postSourceStageIds(dag, cloneId)) {
      if (routeSet.has(desc)) continue;
      if (feedback.activeHoldStageIds?.has(desc)) continue;
      const descState = states.get(desc);
      if (descState === "pending" || descState === "succeeded" || descState === "active") {
        states.set(desc, "skipped");
        retiredSkippedIds.push(desc);
        completedEnvelopes.delete(desc);
      }
    }
  }

  for (const stageId of routeStageIds) {
    states.set(stageId, "pending");
    completedEnvelopes.delete(stageId);
  }

  feedback.activeHoldStageIds = new Set(postSourceStageIds(dag, sourceId));
  feedback.contextsByStageId = new Map(options.contextsByStageId);
  feedback.sessionModeByStageId = new Map(options.sessionModeByStageId);
  feedback.priorAttemptByStageId = new Map(options.priorAttemptByStageId);
  feedback.launchAttemptByStageId = new Map(options.launchAttemptByStageId);
  feedback.activeLoopId = options.loopId;
  feedback.activeReplayId = options.replayId;
  feedback.sourceStageId = sourceId;

  for (const cloneId of options.supersededCloneIds ?? []) {
    const node = dag.nodes.find((n) => n.id === cloneId);
    const forkParentId = node?.needs;
    if (forkParentId !== undefined && forkParentId !== null) {
      feedback.activeCloneIdsByForkParent.set(forkParentId, new Set());
    }
  }

  return retiredSkippedIds;
}

export function releaseFeedbackHold(feedback: FeedbackScheduleState): void {
  feedback.activeHoldStageIds.clear();
  feedback.contextsByStageId.clear();
  feedback.sessionModeByStageId.clear();
  feedback.priorAttemptByStageId.clear();
  feedback.launchAttemptByStageId.clear();
  feedback.activeLoopId = undefined;
  feedback.activeReplayId = undefined;
  feedback.sourceStageId = undefined;
  feedback.activeCloneIdsByForkParent.clear();
}

export function isFeedbackHeld(
  feedback: FeedbackScheduleState,
  stageId: string,
): boolean {
  return feedback.activeHoldStageIds.has(stageId);
}
