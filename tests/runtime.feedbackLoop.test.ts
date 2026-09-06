import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import type { AgentPort, StageRunInput } from "../src/agent/port.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadTaskFromYaml } from "../src/config/loadTask.js";
import { runPipelineDag } from "../src/runtime/pipelineScheduler.js";
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
  feedbackContexts: Map<string, number>;
} {
  const openCounts = new Map<string, number>();
  const stageIndex = new Map<string, number>();
  const sessionModes = new Map<string, Array<string | undefined>>();
  const feedbackContexts = new Map<string, number>();
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
        feedbackContexts.set(
          stageId,
          (feedbackContexts.get(stageId) ?? 0) + 1,
        );
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

async function prepareFeedbackLoopRun() {
  const root = await mkdtemp(path.join(tmpdir(), "sf-fb-sched-"));
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

describe("runtime feedback-loop scheduler", () => {
  it("send_back replays implement→review and holds submit until continue", async () => {
    const prepared = await prepareFeedbackLoopRun();
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
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(agent.openCounts.get("plan")).toBe(1);
    expect(agent.openCounts.get("implement")).toBe(2);
    expect(agent.openCounts.get("review")).toBe(2);
    expect(agent.openCounts.get("submit")).toBe(1);
    expect(agent.sessionModes.get("implement")?.[1]).toBe("feedback_resume");
    expect(agent.sessionModes.get("review")?.[1]).toBe("feedback_resume");
    expect(agent.feedbackContexts.get("implement")).toBe(1);
    expect(agent.feedbackContexts.get("review")).toBe(1);

    const detail = await prepared.store.readRun(prepared.run.runId);
    expect(detail.feedback_loops).toHaveLength(1);
    const history = detail.feedback_loops![0]!;
    expect(history.loop.state).toBe("continued");
    expect(history.replays).toHaveLength(1);
    expect(history.replays[0]!.replay.route_stage_ids).toEqual([
      "implement",
      "review",
    ]);
    expect(history.replays[0]!.stage_passes.map((p) => p.stage_id).sort()).toEqual(
      ["implement", "review"],
    );
  });

  it("after continue, submit runs only once review has continued", async () => {
    const prepared = await prepareFeedbackLoopRun();
    let submitOpenedWhileHeld = false;
    const base = stageKeyedAgent({
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
        {
          type: "emit",
          envelope: okEnvelope("continue", {
            feedback_loop: { action: "continue" },
          }),
        },
      ],
      submit: [{ type: "emit", envelope: okEnvelope("submit-ok") }],
    });
    const agent: AgentPort = {
      openStage(input) {
        if (
          input.stage.id === "submit" &&
          (base.openCounts.get("review") ?? 0) < 2
        ) {
          submitOpenedWhileHeld = true;
        }
        return base.openStage(input);
      },
      runStage: (input) => base.runStage(input),
    };

    const result = await runPipelineDag({
      prepared: {
        ...prepared,
        agent,
        cwd: fixtures,
      },
      maxActiveStagesPerRun: 4,
      executionMode: "inprocess",
    });

    expect(result.ok).toBe(true);
    expect(submitOpenedWhileHeld).toBe(false);
    expect(base.openCounts.get("submit")).toBe(1);
  });

  it("max_replays exceeded with require_continue fails closed", async () => {
    const prepared = await prepareFeedbackLoopRun();
    const sendBack = okEnvelope("send-back", {
      feedback_loop: { action: "send_back", target: "implement" },
    });
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
    expect(agent.openCounts.get("implement")).toBe(3);
    expect(agent.openCounts.get("review")).toBe(3);
    expect(agent.openCounts.get("submit") ?? 0).toBe(0);

    const detail = await prepared.store.readRun(prepared.run.runId);
    const history = detail.feedback_loops![0]!;
    expect(history.replays).toHaveLength(2);
  });

  it("duplicate send_back for the same source pass is idempotent", async () => {
    const prepared = await prepareFeedbackLoopRun();
    const sendBack = okEnvelope("send-back", {
      feedback_loop: { action: "send_back", target: "implement" },
    });
    const { acceptFeedbackSendBack } = await import(
      "../src/runtime/feedbackLoopCoordinator.js"
    );
    const loaded = prepared.loaded;
    const reviewNode = loaded.dag.nodes.find((n) => n.id === "review")!;

    await prepared.store.createStageExecution(prepared.run.runId, "plan");
    await prepared.store.createStageExecution(prepared.run.runId, "implement");
    await prepared.store.createStageExecution(prepared.run.runId, "review");

    const first = await acceptFeedbackSendBack({
      store: prepared.store,
      runId: prepared.run.runId,
      dag: loaded.dag,
      sourceNode: reviewNode,
      sourceAttempt: 1,
      envelope: sendBack,
    });
    expect(first.kind).toBe("accepted");

    const second = await acceptFeedbackSendBack({
      store: prepared.store,
      runId: prepared.run.runId,
      dag: loaded.dag,
      sourceNode: reviewNode,
      sourceAttempt: 1,
      envelope: sendBack,
    });
    expect(second.kind).toBe("idempotent");
    if (first.kind === "accepted" && second.kind === "idempotent") {
      expect(second.replay.replay_id).toBe(first.replay.replay_id);
    }

    const replays = await prepared.store.listFeedbackReplays(
      prepared.run.runId,
      first.kind === "rejected" ? "" : first.loop.loop_id,
    );
    expect(replays).toHaveLength(1);
  });

  it("resume send_back keeps prior_stage_attempt on session-origin attempt", async () => {
    const prepared = await prepareFeedbackLoopRun();
    const sendBack = okEnvelope("send-back", {
      feedback_loop: { action: "send_back", target: "implement" },
    });
    const { acceptFeedbackSendBack, loadActiveFeedbackLoopContext } =
      await import("../src/runtime/feedbackLoopCoordinator.js");
    const loaded = prepared.loaded;
    const reviewNode = loaded.dag.nodes.find((n) => n.id === "review")!;

    await prepared.store.createStageExecution(prepared.run.runId, "plan");
    await prepared.store.createStageExecution(prepared.run.runId, "implement");
    await prepared.store.createStageExecution(prepared.run.runId, "review");

    const first = await acceptFeedbackSendBack({
      store: prepared.store,
      runId: prepared.run.runId,
      dag: loaded.dag,
      sourceNode: reviewNode,
      sourceAttempt: 1,
      envelope: sendBack,
    });
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    expect(first.launch.priorAttemptByStageId.get("implement")).toBe(1);
    expect(first.launch.launchAttemptByStageId.get("implement")).toBe(2);

    const second = await acceptFeedbackSendBack({
      store: prepared.store,
      runId: prepared.run.runId,
      dag: loaded.dag,
      sourceNode: reviewNode,
      sourceAttempt: 2,
      envelope: sendBack,
    });
    expect(second.kind).toBe("accepted");
    if (second.kind !== "accepted") return;
    expect(second.launch.priorAttemptByStageId.get("implement")).toBe(1);
    expect(second.launch.launchAttemptByStageId.get("implement")).toBe(3);

    const ctx = await loadActiveFeedbackLoopContext(
      prepared.store,
      prepared.run.runId,
      "implement",
      loaded.dag,
    );
    expect(ctx?.prior_stage_attempt).toBe(1);
  });
});
