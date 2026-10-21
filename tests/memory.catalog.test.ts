import { describe, expect, it } from "vitest";
import { loadPipelineFromObjectOutcome } from "../src/config/loadPipeline.js";
import { loadPipelineValidated } from "../src/config/validateCatalog.js";
import { createMemoryHost } from "../src/memory/host.js";
import type { InlinePipelineDefinition } from "../src/types/pipeline.js";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function pipeline(extra: Record<string, unknown> = {}, stage: Record<string, unknown> = {}): InlinePipelineDefinition {
  return {
    id: "hiring",
    stages: [
      {
        id: "search",
        system_prompt: "Search",
        model: "anthropic/claude-sonnet-4-5",
        ...REQUIRED_IO,
        ...stage,
      },
    ],
    ...extra,
  } as InlinePipelineDefinition;
}

describe("pipeline memories", () => {
  it("copies a real memory onto every stage", async () => {
    const host = createMemoryHost(process.env.STAGEFLOW_HOME!);
    await host.create({ id: "candidate-pool", description: "People already sourced." });
    const result = await loadPipelineValidated(pipeline({ memories: ["candidate-pool"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loaded.pipeline.memories).toEqual(["candidate-pool"]);
    expect(result.loaded.stages.map((stage) => stage.memories)).toEqual([["candidate-pool"]]);
  });

  it("refuses to validate a pipeline whose memory is missing", async () => {
    const result = await loadPipelineValidated(pipeline({ memories: ["missing-pool"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.some((finding) => finding.code === "pipeline.memory_unavailable")).toBe(true);
  });

  it("rejects a memories key on a stage and a duplicate id", async () => {
    const onStage = await loadPipelineFromObjectOutcome(pipeline({}, { memories: ["candidate-pool"] }));
    expect(onStage.ok).toBe(false);
    if (!onStage.ok) expect(onStage.issues.some((issue) => issue.code === "pipeline.invalid_shape")).toBe(true);

    const duplicate = await loadPipelineFromObjectOutcome(pipeline({ memories: ["pool", "pool"] }));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.issues.some((issue) => issue.code === "pipeline.invalid_memories")).toBe(true);
  });
});
