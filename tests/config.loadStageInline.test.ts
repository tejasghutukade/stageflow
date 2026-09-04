import { describe, expect, it } from "vitest";
import { loadStageFromObjectOutcome } from "../src/config/loadStage.js";

describe("loadStageFromObjectOutcome", () => {
  it("loads valid inline object", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.id).toBe("inline");
    expect(outcome.value.system_prompt).toBe("Do work");
  });

  it("rejects missing model", () => {
    const outcome = loadStageFromObjectOutcome(
      { system_prompt: "Do work" },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_shape");
  });

  it("rejects invalid gate_kinds", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        gate_kinds: ["not_a_kind"],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_gate_kinds");
  });

  it("rejects invalid payload_schema", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        payload_schema: { type: "not-a-valid-type" },
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_payload_schema");
  });

  it("rejects invalid clone_input_schema", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        clone_input_schema: { type: "not-a-valid-type" },
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_clone_input_schema");
  });

  it("rejects empty clone_actions", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        clone_actions: [],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_clone_actions");
  });
});
