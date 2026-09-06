import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type {
  AgentPort,
  FeedbackLoopContext,
  StageRunInput,
} from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import {
  createFeedbackScheduleState,
} from "../src/runtime/feedbackLoopSchedule.js";
import { hydrateActiveFeedbackScheduleFromStore } from "../src/runtime/feedbackLoopCoordinator.js";
import { RunManager } from "../src/runtime/runManager.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { buildPipelineDagSnapshotFromLoaded } from "../src/runstore/pipelineDagSnapshot.js";
import type { StageEnvelope } from "../src/types/envelope.js";
import { pipelinePath, SAMPLE_TASK } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

function okEnvelope(
  summary: string,
  extra?: Partial<StageEnvelope>,
): StageEnvelope {
  return { status: "success", summary, artifacts: [], ...extra };
}

type FakeAgentBehavior =
  | { type: "emit"; envelope: StageEnvelope }
  | { type: "never_emit" }
  | { type: "throw"; message: string };

function stageKeyedAgent(
  behaviorsByStage: Record<string, FakeAgentBehavior[]>,
): AgentPort & {
  openCounts: Map<string, number>;
  sessionModes: Map<string, Array<string | undefined>>;
  feedbackContexts: Map<string, FeedbackLoopContext[]>;
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const sessionModes = new Map<string, Array<string | undefined>>();
  const feedbackContexts = new Map<string, FeedbackLoopContext[]>();
  return {
    openCounts,
    sessionModes,
    feedbackContexts,
    openStage(input: StageRunInput) {
      const stageId = input.stage.id;
      openCounts.set(stageId, (openCounts.get(stageId) ?? 0) + 1);
      const modes = sessionModes.get(stageId) ?? [];
      modes.push(input.sessionMode);
      sessionModes.set(stageId, modes);
      if (input.feedbackLoopContext !== undefined) {
        const contexts = feedbackContexts.get(stageId) ?? [];
        contexts.push(input.feedbackLoopContext);
        feedbackContexts.set(stageId, contexts);
      }
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

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

async function prepareFeedbackLoopRun() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fb-retry-"));
  const store = createRunStore({ rootDir: root });
  const taskYaml = await readFile(SAMPLE_TASK, "utf8");
  const task = loadTaskFromYaml(taskYaml, SAMPLE_TASK);
  const loaded = await loadPipeline(pipelinePath("feedback-loop"), {
    cwd: fixtures,
  });
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

describe("feedback-aware stage retry", () => {
  it("hydrateActiveFeedbackScheduleFromStore restores holds and session modes", async () => {
    const prepared = await prepareFeedbackLoopRun();
    const sendBack = okEnvelope("send-back", {
      feedback_loop: { action: "send_back", target: "implement" },
    });
    const { acceptFeedbackSendBack } = await import(
      "../src/runtime/feedbackLoopCoordinator.js"
    );
    const reviewNode = prepared.loaded.dag.nodes.find((n) => n.id === "review")!;

    await prepared.store.createStageExecution(prepared.run.runId, "plan");
    await prepared.store.createStageExecution(prepared.run.runId, "implement");
    await prepared.store.createStageExecution(prepared.run.runId, "review");

    const accepted = await acceptFeedbackSendBack({
      store: prepared.store,
      runId: prepared.run.runId,
      dag: prepared.loaded.dag,
      sourceNode: reviewNode,
      sourceAttempt: 1,
      envelope: sendBack,
    });
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") return;

    const feedback = createFeedbackScheduleState();
    const hydrated = await hydrateActiveFeedbackScheduleFromStore(
      prepared.store,
      prepared.run.runId,
      prepared.loaded.dag,
      feedback,
    );
    expect(hydrated).toBeDefined();
    expect(hydrated?.replay.replay_id).toBe(accepted.replay.replay_id);
    expect(feedback.activeReplayId).toBe(accepted.replay.replay_id);
    expect(feedback.activeHoldStageIds.has("submit")).toBe(true);
    expect(feedback.sessionModeByStageId.get("implement")).toBe(
      "feedback_resume",
    );
    expect(feedback.sessionModeByStageId.get("review")).toBe("feedback_resume");
    expect(feedback.contextsByStageId.get("implement")?.replay_number).toBe(1);
    expect(feedback.launchAttemptByStageId.get("implement")).toBe(
      accepted.launch.launchAttemptByStageId.get("implement"),
    );
  });

  it("hydrate returns undefined when no active loop", async () => {
    const prepared = await prepareFeedbackLoopRun();
    const feedback = createFeedbackScheduleState();
    const hydrated = await hydrateActiveFeedbackScheduleFromStore(
      prepared.store,
      prepared.run.runId,
      prepared.loaded.dag,
      feedback,
    );
    expect(hydrated).toBeUndefined();
    expect(feedback.activeReplayId).toBeUndefined();
    expect(feedback.activeHoldStageIds.size).toBe(0);
  });

  it("mid-route fail + retry keeps the same replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-retry-e2e-"));
    const store = createRunStore({ rootDir: root });
    const agent = stageKeyedAgent({
      plan: [{ type: "emit", envelope: okEnvelope("plan-ok") }],
      implement: [
        { type: "emit", envelope: okEnvelope("implement-1") },
        { type: "emit", envelope: okEnvelope("implement-2") },
      ],
      review: [
        {
          type: "emit",
          envelope: okEnvelope("send-back", {
            feedback_loop: { action: "send_back", target: "implement" },
          }),
        },
        { type: "throw", message: "review-replay-boom" },
        {
          type: "emit",
          envelope: okEnvelope("continue", {
            feedback_loop: { action: "continue" },
          }),
        },
      ],
      submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
    });

    const manager = new RunManager({ agent, store, cwd: fixtures });
    const started = await manager.startRun({
      task: SAMPLE_TASK,
      pipeline: pipelinePath("feedback-loop"),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "failed";
    });

    const beforeRetry = await store.readRun(started.runId);
    expect(beforeRetry.feedback_loops).toHaveLength(1);
    const historyBefore = beforeRetry.feedback_loops![0]!;
    expect(historyBefore.loop.state).toBe("active");
    expect(historyBefore.replays).toHaveLength(1);
    const replayBefore = historyBefore.replays[0]!.replay;
    expect(replayBefore.status).toBe("active");
    expect(replayBefore.replay_number).toBe(1);

    const reviewPassBefore = historyBefore.replays[0]!.stage_passes.find(
      (p) => p.stage_id === "review",
    );
    expect(reviewPassBefore?.status).toBe("failed");

    const replayOpen = agent.feedbackContexts.get("review")?.[0];
    expect(replayOpen?.replay_number).toBe(1);
    expect(replayOpen?.replay_id).toBe(replayBefore.replay_id);
    expect(agent.sessionModes.get("review")?.[1]).toBe("feedback_resume");

    const retry = await manager.retryStage(started.runId, "review");
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    await waitFor(async () => {
      const meta = await store.readRunMeta(started.runId);
      return meta.status === "succeeded";
    });

    expect(agent.openCounts.get("review")).toBe(3);
    expect(agent.sessionModes.get("review")?.[2]).toBe("feedback_resume");
    const retryOpen = agent.feedbackContexts.get("review")?.[1];
    expect(retryOpen?.replay_number).toBe(1);
    expect(retryOpen?.replay_id).toBe(replayBefore.replay_id);
    expect(retryOpen?.is_final_replay).toBe(replayOpen?.is_final_replay);

    const after = await store.readRun(started.runId);
    expect(after.feedback_loops).toHaveLength(1);
    const historyAfter = after.feedback_loops![0]!;
    expect(historyAfter.replays).toHaveLength(1);
    expect(historyAfter.replays[0]!.replay.replay_id).toBe(
      replayBefore.replay_id,
    );
    expect(historyAfter.loop.state).toBe("continued");
    expect(agent.openCounts.get("submit")).toBe(1);
  });
});
