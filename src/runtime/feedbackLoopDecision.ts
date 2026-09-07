import type {
  FeedbackLoopRecord,
  RunStore,
  StageSnapshot,
} from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import { terminalizeCurrentFeedbackReplay } from "./feedbackLoopCoordinator.js";
import type { FeedbackScheduleState } from "./feedbackLoopSchedule.js";
import { createFeedbackScheduleState } from "./feedbackLoopSchedule.js";
import {
  applySendBack,
  releaseHold,
  type ReplayScheduleHandle,
} from "./replayLifecycle.js";

export type FeedbackLoopDecisionKind = "extend" | "continue" | "abandon";

export type FeedbackLoopDecisionInput = {
  decision: FeedbackLoopDecisionKind;
  reason?: string;
};

type StageScheduleState =
  | "pending"
  | "active"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

export type FeedbackLoopDecisionScheduleContext = {
  dag: ResolvedPipelineDag;
  sourceNode: ResolvedPipelineStageNode;
  states: Map<string, StageScheduleState>;
  completedEnvelopes: Map<string, StageEnvelope>;
  feedback: FeedbackScheduleState;
};

export type ResolveFeedbackLoopDecisionResult =
  | {
      ok: true;
      effect: "extended";
      loop: FeedbackLoopRecord;
      replayId: string;
    }
  | {
      ok: true;
      effect: "continued";
      loop: FeedbackLoopRecord;
    }
  | {
      ok: true;
      effect: "abandoned";
      loop: FeedbackLoopRecord;
      reason: string;
    }
  | { ok: false; reason: string };

const DECISION_CONFLICT =
  "feedback loop decision conflict: no longer waiting_for_human";

async function clearSourceWaiting(
  store: RunStore,
  runId: string,
  sourceStageId: string,
  nextStatus: Extract<StageSnapshot["status"], "succeeded" | "failed">,
  reason?: string,
): Promise<void> {
  const latest = await store.getLatestStageExecution(runId, sourceStageId);
  const attempt = latest?.attempt;
  const eventOptions = attempt !== undefined ? { attempt } : undefined;
  if (nextStatus === "failed") {
    await store.appendStageEvent(
      runId,
      sourceStageId,
      {
        event: "failed",
        reason: reason ?? "feedback loop abandoned after max_replays",
      },
      eventOptions,
    );
  } else {
    await store.appendStageEvent(
      runId,
      sourceStageId,
      { event: "succeeded" },
      eventOptions,
    );
  }
  if (latest !== null && latest !== undefined) {
    await store.updateStageExecution(runId, sourceStageId, latest.attempt, {
      status: nextStatus,
      ...(nextStatus === "failed"
        ? { finished_at: new Date().toISOString() }
        : {}),
    });
  }
}

async function resolveSourceNode(
  store: RunStore,
  runId: string,
  sourceStageId: string,
  schedule?: FeedbackLoopDecisionScheduleContext,
): Promise<
  | { ok: true; dag: ResolvedPipelineDag; sourceNode: ResolvedPipelineStageNode }
  | { ok: false; reason: string }
> {
  if (schedule !== undefined) {
    return {
      ok: true,
      dag: schedule.dag,
      sourceNode: schedule.sourceNode,
    };
  }
  const meta = await store.readRunMeta(runId);
  const dag = meta.pipeline_dag;
  if (dag === undefined || dag === null) {
    return {
      ok: false,
      reason: "cannot resolve feedback loop decision without pipeline_dag on run",
    };
  }
  const sourceNode = dag.nodes.find((n) => n.id === sourceStageId);
  if (sourceNode === undefined || sourceNode.feedback_loop === undefined) {
    return {
      ok: false,
      reason: `source stage "${sourceStageId}" missing feedback_loop policy`,
    };
  }
  return { ok: true, dag, sourceNode };
}

