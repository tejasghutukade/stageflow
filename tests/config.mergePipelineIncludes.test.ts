import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergePipelineStages } from "../src/config/mergePipelineIncludes.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);

describe("mergePipelineStages", () => {
  it("depth-first merge order: fragment stages precede main", async () => {
    const outcome = await mergePipelineStages(
      path.join(owned, "include-merge/main.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipelineId).toBe("include-merge");
    expect(outcome.value.entries.map((e) => e.raw.id ?? e.raw.uses)).toEqual([
      "./gate.stage.yaml",
      "finish",
    ]);
  });

  it("reports include cycle with path chain", async () => {
    const outcome = await mergePipelineStages(
      path.join(owned, "negative/include-cycle/a.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.include_cycle");
    expect(outcome.issues[0]?.message).toMatch(/→/);
  });

  it("reports duplicate id across fragment and main", async () => {
    const outcome = await mergePipelineStages(
      path.join(owned, "negative/duplicate-include/main.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.include_duplicate_stage");
    expect(outcome.issues[0]?.message).toMatch(/gate/);
    expect(outcome.issues[0]?.message).toMatch(/frag\.yaml|main\.pipeline\.yaml/);
  });

  it("rejects invalid include shape", async () => {
    const outcome = await mergePipelineStages(
      path.join(owned, "negative/string-refs.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.string_stage_ref");
  });
});
