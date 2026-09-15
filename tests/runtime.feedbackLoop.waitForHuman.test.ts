import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { projectRun } from "../src/projection/projectRun.js";
import { resolveFeedbackLoopDecision } from "../src/runtime/feedbackLoopDecision.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { RunDetail } from "../src/runstore/port.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "success", summary, artifacts: [], payload: {}, ...extra };
}

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort & {
  openCounts: Map<string, number>;
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  return {
    openCounts,
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const index = stageIndex.get(stageId) ?? 0;
      stageIndex.set(stageId, index + 1);
      const behaviors = behaviorsByStage[stageId] ?? [];
      const behavior = behaviors[index] ?? { type: "never_emit" as const };
      return scriptedFakeAgent([behavior]).openStage(input);
    },
    async runStage(input) {
      const handle = this.openStage(input);
      const event = await handle.next();
      await handle.close();
      if (event.status === "waiting_for_input") {
        return { ok: false, reason: "unexpected wait" };
      }
      return event.result;
    },
  };
}

async function prepareWaitForHumanRun(policyOverrides?: Partial<FeedbackLoopConfig>) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fb-wait-"));
  const store = createRunStore({ rootDir: root });
  const taskYaml = await readFile(SAMPLE_TASK, "utf8");
  const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
  const loaded = await loadPipeline(pipelinePath("feedback-loop"), {
    cwd: fixtures,
  });
  const review = loaded.dag.nodes.find((n) => n.id === "review");
  if (review?.feedback_loop === undefined) {
    throw new Error("expected review feedback_loop policy");
  }
  review.feedback_loop = {
    ...review.feedback_loop,
    max_replays: 1,
    on_max_replays: "wait_for_human",
    ...policyOverrides,
  };
  const run = await store.createRun({
    pipelineId: loaded.pipeline.id,
    taskYaml,
    taskId: task.id,
    pipelineDag: buildPipelineDagSnapshotFromLoaded(loaded),
  });
  return {
    root,
    store,
    task,
    loaded,
    run: { runId: run.runId, workspaceDir: run.workspaceDir },
  };
}

const sendBack = okEnvelope("send-back", {
  feedback_loop: { action: "send_back", target: "implement" },
});

function sourceReviewPass(detail: RunDetail, replayIndex = 0) {
  return detail.feedback_loops?.[0]?.replays[replayIndex]?.stage_passes.find(
    (pass) => pass.stage_id === "review",
  );
}

type LooseStageEvent = { event: string; [key: string]: unknown };

function assertDecidedTrail(
  events: LooseStageEvent[],
  expected: {
    decision: "extend" | "continue" | "abandon";
    loopId: string;
    terminal: "succeeded" | "failed";
    reason?: string;
    omitReason?: boolean;
  },
) {
  const names = events.map((e) => e.event);
  const waitIdx = names.lastIndexOf("waiting_for_input");
  const decidedIdx = names.indexOf("feedback_loop_decided", waitIdx + 1);
  const terminalIdx = names.indexOf(
    expected.terminal,
    decidedIdx === -1 ? waitIdx + 1 : decidedIdx + 1,
  );
  expect(waitIdx).toBeGreaterThanOrEqual(0);
  expect(decidedIdx).toBeGreaterThan(waitIdx);
  expect(terminalIdx).toBeGreaterThan(decidedIdx);
  const decided = events[decidedIdx]!;
  expect(decided.decision).toBe(expected.decision);
  expect(decided.loopId).toBe(expected.loopId);
  if (expected.omitReason) {
    expect(decided).not.toHaveProperty("reason");
  } else if (expected.reason !== undefined) {
    expect(decided.reason).toBe(expected.reason);
  }
  if (expected.terminal === "failed" && expected.reason !== undefined) {
    expect(events[terminalIdx]!.reason).toBe(expected.reason);
  }
}

