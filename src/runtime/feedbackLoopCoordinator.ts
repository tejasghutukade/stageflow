import { randomUUID } from "node:crypto";
import type { FeedbackLoopContext, StageSessionMode } from "../agent/port.js";
import type {
  DeferredFeedbackSendBack,
  FeedbackLoopRecord,
  FeedbackReplayRecord,
  RunPipelineDagSnapshot,
  RunStore,
} from "../runstore/port.js";
import { instancesOfDefinition } from "../runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../types/envelope.js";
import type {
  FeedbackLoopConfig,
  ResolvedPipelineDag,
  ResolvedPipelineStageNode,
} from "../types/pipeline.js";
import { feedbackRouteStageIds, postSourceStageIds } from "./feedbackLoopRoute.js";
import type { FeedbackScheduleState } from "./feedbackLoopSchedule.js";
import {
  collectSupersededCloneIdsForRoute,
  retireCohortsForRoute,
} from "./forkGeneration.js";

/** Launch/schedule payload consumed only by ReplayLifecycle. */
export type FeedbackSendBackLaunchMaps = {
  contextsByStageId: Map<string, FeedbackLoopContext>;
  sessionModeByStageId: Map<string, StageSessionMode>;
  priorAttemptByStageId: Map<string, number>;
  launchAttemptByStageId: Map<string, number>;
  supersededCloneIds: ReadonlySet<string>;
};

export type FeedbackSendBackAccepted = {
  kind: "accepted";
  loop: FeedbackLoopRecord;
  replay: FeedbackReplayRecord;
  routeStageIds: string[];
  launch: FeedbackSendBackLaunchMaps;
};

export type FeedbackSendBackIdempotent = {
  kind: "idempotent";
  loop: FeedbackLoopRecord;
  replay: FeedbackReplayRecord;
  routeStageIds: string[];
  launch: FeedbackSendBackLaunchMaps;
};

export type FeedbackSendBackWaitingForHuman = {
  kind: "waiting_for_human";
  loop: FeedbackLoopRecord;
  deferred: DeferredFeedbackSendBack;
  sourceStageId: string;
  sourceAttempt: number;
};

export type FeedbackSendBackRejected = {
  kind: "rejected";
  reason: string;
};

export type FeedbackSendBackResult =
  | FeedbackSendBackAccepted
  | FeedbackSendBackIdempotent
  | FeedbackSendBackWaitingForHuman
  | FeedbackSendBackRejected;

function toStageSessionMode(
  replaySession: FeedbackLoopConfig["replay_session"],
): StageSessionMode {
  return replaySession === "resume" ? "feedback_resume" : "new_session";
}

async function resolveResumeSessionAttempt(
  store: RunStore,
  runId: string,
  loopId: string,
  stageId: string,
  fallbackAttempt?: number,
): Promise<number | undefined> {
  const replays = await store.listFeedbackReplays(runId, loopId);
  let minPassAttempt: number | undefined;
  for (const replay of replays) {
    const passes = await store.listFeedbackReplayStagePasses(
      runId,
      replay.replay_id,
    );
    for (const pass of passes) {
      if (pass.stage_id !== stageId) continue;
      if (
        minPassAttempt === undefined ||
        pass.stage_attempt < minPassAttempt
      ) {
        minPassAttempt = pass.stage_attempt;
      }
    }
  }
  if (minPassAttempt !== undefined && minPassAttempt > 1) {
    return minPassAttempt - 1;
  }
  return fallbackAttempt;
}

function buildContext(options: {
  loop: FeedbackLoopRecord;
  replay: FeedbackReplayRecord;
  stageId: string;
  priorAttempt?: number;
  activeForkGenerationId?: string;
  activeForkCloneStageIds?: string[];
}): FeedbackLoopContext {
  const { loop, replay, stageId, priorAttempt } = options;
  const remaining = Math.max(0, replay.max_replays - replay.replay_number);
  return {
    loop_id: loop.loop_id,
    replay_id: replay.replay_id,
    source_stage_id: replay.source_stage_id,
    target_stage_id: replay.target_stage_id,
    feedback_envelope: replay.feedback_envelope,
    replay_number: replay.replay_number,
    max_replays: replay.max_replays,
    remaining_replays: remaining,
    is_final_replay: remaining === 0,
    replay_session: replay.replay_session,
    route_stage_ids: replay.route_stage_ids,
    ...(priorAttempt !== undefined
      ? { prior_stage_attempt: priorAttempt }
      : {}),
    ...(options.activeForkGenerationId !== undefined
      ? { active_fork_generation_id: options.activeForkGenerationId }
      : {}),
    ...(options.activeForkCloneStageIds !== undefined
      ? { active_fork_clone_stage_ids: options.activeForkCloneStageIds }
      : {}),
  };
}

