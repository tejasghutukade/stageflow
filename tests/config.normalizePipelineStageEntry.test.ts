import { describe, expect, it } from "vitest";
import {
  inferIdFromUsesPath,
  normalizePipelineStageEntries,
  toWiringRefs,
} from "../src/config/normalizePipelineStageEntry.js";

const ctx = { pipelineId: "test", path: "/tmp/test.pipeline.yaml" };

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

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

  it("treats uses plus mcp as a file-stage override, not an inline conflict", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            uses: "./x.yaml",
            mcp: ["github"],
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.body).toMatchObject({
      kind: "uses",
      path: "./x.yaml",
    });
    expect(outcome.value[0]?.mcp).toEqual(["github"]);
    expect(toWiringRefs(outcome.value)).toEqual([{ id: "x" }]);
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
            ...REQUIRED_IO,
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

  it("normalizes route entries with mixed on gates", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "research",
            entry: true,
            route: [{ to: "synthesize" }],
            system_prompt: "p",
            model: "m",
            ...REQUIRED_IO,
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
        {
          raw: {
            id: "validation",
            entry: true,
            route: [{ to: "synthesize", on: ["succeeded", "failed"] }],
            system_prompt: "p",
            model: "m",
            ...REQUIRED_IO,
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
        {
          raw: {
            id: "synthesize",
            route: [{ to: "followup" }],
            system_prompt: "p",
            model: "m",
            ...REQUIRED_IO,
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
        {
          raw: {
            id: "followup",
            system_prompt: "p",
            model: "m",
            ...REQUIRED_IO,
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.route).toEqual([{ to: "synthesize", on: ["succeeded"] }]);
    expect(outcome.value[1]?.route).toEqual([
      { to: "synthesize", on: ["succeeded", "failed"] },
    ]);
    expect(outcome.value[2]?.route).toEqual([{ to: "followup", on: ["succeeded"] }]);
    expect(toWiringRefs(outcome.value).map((ref) => ref.route)).toEqual([
      [{ to: "synthesize", on: ["succeeded"] }],
      [{ to: "synthesize", on: ["succeeded", "failed"] }],
      [{ to: "followup", on: ["succeeded"] }],
      undefined,
    ]);
  });

  it("accepts a one-element route array", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "clarify",
            entry: true,
            route: [{ to: "design-doc" }],
            system_prompt: "p",
            model: "m",
            ...REQUIRED_IO,
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.route).toEqual([{ to: "design-doc", on: ["succeeded"] }]);
  });

  it("accepts uses plus on_verify_fail as wiring", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            uses: "./x.yaml",
            on_verify_fail: {
              mode: "repair",
              max_attempts: 2,
              retry_safety: "idempotent",
            },
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.body).toMatchObject({ kind: "uses", path: "./x.yaml" });
    expect(outcome.value[0]?.recovery).toEqual({
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });
    expect(toWiringRefs(outcome.value)[0]?.recovery).toEqual(outcome.value[0]?.recovery);
  });

  it("rejects uses plus io as an inline body conflict", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            uses: "./x.yaml",
            io: { output: { schema: { type: "object" } } },
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

  it("rejects mixed payload_schema and io on one entry", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "x",
            system_prompt: "p",
            model: "m",
            payload_schema: { type: "object" },
            io: { output: { schema: { type: "object" } } },
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("catalog.mixed_yaml_dialect");
  });

  it("maps inline io and after-verify onto payload_schema and completion", () => {
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "plan",
            system_prompt: "p",
            model: "m",
            gate_kinds: ["confirm"],
            io: {
              input: { schema: { type: "object" } },
              output: {
                schema: {
                  type: "object",
                  properties: { verdict: { type: "string" } },
                  required: ["verdict"],
                },
              },
            },
            verify: [
              { id: "approved", type: "gate", kind: "confirm", when: ["emit"] },
              { id: "report", type: "artifact", path: "report.md", when: ["after"] },
            ],
          },
          declaringPath: "/tmp/pipeline.yaml",
        },
      ],
      ctx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]?.body.kind).toBe("inline");
    if (outcome.value[0]?.body.kind !== "inline") return;
    expect(outcome.value[0].body.raw.payload_schema).toEqual({
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    });
    expect(outcome.value[0].body.raw.pre_emit_checks).toEqual([
      { id: "approved", type: "gate", kind: "confirm" },
    ]);
    expect(outcome.value[0]?.completion).toEqual({
      mode: "all",
      checks: [{ id: "report", type: "artifact", path: "report.md" }],
    });
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
            ...REQUIRED_IO,
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
          raw: { id: "clarify", system_prompt: "p", model: "m", ...REQUIRED_IO },
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
