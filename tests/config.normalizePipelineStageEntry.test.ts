import { describe, expect, it } from "vitest";
import {
  inferIdFromUsesPath,
  normalizePipelineStageEntries,
  toWiringRefs,
} from "../src/config/normalizePipelineStageEntry.js";

const ctx = { pipelineId: "test", path: "/tmp/test.pipeline.yaml" };

describe("normalizePipelineStageEntries", () => {
  it("infers id decide from uses path only", () => {
    const outcome = normalizePipelineStageEntries(
      [{ raw: { uses: "./decide.yaml" }, declaringPath: "/catalog/pipeline.yaml" }],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.id).toBe("decide");
  });

  it("infers id gate from .stage.yaml basename", () => {
    const outcome = normalizePipelineStageEntries(
      [{ raw: { uses: "./gate.stage.yaml" }, declaringPath: "/catalog/pipeline.yaml" }],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.id).toBe("gate");
  });

  it("rejects uses and inline body conflict", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            uses: "./x.yaml",
            system_prompt: "prompt",
            model: "m",
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.stage_uses_inline_conflict");
  });

  it("rejects wiring-only entry", () => {
    const outcome = normalizePipelineStageEntries(
      [{ raw: { id: "orphan", needs: "decide" }, declaringPath: "/tmp/pipeline.yaml" }],
      ctx,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.stage_missing_body");
  });

  it("rejects unknown keys", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            label: "bad",
            system_prompt: "p",
            model: "m",
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_shape");
    expect(outcome.issues[0]?.message).toMatch(/unknown key "label"/);
  });

  it("accepts clonable and clone_cap on an object entry", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "author",
            clonable: true,
            clone_cap: 3,
            system_prompt: "p",
            model: "m",
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.clonable).toBe(true);
    expect(outcome.value[0]?.clone_cap).toBe(3);
  });

  it("toWiringRefs copies clonable and clone_cap when present", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "author",
            clonable: true,
            clone_cap: 3,
            system_prompt: "p",
            model: "m",
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(toWiringRefs(outcome.value)).toEqual([
      { id: "author", clonable: true, clone_cap: 3 },
    ]);
  });

  it("omits clonable fields from wiring refs when absent", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: { id: "clarify", system_prompt: "p", model: "m" },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(toWiringRefs(outcome.value)).toEqual([{ id: "clarify" }]);
    expect(outcome.value[0]?.clonable).toBeUndefined();
    expect(outcome.value[0]?.clone_cap).toBeUndefined();
  });
});

describe("inferIdFromUsesPath", () => {
  it("strips .yaml and .stage.yaml suffixes", () => {
    expect(inferIdFromUsesPath("./decide.yaml")).toBe("decide");
    expect(inferIdFromUsesPath("./gate.stage.yaml")).toBe("gate");
  });
});
