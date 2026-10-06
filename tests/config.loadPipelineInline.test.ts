import { describe, expect, it } from "vitest";
import {
  INLINE_PIPELINE_PATH,
  loadPipelineFromObjectOutcome,
} from "../src/config/loadPipeline.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function singleStagePipeline(
  overrides: Partial<InlinePipelineDefinition> = {},
): InlinePipelineDefinition {
  return {
    id: "inline-demo",
    stages: [
      {
        id: "plan",
        system_prompt: "Do work",
        model: "anthropic/claude-sonnet-4-5",
        ...REQUIRED_IO,
      },
    ],
    ...overrides,
  };
}

describe("loadPipelineFromObjectOutcome", () => {
  it("loads a valid single-stage inline pipeline", async () => {
    const outcome = await loadPipelineFromObjectOutcome(singleStagePipeline());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.id).toBe("inline-demo");
    expect(outcome.value.pipeline.stages).toEqual(["plan"]);
    expect(outcome.value.stages).toHaveLength(1);
    expect(outcome.value.stages[0]?.id).toBe("plan");
    expect(outcome.value.stages[0]?.system_prompt).toBe("Do work");
    expect(outcome.value.pipelinePath).toBe(INLINE_PIPELINE_PATH);
    expect(outcome.value.stageSources?.plan).toEqual({ kind: "inline" });
    expect(outcome.value.dag.nodes.map((n) => n.id)).toEqual(["plan"]);
  });

  it("loads a multi-stage inline pipeline wired via route — no artificial stage-count limit", async () => {
    const pipeline: InlinePipelineDefinition = {
      id: "inline-multi",
      stages: [
        {
          id: "plan",
          entry: true,
          route: [{ to: "implement" }],
          system_prompt: "Plan the work",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
        {
          id: "implement",
          system_prompt: "Implement the plan",
          model: "anthropic/claude-sonnet-4-5",
          ...REQUIRED_IO,
        },
      ],
    };
    const outcome = await loadPipelineFromObjectOutcome(pipeline);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages.map((s) => s.id)).toEqual(["plan", "implement"]);
    expect(outcome.value.dag.roots).toEqual(["plan"]);
  });

  it("missing io on a stage → same stage.invalid_io finding a file-based load would produce", async () => {
    const pipeline = singleStagePipeline({
      stages: [{ id: "plan", system_prompt: "Do work" }],
    });
    const outcome = await loadPipelineFromObjectOutcome(pipeline);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "stage.invalid_io")).toBe(true);
  });

  it("duplicate stage id within stages[] → pipeline.include_duplicate_stage", async () => {
    const pipeline = singleStagePipeline({
      stages: [
        { id: "plan", system_prompt: "A", model: "m", ...REQUIRED_IO },
        { id: "plan", system_prompt: "B", model: "m", ...REQUIRED_IO },
      ],
    });
    const outcome = await loadPipelineFromObjectOutcome(pipeline);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.include_duplicate_stage")).toBe(
      true,
    );
  });

  it("invalid DAG shape (route cycle) → pipeline.dag_error", async () => {
    const pipeline: InlinePipelineDefinition = {
      id: "inline-cycle",
      stages: [
        {
          id: "a",
          entry: true,
          route: [{ to: "b" }],
          system_prompt: "A",
          model: "m",
          ...REQUIRED_IO,
        },
        {
          id: "b",
          route: [{ to: "a" }],
          system_prompt: "B",
          model: "m",
          ...REQUIRED_IO,
        },
      ],
    };
    const outcome = await loadPipelineFromObjectOutcome(pipeline);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.dag_error")).toBe(true);
  });

  it("a stage with uses: is rejected with a clear message, not a file-not-found error", async () => {
    const pipeline = singleStagePipeline({
      stages: [{ id: "plan", uses: "./somewhere.yaml" }],
    });
    const outcome = await loadPipelineFromObjectOutcome(pipeline);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_shape");
    expect(outcome.issues[0]?.message).toMatch(/uses/);
    expect(outcome.issues[0]?.message).not.toMatch(/not found/i);
  });

  it("empty stages[] → pipeline.invalid_shape", async () => {
    const outcome = await loadPipelineFromObjectOutcome({ id: "empty", stages: [] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.invalid_shape")).toBe(true);
  });

  it("missing id → pipeline.invalid_shape", async () => {
    const outcome = await loadPipelineFromObjectOutcome({
      id: "",
      stages: [{ id: "plan", system_prompt: "x", model: "m", ...REQUIRED_IO }],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.invalid_shape")).toBe(true);
  });
});