export async function resolveFeedbackLoopDecision(options: {
  store: RunStore;
  runId: string;
  decision: FeedbackLoopDecisionKind;
  loopId?: string;
  reason?: string;
  schedule?: FeedbackLoopDecisionScheduleContext;
}): Promise<ResolveFeedbackLoopDecisionResult> {
  const { store, runId, decision, schedule } = options;
  const loops = await store.listFeedbackLoops(runId);
  const loop =
    options.loopId !== undefined
      ? loops.find((entry) => entry.loop_id === options.loopId)
      : loops
          .filter((entry) => entry.state === "waiting_for_human")
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  if (loop === undefined) {
    return {
      ok: false,
      reason:
        options.loopId !== undefined
          ? `feedback loop not found: ${options.loopId}`
          : "no feedback loop is waiting_for_human",
    };
  }
  if (loop.state !== "waiting_for_human") {
    return {
      ok: false,
      reason: `feedback loop "${loop.loop_id}" is not waiting_for_human (state=${loop.state})`,
    };
  }

  if (decision === "extend") {
    const deferred = loop.deferred_send_back;
    if (deferred === undefined) {
      return {
        ok: false,
        reason: `feedback loop "${loop.loop_id}" has no deferred send_back to extend`,
      };
    }
    const resolved = await resolveSourceNode(
      store,
      runId,
      loop.source_stage_id,
      schedule,
    );
    if (!resolved.ok) return resolved;

    const bumpedPolicy = {
      ...loop.policy,
      max_replays: loop.policy.max_replays + 1,
    };
    const casOk = await store.updateFeedbackLoop(
      runId,
      loop.loop_id,
      {
        policy: bumpedPolicy,
        state: "active",
      },
      { expectedState: "waiting_for_human" },
    );
    if (!casOk) {
      return {
        ok: false,
        reason: `${DECISION_CONFLICT} (loop=${loop.loop_id})`,
      };
    }
    await clearSourceWaiting(store, runId, loop.source_stage_id, "succeeded");

    if (schedule === undefined) {
      const applied = await applySendBack({
        store,
        runId,
        sourceNode: resolved.sourceNode,
        sourceAttempt: deferred.source_attempt,
        envelope: deferred.feedback_envelope,
        schedule: { feedback: createFeedbackScheduleState() },
        projection: {
          dag: resolved.dag,
          states: new Map(),
          completedEnvelopes: new Map(),
        },
      });
      if (applied.kind === "rejected") {
        return { ok: false, reason: applied.reason };
      }
      if (applied.kind === "waiting_for_human") {
        return {
          ok: false,
          reason: "extend still exceeded max_replays after bump",
        };
      }
      const updated = await store.getFeedbackLoop(runId, loop.loop_id);
      return {
        ok: true,
        effect: "extended",
        loop: updated,
        replayId: applied.replayId,
      };
    }

    const handle: ReplayScheduleHandle = { feedback: schedule.feedback };
    const applied = await applySendBack({
      store,
      runId,
      sourceNode: resolved.sourceNode,
      sourceAttempt: deferred.source_attempt,
      envelope: deferred.feedback_envelope,
      schedule: handle,
      projection: {
        dag: schedule.dag,
        states: schedule.states,
        completedEnvelopes: schedule.completedEnvelopes,
      },
    });
    if (applied.kind === "rejected") {
      return { ok: false, reason: applied.reason };
    }
    if (applied.kind === "waiting_for_human") {
      return {
        ok: false,
        reason: "extend still exceeded max_replays after bump",
      };
    }

    const updated = await store.getFeedbackLoop(runId, loop.loop_id);
    return {
      ok: true,
      effect: "extended",
      loop: updated,
      replayId: applied.replayId,
    };
  }

  if (decision === "continue") {
    const deferred = loop.deferred_send_back;
    const casOk = await store.updateFeedbackLoop(
      runId,
      loop.loop_id,
      { state: "continued" },
      { expectedState: "waiting_for_human" },
    );
    if (!casOk) {
      return {
        ok: false,
        reason: `${DECISION_CONFLICT} (loop=${loop.loop_id})`,
      };
    }
    await terminalizeCurrentFeedbackReplay(store, runId, loop, "completed");
    await clearSourceWaiting(store, runId, loop.source_stage_id, "succeeded");
    if (schedule !== undefined) {
      schedule.states.set(loop.source_stage_id, "succeeded");
      if (
        schedule.completedEnvelopes.get(loop.source_stage_id) === undefined &&
        deferred !== undefined
      ) {
        schedule.completedEnvelopes.set(
          loop.source_stage_id,
          deferred.feedback_envelope,
        );
      }
      releaseHold({ feedback: schedule.feedback });
    }
    const updated = await store.getFeedbackLoop(runId, loop.loop_id);
    return { ok: true, effect: "continued", loop: updated };
  }

  const abandonReason =
    options.reason?.trim() ||
    `feedback loop abandoned after max_replays (${loop.policy.max_replays})`;
  const casOk = await store.updateFeedbackLoop(
    runId,
    loop.loop_id,
    { state: "abandoned" },
    { expectedState: "waiting_for_human" },
  );
  if (!casOk) {
    return {
      ok: false,
      reason: `${DECISION_CONFLICT} (loop=${loop.loop_id})`,
    };
  }
  await terminalizeCurrentFeedbackReplay(store, runId, loop, "failed");
  await clearSourceWaiting(
    store,
    runId,
    loop.source_stage_id,
    "failed",
    abandonReason,
  );
  if (schedule !== undefined) {
    schedule.states.set(loop.source_stage_id, "failed");
    releaseHold({ feedback: schedule.feedback });
  }
  await store.updateRunStatus(runId, "failed");
  const updated = await store.getFeedbackLoop(runId, loop.loop_id);
  return {
    ok: true,
    effect: "abandoned",
    loop: updated,
    reason: abandonReason,
  };
}