async function attachActiveForkContext(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  contextsByStageId: Map<string, FeedbackLoopContext>,
): Promise<void> {
  for (const [stageId, ctx] of contextsByStageId) {
    const node = dag.nodes.find((n) => n.id === stageId);
    if (node === undefined || node.needs === null) continue;
    const snapshot = dag as RunPipelineDagSnapshot;
    const instances = Array.isArray(snapshot.stage_ids)
      ? instancesOfDefinition(snapshot, node.needs).filter(
          (id) => id !== node.needs,
        )
      : [];
    if (instances.length === 0) continue;
    const sample = dag.nodes.find((n) => n.id === instances[0]);
    const forkParentId = sample?.needs;
    if (forkParentId === undefined || forkParentId === null) continue;
    const gens = await store.listForkGenerations(runId, {
      forkParentStageId: forkParentId,
    });
    const active = gens.find((g) => g.status === "active");
    if (active === undefined) continue;
    contextsByStageId.set(stageId, {
      ...ctx,
      active_fork_generation_id: active.generation_id,
      active_fork_clone_stage_ids: [...active.clone_stage_ids],
    });
  }
}

async function rebuildLaunchMaps(
  store: RunStore,
  runId: string,
  loop: FeedbackLoopRecord,
  replay: FeedbackReplayRecord,
  dag?: ResolvedPipelineDag,
): Promise<{
  contextsByStageId: Map<string, FeedbackLoopContext>;
  sessionModeByStageId: Map<string, StageSessionMode>;
  priorAttemptByStageId: Map<string, number>;
  launchAttemptByStageId: Map<string, number>;
}> {
  const sessionMode = toStageSessionMode(replay.replay_session);
  const contextsByStageId = new Map<string, FeedbackLoopContext>();
  const sessionModeByStageId = new Map<string, StageSessionMode>();
  const priorAttemptByStageId = new Map<string, number>();
  const launchAttemptByStageId = new Map<string, number>();
  const passes = await store.listFeedbackReplayStagePasses(runId, replay.replay_id);
  for (const pass of passes) {
    const prior =
      replay.replay_session === "resume"
        ? await resolveResumeSessionAttempt(
            store,
            runId,
            loop.loop_id,
            pass.stage_id,
            pass.stage_attempt > 1 ? pass.stage_attempt - 1 : undefined,
          )
        : pass.stage_attempt > 1
          ? pass.stage_attempt - 1
          : undefined;
    contextsByStageId.set(
      pass.stage_id,
      buildContext({
        loop,
        replay,
        stageId: pass.stage_id,
        ...(prior !== undefined ? { priorAttempt: prior } : {}),
      }),
    );
    sessionModeByStageId.set(pass.stage_id, sessionMode);
    if (prior !== undefined) {
      priorAttemptByStageId.set(pass.stage_id, prior);
    }
    launchAttemptByStageId.set(pass.stage_id, pass.stage_attempt);
  }
  if (dag !== undefined) {
    await attachActiveForkContext(store, runId, dag, contextsByStageId);
  }
  return {
    contextsByStageId,
    sessionModeByStageId,
    priorAttemptByStageId,
    launchAttemptByStageId,
  };
}

