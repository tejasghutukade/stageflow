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

  it("loads a gate + artifact_declared pre_emit_checks list", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [
          { id: "plan-approved", type: "gate", kind: "artifact_backed" },
          {
            id: "plan-artifact-present",
            type: "artifact_declared",
            basename: "implementation-plan.md",
          },
        ],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pre_emit_checks).toEqual([
      { id: "plan-approved", type: "gate", kind: "artifact_backed" },
      {
        id: "plan-artifact-present",
        type: "artifact_declared",
        basename: "implementation-plan.md",
      },
    ]);
  });

  it("omits pre_emit_checks when not declared", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pre_emit_checks).toBeUndefined();
  });

  it("rejects an empty pre_emit_checks array", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_pre_emit_checks");
  });

  it("rejects an unsupported pre_emit_checks type", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [{ id: "x", type: "artifact", path: "plan.md" }],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_pre_emit_checks");
  });

  it("rejects a gate check with an invalid kind", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [{ id: "x", type: "gate", kind: "not_a_kind" }],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_pre_emit_checks");
  });

  it("rejects an artifact_declared check with an empty basename", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [
          { id: "x", type: "artifact_declared", basename: "" },
        ],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_pre_emit_checks");
  });

  it("rejects duplicate ids across pre_emit_checks entries", () => {
    const outcome = loadStageFromObjectOutcome(
      {
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        pre_emit_checks: [
          { id: "dup", type: "gate", kind: "confirm" },
          { id: "dup", type: "artifact_declared", basename: "plan.md" },
        ],
      },
      { entryId: "inline", declaringPath: "/tmp/pipeline.yaml" },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_pre_emit_checks");
  });
});
