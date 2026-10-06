import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { mergePipelineStages } from "../src/config/mergePipelineIncludes.js";
import { normalizePipelineStageEntries } from "../src/config/normalizePipelineStageEntry.js";

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
    const outcome = await loadPipelineOutcome(
      path.join(owned, "negative/string-refs.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.string_stage_ref");
  });

  it("defers string ref rejection to normalization", async () => {
    const mergeOutcome = await mergePipelineStages(
      path.join(owned, "negative/string-refs.pipeline.yaml"),
    );
    expect(mergeOutcome.ok).toBe(true);
    if (!mergeOutcome.ok) return;

    const normalizeOutcome = normalizePipelineStageEntries(mergeOutcome.value.entries, {
      pipelineId: mergeOutcome.value.pipelineId,
      path: path.join(owned, "negative/string-refs.pipeline.yaml"),
    });
    expect(normalizeOutcome.ok).toBe(false);
    if (normalizeOutcome.ok) return;
    expect(normalizeOutcome.issues[0]?.code).toBe("pipeline.string_stage_ref");
  });

  it("loads a target pipeline that includes a legacy fragment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-include-dialect-"));
    await mkdir(path.join(root, "fragments"), { recursive: true });
    await writeFile(
      path.join(root, "fragments/legacy.yaml"),
      [
        "stages:",
        "  - id: gate",
        "    system_prompt: Gate",
        "    model: anthropic/claude-sonnet-4-5",
        "    payload_schema:",
        "      type: object",
        "    clone_input_schema:",
        "      type: object",
        "    entry: true",
        "    route:",
        "      - to: finish",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "main.pipeline.yaml"),
      [
        "id: include-dialect",
        "include:",
        "  - local: ./fragments/legacy.yaml",
        "stages:",
        "  - id: finish",
        "    system_prompt: Finish",
        "    model: anthropic/claude-sonnet-4-5",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "      output:",
        "        schema:",
        "          type: object",
        "",
      ].join("\n"),
    );

    const outcome = await loadPipelineOutcome(path.join(root, "main.pipeline.yaml"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.stages).toEqual(["gate", "finish"]);
    expect(outcome.value.stages.find((stage) => stage.id === "gate")?.payload_schema).toEqual({
      type: "object",
    });
    expect(outcome.value.stages.find((stage) => stage.id === "finish")?.payload_schema).toEqual({
      type: "object",
    });
  });
});