export async function acceptFeedbackSendBack(options: {
  store: RunStore;
  runId: string;
  dag: ResolvedPipelineDag;
  sourceNode: ResolvedPipelineStageNode;
  sourceAttempt: number;
  envelope: StageEnvelope;
}): Promise<FeedbackSendBackResult> {
  const { store, runId, dag, sourceNode, sourceAttempt, envelope } = options;
  const action = envelope.feedback_loop;
  if (action === undefined || action.action !== "send_back") {
    return { kind: "rejected", reason: "envelope is not a feedback_loop send_back" };
  }
  const nodePolicy = sourceNode.feedback_loop;
  if (nodePolicy === undefined) {
    return {
      kind: "rejected",
      reason: `stage "${sourceNode.id}" has no feedback_loop policy`,
    };
  }

  const loops = await store.listFeedbackLoops(runId);
  const otherActive = loops.find(
    (loop) =>
      (loop.state === "active" || loop.state === "waiting_for_human") &&
      loop.source_stage_id !== sourceNode.id,
  );
  if (otherActive !== undefined) {
    return {
      kind: "rejected",
      reason: `run already has an active feedback loop from "${otherActive.source_stage_id}"`,
    };
  }

  let loop =
    loops.find(
      (entry) =>
        entry.source_stage_id === sourceNode.id &&
        (entry.state === "active" || entry.state === "waiting_for_human"),
    ) ??
    loops.find((entry) => entry.source_stage_id === sourceNode.id);

  if (loop !== undefined && loop.state !== "active" && loop.state !== "waiting_for_human") {
    loop = undefined;
  }

  if (loop === undefined) {
    loop = await store.createFeedbackLoop(runId, {
      loop_id: randomUUID(),
      source_stage_id: sourceNode.id,
      source_attempt: sourceAttempt,
      policy: nodePolicy,
    });
  }

  const existingReplays = await store.listFeedbackReplays(runId, loop.loop_id);
  const duplicate = existingReplays.find(
    (replay) =>
      replay.source_attempt === sourceAttempt &&
      replay.target_stage_id === action.target,
  );
  if (duplicate !== undefined) {
    const maps = await rebuildLaunchMaps(store, runId, loop, duplicate, dag);
    const supersededCloneIds = await collectSupersededCloneIdsForRoute({
      store,
      runId,
      dag,
      routeStageIds: duplicate.route_stage_ids,
    });
    return {
      kind: "idempotent",
      loop,
      replay: duplicate,
      routeStageIds: duplicate.route_stage_ids,
      launch: {
        ...maps,
        supersededCloneIds,
      },
    };
  }

  const nextReplayNumber = (loop.current_replay_number ?? 0) + 1;
  const policy = loop.policy;
  if (nextReplayNumber > policy.max_replays) {
    if (policy.on_max_replays === "wait_for_human") {
      const deferred: DeferredFeedbackSendBack = {
        target: action.target,
        feedback_envelope: envelope,
        source_attempt: sourceAttempt,
      };
      await store.updateFeedbackLoop(runId, loop.loop_id, {
        state: "waiting_for_human",
        deferred_send_back: deferred,
      });
      const waitingLoop = await store.getFeedbackLoop(runId, loop.loop_id);
      return {
        kind: "waiting_for_human",
        loop: waitingLoop,
        deferred,
        sourceStageId: sourceNode.id,
        sourceAttempt,
      };
    }
    return {
      kind: "rejected",
      reason: `feedback loop exceeded max_replays (${policy.max_replays}); require_continue`,
    };
  }

  if (loop.current_replay_id !== undefined) {
    const currentPasses = await store.listFeedbackReplayStagePasses(
      runId,
      loop.current_replay_id,
    );
    const sourcePass = currentPasses.find((p) => p.stage_id === sourceNode.id);
    if (sourcePass !== undefined && sourcePass.status !== "succeeded") {
      await store.updateFeedbackReplayStagePass(
        runId,
        loop.current_replay_id,
        sourceNode.id,
        {
          status: "succeeded",
          finished_at: new Date().toISOString(),
          emitted_envelope: envelope,
        },
      );
    }
    await store.updateFeedbackReplay(runId, loop.current_replay_id, {
      status: "completed",
    });
  }

  const routeStageIds = feedbackRouteStageIds(sourceNode, action.target);
  const { supersededCloneIds } = await retireCohortsForRoute({
    store,
    runId,
    dag,
    routeStageIds,
  });

  const replayId = randomUUID();
  const replay = await store.createFeedbackReplay(runId, {
    replay_id: replayId,
    loop_id: loop.loop_id,
    source_stage_id: sourceNode.id,
    source_attempt: sourceAttempt,
    target_stage_id: action.target,
    replay_number: nextReplayNumber,
    max_replays: policy.max_replays,
    replay_session: policy.replay_session,
    route_stage_ids: routeStageIds,
    feedback_envelope: envelope,
    status: "active",
  });

  const sessionMode = toStageSessionMode(policy.replay_session);
  const contextsByStageId = new Map<string, FeedbackLoopContext>();
  const sessionModeByStageId = new Map<string, StageSessionMode>();
  const priorAttemptByStageId = new Map<string, number>();
  const launchAttemptByStageId = new Map<string, number>();

  for (const stageId of routeStageIds) {
    const latest = await store.getLatestStageExecution(runId, stageId);
    const priorAttempt =
      policy.replay_session === "resume"
        ? await resolveResumeSessionAttempt(
            store,
            runId,
            loop.loop_id,
            stageId,
            latest?.attempt,
          )
        : latest?.attempt;
    const nextExecution = await store.createStageExecution(runId, stageId);
    await store.createFeedbackReplayStagePass(runId, {
      replay_id: replayId,
      stage_id: stageId,
      stage_attempt: nextExecution.attempt,
      session_mode: policy.replay_session,
      status: "pending",
    });
    contextsByStageId.set(
      stageId,
      buildContext({
        loop,
        replay,
        stageId,
        ...(priorAttempt !== undefined ? { priorAttempt } : {}),
      }),
    );
    sessionModeByStageId.set(stageId, sessionMode);
    if (priorAttempt !== undefined) {
      priorAttemptByStageId.set(stageId, priorAttempt);
    }
    launchAttemptByStageId.set(stageId, nextExecution.attempt);
  }

  await attachActiveForkContext(store, runId, dag, contextsByStageId);

  await store.updateFeedbackLoop(runId, loop.loop_id, {
    state: "active",
    current_replay_id: replayId,
    current_replay_number: nextReplayNumber,
    deferred_send_back: null,
  });

  const updatedLoop = await store.getFeedbackLoop(runId, loop.loop_id);
  return {
    kind: "accepted",
    loop: updatedLoop,
    replay,
    routeStageIds,
    launch: {
      contextsByStageId,
      sessionModeByStageId,
      priorAttemptByStageId,
      launchAttemptByStageId,
      supersededCloneIds,
    },
  };
}