describe("runtime feedback-loop wait_for_human", () => {
  it("exhausts max_replays and waits without further replay or submit", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "throw", message: "submit must not run" }],
    });

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("waiting");
    expect(agent.openCounts.get("implement")).toBe(2);
    expect(agent.openCounts.get("review")).toBe(2);
    expect(agent.openCounts.get("submit") ?? 0).toBe(0);

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.active_feedback_loop?.state).toBe("waiting_for_human");
    expect(detail.active_feedback_loop?.deferred_send_back?.target).toBe(
      "implement",
    );
    expect(detail.waiting_stage_id).toBe("review");
    expect(detail.waiting_kind).toBe("feedback_loop_decision");
    const review = detail.stages.find((s) => s.stage_id === "review");
    expect(review?.status).toBe("waiting_for_input");
    expect(detail.feedback_loops?.[0]?.replays).toHaveLength(1);
    expect(detail.feedback_loops?.[0]?.replays[0]?.replay.status).toBe(
      "waiting_for_human",
    );
    const sourcePass = sourceReviewPass(detail);
    expect(sourcePass?.status).toBe("waiting");
    expect(sourcePass?.finished_at).toBeUndefined();
  });

  it("extend raises max by one, schedules another replay, then continue succeeds", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
        { type: "emit", envelope: okEnvelope("implement-3") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
        {
          type: "emit",
          envelope: okEnvelope("continue", {
            feedback_loop: { action: "continue" },
          }),
        },
      ],
      submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
    });

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      onFeedbackLoopWaiting: async ({ resolve }) => {
        const decided = await resolve({
          decision: "extend",
          reason: "one more replay",
        });
        expect(decided.ok).toBe(true);
        if (decided.ok) expect(decided.effect).toBe("extended");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("implement")).toBe(3);
    expect(agent.openCounts.get("review")).toBe(3);
    expect(agent.openCounts.get("submit")).toBe(1);

    const detail = await prepared.store.readRun(prepared.run.runId);
    const history = detail.feedback_loops![0]!;
    expect(history.loop.state).toBe("continued");
    expect(history.loop.policy.max_replays).toBe(2);
    expect(history.replays).toHaveLength(2);
    const replay1Source = sourceReviewPass(detail, 0);
    expect(replay1Source?.status).not.toBe("waiting");
    expect(replay1Source?.status).not.toBe("running");
    const events = await prepared.store.listStageEvents(
      prepared.run.runId,
      "review",
    );
    assertDecidedTrail(events, {
      decision: "extend",
      loopId: history.loop.loop_id,
      terminal: "succeeded",
      reason: "one more replay",
    });
  });

  it("continue decision releases downstream without another replay", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
    });

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      onFeedbackLoopWaiting: async ({ resolve }) => {
        const decided = await resolve({ decision: "continue" });
        expect(decided.ok).toBe(true);
        if (decided.ok) expect(decided.effect).toBe("continued");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("implement")).toBe(2);
    expect(agent.openCounts.get("review")).toBe(2);
    expect(agent.openCounts.get("submit")).toBe(1);

    const detail = await prepared.store.readRun(prepared.run.runId);
    const history = detail.feedback_loops![0]!;
    expect(history.loop.state).toBe("continued");
    expect(history.loop.deferred_send_back?.target).toBe("implement");
    expect(history.replays).toHaveLength(1);
    expect(history.replays[0]?.replay.status).toBe("completed");
    const review = detail.stages.find((s) => s.stage_id === "review");
    expect(review?.status).toBe("succeeded");
    const sourcePass = sourceReviewPass(detail);
    expect(sourcePass?.status).toBe("succeeded");
    expect(sourcePass?.finished_at).toBeTruthy();
    expect(sourcePass?.emitted_envelope).toEqual(
      history.loop.deferred_send_back?.feedback_envelope,
    );
    const projectedPass = projectRun(detail)
      .feedback_loops[0]
      ?.replays[0]
      ?.stage_passes.find((pass) => pass.stage_id === "review");
    expect(projectedPass?.status).toBe("succeeded");
    expect(projectedPass?.finished_at).toBeTruthy();
    const events = await prepared.store.listStageEvents(
      prepared.run.runId,
      "review",
    );
    assertDecidedTrail(events, {
      decision: "continue",
      loopId: history.loop.loop_id,
      terminal: "succeeded",
      omitReason: true,
    });
  });

  it("abandon decision fails the run", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "throw", message: "submit must not run" }],
    });

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
      onFeedbackLoopWaiting: async ({ resolve }) => {
        const decided = await resolve({
          decision: "abandon",
          reason: "operator abandoned loop",
        });
        expect(decided.ok).toBe(true);
        if (decided.ok) expect(decided.effect).toBe("abandoned");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/abandoned/i);
    expect(agent.openCounts.get("submit") ?? 0).toBe(0);

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.status).toBe("failed");
    expect(detail.feedback_loops![0]!.loop.state).toBe("abandoned");
    expect(detail.feedback_loops![0]!.replays[0]?.replay.status).toBe("failed");
    const review = detail.stages.find((s) => s.stage_id === "review");
    expect(review?.status).toBe("failed");
    const sourcePass = sourceReviewPass(detail);
    expect(sourcePass?.status).toBe("failed");
    expect(sourcePass?.finished_at).toBeTruthy();
    const events = await prepared.store.listStageEvents(
      prepared.run.runId,
      "review",
    );
    assertDecidedTrail(events, {
      decision: "abandon",
      loopId: detail.feedback_loops![0]!.loop.loop_id,
      terminal: "failed",
      reason: "operator abandoned loop",
    });
  });

  it("require_continue still fails closed at the limit", async () => {
    const prepared = await prepareWaitForHumanRun({
      max_replays: 1,
      on_max_replays: "require_continue",
    });
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "throw", message: "submit must not run" }],
    });

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.reason).toMatch(/max_replays/);
    expect(agent.openCounts.get("submit") ?? 0).toBe(0);

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.active_feedback_loop).toBeUndefined();
    expect(detail.feedback_loops![0]!.loop.state).toBe("completed");
    expect(detail.feedback_loops![0]!.replays[0]?.replay.status).toBe("failed");
  });

  it("continue vs extend CAS: second decide loses", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "throw", message: "submit must not run" }],
    });

    const waiting = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(waiting.outcome).toBe("waiting");

    const parked = await prepared.store.readRun(prepared.run.runId);
    const loopId = parked.active_feedback_loop?.loop_id;
    expect(loopId).toBeTruthy();

    const storeA = prepared.store;
    const storeB = createRunStore({ rootDir: prepared.root });

    const [first, second] = await Promise.all([
      resolveFeedbackLoopDecision({
        store: storeA,
        runId: prepared.run.runId,
        loopId,
        decision: "continue",
      }),
      resolveFeedbackLoopDecision({
        store: storeB,
        runId: prepared.run.runId,
        loopId,
        decision: "extend",
      }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok).length).toBe(1);
    const loser = outcomes.find((r) => !r.ok);
    expect(loser).toBeDefined();
    if (loser !== undefined && !loser.ok) {
      expect(loser.reason).toMatch(
        /conflict|no longer waiting|not waiting_for_human/i,
      );
    }

    const detail = await storeB.readRun(prepared.run.runId);
    const loopState = detail.feedback_loops![0]!.loop.state;
    const events = await storeB.listStageEvents(prepared.run.runId, "review");
    const decidedEvents = events.filter(
      (e) => e.event === "feedback_loop_decided",
    );
    expect(decidedEvents).toHaveLength(1);
    if (first.ok && first.effect === "continued") {
      expect(loopState).toBe("continued");
      expect(detail.active_feedback_loop).toBeUndefined();
      expect(decidedEvents[0]).toMatchObject({
        decision: "continue",
        loopId,
      });
      expect(decidedEvents[0]).not.toHaveProperty("reason");
    } else {
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.effect).toBe("extended");
      expect(loopState).toBe("active");
      expect(detail.active_feedback_loop?.state).toBe("active");
      expect(decidedEvents[0]).toMatchObject({
        decision: "extend",
        loopId,
      });
    }
  });

  it("resolveFeedbackLoopDecision continue works after scheduler exits waiting", async () => {
    const prepared = await prepareWaitForHumanRun();
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        { type: "emit", envelope: sendBack },
        { type: "emit", envelope: sendBack },
      ],
      submit: [{ type: "throw", message: "submit must not run while waiting" }],
    });

    const waiting = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });
    expect(waiting.outcome).toBe("waiting");

    const decided = await resolveFeedbackLoopDecision({
      store: prepared.store,
      runId: prepared.run.runId,
      decision: "continue",
      reason: "ship the brief",
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.effect).toBe("continued");

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.active_feedback_loop).toBeUndefined();
    expect(detail.feedback_loops![0]!.loop.state).toBe("continued");
    expect(detail.stages.find((s) => s.stage_id === "review")?.status).toBe(
      "succeeded",
    );
    const history = detail.feedback_loops![0]!;
    const sourcePass = sourceReviewPass(detail);
    expect(sourcePass?.status).toBe("succeeded");
    expect(sourcePass?.finished_at).toBeTruthy();
    expect(sourcePass?.emitted_envelope).toEqual(
      history.loop.deferred_send_back?.feedback_envelope,
    );
    const events = await prepared.store.listStageEvents(
      prepared.run.runId,
      "review",
    );
    assertDecidedTrail(events, {
      decision: "continue",
      loopId: history.loop.loop_id,
      terminal: "succeeded",
      reason: "ship the brief",
    });
  });
});
