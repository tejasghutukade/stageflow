import { describe, expect, it } from "vitest";
import { cursorProviderSupport } from "../src/agent/cursorProvider.js";
import type { FeedbackLoopContext } from "../src/agent/port.js";
import {
  composeFeedbackResumePrompt,
  composeStageUserPrompt,
} from "../src/agent/piAdapter.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { CloneEmitContext } from "../src/types/forkChoice.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";

const CLONE_FORESIGHT =
  'Each once or fanout envelope is a full StageEnvelope — it requires status ("success" or "failure"), summary (non-empty string), and artifacts (array of strings). clone_input_schema fields belong in envelope.payload, not at the top level of the clone_forks item.';

const AREA_ASSIGNMENT_SCHEMA = {
  type: "object",
  properties: {
    area_id: { type: "string" },
    objective: { type: "string" },
  },
  required: ["area_id", "objective"],
};

function baseInput(cloneEmitContext?: CloneEmitContext) {
  return {
    roots: buildStageRoots("/tmp/run-ws", "oss-plan-investigation"),
    stage: {
      id: "oss-plan-investigation",
      system_prompt: "plan",
      model: "anthropic/claude-sonnet-4-5",
    },
    task: { id: "t", goal: "plan investigation" },
    priorEnvelope: null,
    ...(cloneEmitContext !== undefined ? { cloneEmitContext } : {}),
  };
}

function makeCloneContext(): CloneEmitContext {
  return {
    clonableSuccessors: [
      {
        successorId: "oss-investigate-area",
        cloneCap: 4,
        cloneInputSchema: AREA_ASSIGNMENT_SCHEMA,
      },
    ],
    allowedActions: ["once", "fanout"],
  };
}

const feedbackLoopPolicy: FeedbackLoopConfig = {
  target: "plan",
  max_replays: 2,
  on_max_replays: "require_continue",
  replay_session: "resume",
};

function makeFeedbackLoopContext(
  overrides?: Partial<FeedbackLoopContext>,
): FeedbackLoopContext {
  return {
    loop_id: "loop-1",
    replay_id: "replay-1",
    source_stage_id: "review",
    target_stage_id: "plan",
    feedback_envelope: {
      status: "success",
      summary: "Please tighten the acceptance criteria",
      artifacts: ["stages/review/attempts/1/artifacts/notes.md"],
      feedback_loop: { action: "send_back", target: "plan" },
    },
    replay_number: 1,
    max_replays: 2,
    remaining_replays: 1,
    is_final_replay: false,
    replay_session: "resume",
    route_stage_ids: ["plan", "implement", "review"],
    ...overrides,
  };
}

describe("composeStageUserPrompt - clone envelope foresight (U3)", () => {
  it("cloneEmitContext present → foresight names full StageEnvelope fields and envelope.payload", () => {
    const prompt = composeStageUserPrompt(
      baseInput(makeCloneContext()),
      "emit_stage_envelope",
    );
    expect(prompt).toContain("full StageEnvelope");
    expect(prompt).toContain("status");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("artifacts");
    expect(prompt).toContain("envelope.payload");
    expect(prompt).toContain(CLONE_FORESIGHT);
  });

  it("Cursor emitToolHint override still appends clone foresight", () => {
    const prompt = composeStageUserPrompt(
      baseInput(makeCloneContext()),
      "emit_stage_envelope",
      cursorProviderSupport.emitToolHint!("emit_stage_envelope"),
    );
    expect(prompt).toContain("pi__emit_stage_envelope");
    expect(prompt).toContain("Clonable successors");
    expect(prompt).toContain(CLONE_FORESIGHT);
    expect(prompt).toContain("envelope.payload");
  });

  it("cloneEmitContext absent → foresight sentence absent", () => {
    const prompt = composeStageUserPrompt(
      baseInput(),
      "emit_stage_envelope",
    );
    expect(prompt).not.toContain("full StageEnvelope");
    expect(prompt).not.toContain("envelope.payload");
    expect(prompt).not.toContain(CLONE_FORESIGHT);
    expect(prompt).not.toContain("Clonable successors");
  });

  it("feedback-loop sources are instructed to emit an action and their allowed targets", () => {
    const prompt = composeStageUserPrompt(
      { ...baseInput(), feedbackLoopEmitContext: feedbackLoopPolicy },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("feedback_loop is required");
    expect(prompt).toContain("Allowed send_back target: plan");
    expect(prompt).toContain("cannot be combined with fork_choice or clone_forks");
  });

  it("feedbackLoopContext present → labelled Feedback Loop Context section", () => {
    const ctx = makeFeedbackLoopContext({ is_final_replay: true, remaining_replays: 0 });
    const prompt = composeStageUserPrompt(
      {
        ...baseInput(),
        sessionMode: "feedback_resume",
        feedbackLoopContext: ctx,
      },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("Feedback Loop Context");
    expect(prompt).toContain("Session mode: feedback_resume (continuing the prior agent session)");
    expect(prompt).toContain("loop-1");
    expect(prompt).toContain("replay-1");
    expect(prompt).toContain('"is_final_replay": true');
    expect(prompt).toContain("Please tighten the acceptance criteria");
    const priorIdx = prompt.indexOf("No prior envelope");
    const feedbackIdx = prompt.indexOf("Feedback Loop Context");
    const artifactIdx = prompt.indexOf("Create factory stage artifacts");
    expect(priorIdx).toBeGreaterThanOrEqual(0);
    expect(feedbackIdx).toBeGreaterThan(priorIdx);
    expect(artifactIdx).toBeGreaterThan(feedbackIdx);
  });

  it("feedbackLoopContext with new_session names session mode", () => {
    const ctx = makeFeedbackLoopContext({ replay_session: "new_session" });
    const prompt = composeStageUserPrompt(
      {
        ...baseInput(),
        sessionMode: "new_session",
        feedbackLoopContext: ctx,
      },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("Session mode: new_session (starting a fresh agent session)");
  });

  it("feedbackLoopContext absent → no Feedback Loop Context heading", () => {
    const prompt = composeStageUserPrompt(baseInput(), "emit_stage_envelope");
    expect(prompt).not.toContain("Feedback Loop Context");
  });

  it("source on replay gets both emit policy hints and Feedback Loop Context", () => {
    const prompt = composeStageUserPrompt(
      {
        ...baseInput(),
        feedbackLoopEmitContext: feedbackLoopPolicy,
        feedbackLoopContext: makeFeedbackLoopContext(),
      },
      "emit_stage_envelope",
    );
    expect(prompt).toContain("feedback_loop is required");
    expect(prompt).toContain("Allowed send_back target: plan");
    expect(prompt).toContain("Feedback Loop Context");
    expect(prompt).toContain("Please tighten the acceptance criteria");
  });
});

describe("composeFeedbackResumePrompt", () => {
  it("includes labelled Feedback Loop Context for feedback_resume", () => {
    const ctx = makeFeedbackLoopContext();
    const prompt = composeFeedbackResumePrompt({
      ...baseInput(),
      sessionMode: "feedback_resume",
      feedbackLoopContext: ctx,
    });
    expect(prompt).toContain("Continue this stage after feedback-loop send-back");
    expect(prompt).toContain("Feedback Loop Context");
    expect(prompt).toContain("Session mode: feedback_resume (continuing the prior agent session)");
    expect(prompt).toContain("loop-1");
    expect(prompt).toContain("Please tighten the acceptance criteria");
  });

  it("fails closed when feedbackLoopContext is missing", () => {
    expect(() => composeFeedbackResumePrompt(baseInput())).toThrow(
      /feedback_resume requires feedbackLoopContext/,
    );
  });
});