export async function markFeedbackLoopContinued(options: {
  store: RunStore;
  runId: string;
  sourceStageId: string;
  envelope: StageEnvelope;
}): Promise<void> {
  const { store, runId, sourceStageId, envelope } = options;
  const loops = await store.listFeedbackLoops(runId);
  const loop = loops.find(
    (entry) =>
      entry.source_stage_id === sourceStageId &&
      (entry.state === "active" || entry.state === "waiting_for_human"),
  );
  if (loop === undefined) return;

  if (loop.current_replay_id !== undefined) {
    const passes = await store.listFeedbackReplayStagePasses(
      runId,
      loop.current_replay_id,
    );
    const sourcePass = passes.find((p) => p.stage_id === sourceStageId);
    if (sourcePass !== undefined && sourcePass.status !== "succeeded") {
      await store.updateFeedbackReplayStagePass(
        runId,
        loop.current_replay_id,
        sourceStageId,
        {
          status: "succeeded",
          finished_at: new Date().toISOString(),
          emitted_envelope: envelope,
        },
      );
    }
    await store.updateFeedbackReplay(runId, loop.current_replay_id, {
      status: "completed",
    });
  }

  await store.updateFeedbackLoop(runId, loop.loop_id, {
    state: "continued",
  });
}

export async function markFeedbackRouteStageSucceeded(options: {
  store: RunStore;
  runId: string;
  replayId: string | undefined;
  stageId: string;
  envelope: StageEnvelope;
}): Promise<void> {
  const { store, runId, replayId, stageId, envelope } = options;
  if (replayId === undefined) return;
  const passes = await store.listFeedbackReplayStagePasses(runId, replayId);
  const pass = passes.find((p) => p.stage_id === stageId);
  if (pass === undefined) return;
  await store.updateFeedbackReplayStagePass(runId, replayId, stageId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    emitted_envelope: envelope,
  });
}

export async function markFeedbackRouteStageFailed(
  store: RunStore,
  runId: string,
  replayId: string | undefined,
  stageId: string,
): Promise<void> {
  if (replayId === undefined) return;
  const passes = await store.listFeedbackReplayStagePasses(runId, replayId);
  const pass = passes.find((p) => p.stage_id === stageId);
  if (pass === undefined || pass.status === "succeeded") return;
  await store.updateFeedbackReplayStagePass(runId, replayId, stageId, {
    status: "failed",
    finished_at: new Date().toISOString(),
  });
}

export async function markFeedbackRouteStageRunning(options: {
  store: RunStore;
  runId: string;
  replayId: string | undefined;
  stageId: string;
}): Promise<void> {
  const { store, runId, replayId, stageId } = options;
  if (replayId === undefined) return;
  const passes = await store.listFeedbackReplayStagePasses(runId, replayId);
  const pass = passes.find((p) => p.stage_id === stageId);
  if (pass === undefined || pass.status !== "pending") return;
  await store.updateFeedbackReplayStagePass(runId, replayId, stageId, {
    status: "running",
    started_at: new Date().toISOString(),
  });
}

