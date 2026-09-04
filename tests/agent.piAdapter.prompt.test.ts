import { describe, expect, it } from "vitest";
import { cursorProviderSupport } from "../src/agent/cursorProvider.js";
import { composeStageUserPrompt } from "../src/agent/piAdapter.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import type { CloneEmitContext } from "../src/types/forkChoice.js";

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
});
