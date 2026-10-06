import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "../src/runstore/createStore.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";
import type { StageEnvelope } from "../src/types/envelope.js";

const policy: FeedbackLoopConfig = {
  target: "plan",
  max_replays: 2,
  on_max_replays: "require_continue",
  replay_session: "resume",
};

const feedbackEnvelope: StageEnvelope = {
  status: "success",
  summary: "send back",
  artifacts: [],
  feedback_loop: {
    action: "send_back",
    target: "plan",
  },
};

const emitted: StageEnvelope = {
  status: "success",
  summary: "replay pass done",
  artifacts: ["notes.md"],
};

describe("runstore feedback loops (sqlite)", () => {
  it("create/get/list/update feedback loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-loop-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });

    const created = await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
    });
    expect(created.state).toBe("active");
    expect(created.policy).toEqual(policy);
    expect(created.created_at).toBeTruthy();
    expect(created.updated_at).toBeTruthy();

    await expect(store.getFeedbackLoop(run.runId, "loop-1")).resolves.toEqual(
      created,
    );

    const listed = await store.listFeedbackLoops(run.runId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.loop_id).toBe("loop-1");

    await store.updateFeedbackLoop(run.runId, "loop-1", {
      state: "waiting_for_human",
      current_replay_id: "replay-1",
      current_replay_number: 1,
      deferred_send_back: {
        target: "plan",
        feedback_envelope: feedbackEnvelope,
        source_attempt: 2,
      },
    });
    const updated = await store.getFeedbackLoop(run.runId, "loop-1");
    expect(updated.state).toBe("waiting_for_human");
    expect(updated.current_replay_id).toBe("replay-1");
    expect(updated.current_replay_number).toBe(1);
    expect(updated.deferred_send_back).toEqual({
      target: "plan",
      feedback_envelope: feedbackEnvelope,
      source_attempt: 2,
    });
    expect(updated.updated_at >= created.updated_at).toBe(true);

    await store.updateFeedbackLoop(run.runId, "loop-1", {
      deferred_send_back: null,
      policy: { ...policy, max_replays: 3 },
    });
    const cleared = await store.getFeedbackLoop(run.runId, "loop-1");
    expect(cleared.deferred_send_back).toBeUndefined();
    expect(cleared.policy.max_replays).toBe(3);
  });

  it("rejects duplicate replay_number for the same loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-replay-uniq-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
    });

    const base = {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume" as const,
      route_stage_ids: ["plan", "implement", "review"],
      feedback_envelope: feedbackEnvelope,
    };
    await store.createFeedbackReplay(run.runId, {
      ...base,
      replay_id: "replay-1",
    });
    await expect(
      store.createFeedbackReplay(run.runId, {
        ...base,
        replay_id: "replay-dup",
      }),
    ).rejects.toThrow();
  });

  it("stage pass emitted_envelope roundtrip and status update", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-pass-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
    });
    await store.createFeedbackReplay(run.runId, {
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["plan", "implement", "review"],
      feedback_envelope: feedbackEnvelope,
    });

    const pass = await store.createFeedbackReplayStagePass(run.runId, {
      replay_id: "replay-1",
      stage_id: "plan",
      stage_attempt: 2,
      session_origin_attempt: 1,
      session_mode: "resume",
      emitted_envelope: emitted,
    });
    expect(pass.status).toBe("pending");
    expect(pass.session_origin_attempt).toBe(1);
    expect(pass.emitted_envelope).toEqual(emitted);

    await store.updateFeedbackReplayStagePass(run.runId, "replay-1", "plan", {
      status: "succeeded",
      finished_at: "2026-09-05T12:00:00.000Z",
      emitted_envelope: {
        ...emitted,
        summary: "updated summary",
      },
    });
    const listed = await store.listFeedbackReplayStagePasses(
      run.runId,
      "replay-1",
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("succeeded");
    expect(listed[0]?.finished_at).toBe("2026-09-05T12:00:00.000Z");
    expect(listed[0]?.emitted_envelope?.summary).toBe("updated summary");

    await store.updateFeedbackReplayStagePass(run.runId, "replay-1", "plan", {
      stage_attempt: 5,
      status: "pending",
      started_at: null,
      finished_at: null,
      emitted_envelope: null,
    });
    const rebound = await store.listFeedbackReplayStagePasses(
      run.runId,
      "replay-1",
    );
    expect(rebound[0]?.stage_attempt).toBe(5);
    expect(rebound[0]?.session_origin_attempt).toBe(1);
    expect(rebound[0]?.status).toBe("pending");
    expect(rebound[0]?.started_at).toBeUndefined();
    expect(rebound[0]?.finished_at).toBeUndefined();
    expect(rebound[0]?.emitted_envelope).toBeUndefined();
  });

  it("fork generation create/list/filter/update supersede", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-fork-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
    });
    await store.createFeedbackReplay(run.runId, {
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["plan", "implement", "review"],
      feedback_envelope: feedbackEnvelope,
    });

    const initial = await store.createForkGeneration(run.runId, {
      generation_id: "gen-0",
      fork_parent_stage_id: "implement",
      generation_number: 1,
      clone_stage_ids: ["implement#1"],
    });
    expect(initial.status).toBe("active");
    expect(initial.replay_id).toBeUndefined();

    const replayGen = await store.createForkGeneration(run.runId, {
      generation_id: "gen-1",
      replay_id: "replay-1",
      fork_parent_stage_id: "implement",
      generation_number: 2,
      clone_stage_ids: ["implement#2"],
    });
    expect(replayGen.replay_id).toBe("replay-1");

    await store.createForkGeneration(run.runId, {
      generation_id: "gen-other",
      fork_parent_stage_id: "plan",
      generation_number: 1,
      clone_stage_ids: ["plan#1"],
    });

    const all = await store.listForkGenerations(run.runId);
    expect(all).toHaveLength(3);

    const byReplay = await store.listForkGenerations(run.runId, {
      replayId: "replay-1",
    });
    expect(byReplay.map((g) => g.generation_id)).toEqual(["gen-1"]);

    const byParent = await store.listForkGenerations(run.runId, {
      forkParentStageId: "implement",
    });
    expect(byParent.map((g) => g.generation_id)).toEqual(["gen-0", "gen-1"]);

    await store.updateForkGeneration(run.runId, "gen-0", {
      status: "superseded",
    });
    const superseded = (
      await store.listForkGenerations(run.runId, {
        forkParentStageId: "implement",
      })
    ).find((g) => g.generation_id === "gen-0");
    expect(superseded?.status).toBe("superseded");
  });

  it("readRun nests feedback history and active_feedback_loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-read-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
    });
    await store.createFeedbackReplay(run.runId, {
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["plan", "implement", "review"],
      feedback_envelope: feedbackEnvelope,
    });
    await store.createFeedbackReplayStagePass(run.runId, {
      replay_id: "replay-1",
      stage_id: "plan",
      stage_attempt: 2,
      session_mode: "resume",
      emitted_envelope: emitted,
    });
    await store.createForkGeneration(run.runId, {
      generation_id: "gen-0",
      fork_parent_stage_id: "implement",
      generation_number: 1,
      clone_stage_ids: ["implement#1"],
    });
    await store.createForkGeneration(run.runId, {
      generation_id: "gen-1",
      replay_id: "replay-1",
      fork_parent_stage_id: "implement",
      generation_number: 2,
      clone_stage_ids: ["implement#2"],
    });

    const detail = await store.readRun(run.runId);
    expect(detail.active_feedback_loop?.loop_id).toBe("loop-1");
    expect(detail.active_feedback_loop?.state).toBe("active");
    expect(detail.feedback_loops).toHaveLength(1);
    const hist = detail.feedback_loops[0]!;
    expect(hist.loop.loop_id).toBe("loop-1");
    expect(hist.replays).toHaveLength(1);
    expect(hist.replays[0]?.replay.replay_id).toBe("replay-1");
    expect(hist.replays[0]?.stage_passes).toHaveLength(1);
    expect(hist.replays[0]?.stage_passes[0]?.emitted_envelope).toEqual(emitted);
    expect(hist.replays[0]?.fork_generations.map((g) => g.generation_id)).toEqual([
      "gen-1",
    ]);
    expect(hist.fork_generations.map((g) => g.generation_id)).toEqual(["gen-0"]);

    const listed = await store.listRuns();
    expect(listed[0]?.active_feedback_loop?.loop_id).toBe("loop-1");

    await store.updateFeedbackLoop(run.runId, "loop-1", { state: "completed" });
    const after = await store.readRun(run.runId);
    expect(after.active_feedback_loop).toBeUndefined();
    expect(after.feedback_loops[0]?.loop.state).toBe("completed");

    const listedAfter = await store.listRuns();
    expect(listedAfter[0]?.active_feedback_loop).toBeUndefined();
  });

  it("reopens store and reconstructs feedback history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-reopen-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
      state: "waiting_for_human",
    });
    await store.createFeedbackReplay(run.runId, {
      replay_id: "replay-1",
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      target_stage_id: "plan",
      replay_number: 1,
      max_replays: 2,
      replay_session: "resume",
      route_stage_ids: ["plan", "implement", "review"],
      feedback_envelope: feedbackEnvelope,
      status: "waiting_for_human",
    });
    await store.createFeedbackReplayStagePass(run.runId, {
      replay_id: "replay-1",
      stage_id: "implement",
      stage_attempt: 2,
      session_mode: "resume",
      status: "waiting",
      emitted_envelope: emitted,
    });

    const again = createRunStore({ rootDir: root, kind: "sqlite" });
    const detail = await again.readRun(run.runId);
    expect(detail.active_feedback_loop?.state).toBe("waiting_for_human");
    expect(detail.feedback_loops).toHaveLength(1);
    expect(detail.feedback_loops[0]?.replays[0]?.stage_passes[0]?.emitted_envelope).toEqual(
      emitted,
    );
    expect(detail.feedback_loops[0]?.replays[0]?.replay.status).toBe(
      "waiting_for_human",
    );
  });

  it("updateFeedbackLoop CAS only succeeds when expectedState matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-fb-cas-"));
    const store = createRunStore({ rootDir: root, kind: "sqlite" });
    const run = await store.createRun({
      pipelineId: "feedback-loop",
      taskYaml: "id: t\ngoal: g\n",
    });
    await store.createFeedbackLoop(run.runId, {
      loop_id: "loop-1",
      source_stage_id: "review",
      source_attempt: 1,
      policy,
      state: "waiting_for_human",
    });

    const first = await store.updateFeedbackLoop(
      run.runId,
      "loop-1",
      { state: "continued" },
      { expectedState: "waiting_for_human" },
    );
    expect(first).toBe(true);

    const second = await store.updateFeedbackLoop(
      run.runId,
      "loop-1",
      { state: "abandoned" },
      { expectedState: "waiting_for_human" },
    );
    expect(second).toBe(false);

    const loop = await store.getFeedbackLoop(run.runId, "loop-1");
    expect(loop.state).toBe("continued");
  });
});