export async function hydrateActiveFeedbackScheduleFromStore(
  store: RunStore,
  runId: string,
  dag: ResolvedPipelineDag,
  feedback: FeedbackScheduleState,
): Promise<
  { loop: FeedbackLoopRecord; replay: FeedbackReplayRecord } | undefined
> {
  const loops = await store.listFeedbackLoops(runId);
  const loop = loops.find(
    (entry) => entry.state === "active" && entry.current_replay_id !== undefined,
  );
  if (loop === undefined || loop.current_replay_id === undefined) {
    return undefined;
  }

  const replay = await store.getFeedbackReplay(runId, loop.current_replay_id);
  if (replay.status !== "active") return undefined;

  const maps = await rebuildLaunchMaps(store, runId, loop, replay, dag);
  feedback.contextsByStageId = maps.contextsByStageId;
  feedback.sessionModeByStageId = maps.sessionModeByStageId;
  feedback.priorAttemptByStageId = maps.priorAttemptByStageId;
  feedback.launchAttemptByStageId = maps.launchAttemptByStageId;
  feedback.activeLoopId = loop.loop_id;
  feedback.activeReplayId = replay.replay_id;
  feedback.sourceStageId = replay.source_stage_id;
  feedback.activeHoldStageIds = new Set(
    postSourceStageIds(dag, replay.source_stage_id),
  );

  feedback.activeCloneIdsByForkParent = new Map();
  const supersededCloneIds = await collectSupersededCloneIdsForRoute({
    store,
    runId,
    dag,
    routeStageIds: replay.route_stage_ids,
  });
  for (const cloneId of supersededCloneIds) {
    const node = dag.nodes.find((n) => n.id === cloneId);
    const forkParentId = node?.needs;
    if (forkParentId !== undefined && forkParentId !== null) {
      feedback.activeCloneIdsByForkParent.set(forkParentId, new Set());
    }
  }
  const gens = await store.listForkGenerations(runId, {
    replayId: replay.replay_id,
  });
  for (const gen of gens) {
    if (gen.status !== "active") continue;
    feedback.activeCloneIdsByForkParent.set(
      gen.fork_parent_stage_id,
      new Set(gen.clone_stage_ids),
    );
  }

  return { loop, replay };
}

export async function rebindFeedbackRoutePassAttempts(
  store: RunStore,
  runId: string,
  replayId: string,
  attemptOverrides: ReadonlyMap<string, number>,
): Promise<void> {
  const passes = await store.listFeedbackReplayStagePasses(runId, replayId);
  const passStages = new Set(passes.map((p) => p.stage_id));
  for (const [stageId, stageAttempt] of attemptOverrides) {
    if (!passStages.has(stageId)) continue;
    await store.updateFeedbackReplayStagePass(runId, replayId, stageId, {
      stage_attempt: stageAttempt,
      status: "pending",
      started_at: null,
      finished_at: null,
      emitted_envelope: null,
    });
  }
}

export async function loadActiveFeedbackLoopContext(
  store: RunStore,
  runId: string,
  stageId: string,
  dag?: ResolvedPipelineDag,
): Promise<FeedbackLoopContext | undefined> {
  const loops = await store.listFeedbackLoops(runId);
  const active = loops
    .filter((l) => l.state === "active" || l.state === "waiting_for_human")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  if (active?.current_replay_id === undefined) return undefined;

  const replay = await store.getFeedbackReplay(runId, active.current_replay_id);
  if (!replay.route_stage_ids.includes(stageId)) return undefined;

  const passes = await store.listFeedbackReplayStagePasses(
    runId,
    replay.replay_id,
  );
  const pass = passes.find((p) => p.stage_id === stageId);
  const fallbackPrior =
    pass !== undefined && pass.stage_attempt > 1
      ? pass.stage_attempt - 1
      : undefined;
  const priorAttempt =
    replay.replay_session === "resume"
      ? await resolveResumeSessionAttempt(
          store,
          runId,
          active.loop_id,
          stageId,
          fallbackPrior,
        )
      : fallbackPrior;

  const ctx = buildContext({
    loop: active,
    replay,
    stageId,
    ...(priorAttempt !== undefined ? { priorAttempt } : {}),
  });
  if (dag === undefined) return ctx;
  const contexts = new Map([[stageId, ctx]]);
  await attachActiveForkContext(store, runId, dag, contexts);
  return contexts.get(stageId);
}
