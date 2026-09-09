import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadPipelineValidated } from "../src/config/validateCatalog.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { compilePayloadSchema } from "../src/envelope/payloadSchema.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);

describe("load seam outcomes", () => {
  it("missing uses target assigns pipeline.missing_stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-missing-"));
    const pipelinePath = path.join(root, "broken.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: broken",
        "stages:",
        "  - id: missing",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.missing_stage")).toBe(
      true,
    );
  });

  it("dag cycle assigns pipeline.dag_error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-cycle-"));
    const pipelinePath = path.join(root, "cycle.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: cycle",
        "stages:",
        "  - id: a",
        "    needs: b",
        "    system_prompt: x",
        "    model: m",
        "  - id: b",
        "    needs: a",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(true);
  });

  it("assigns pipeline.invalid_shape for missing id and stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-shape-"));
    const pipelinePath = path.join(root, "bad.pipeline.yaml");
    await writeFile(pipelinePath, "not_a_pipeline: true\n");
    const outcome = await loadPipelineOutcome(pipelinePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.invalid_shape");
  });

  it("assigns stage.invalid_shape for missing required fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-stage-shape-"));
    const stagePath = path.join(root, "bad.yaml");
    await writeFile(stagePath, "id: only-id\n", "utf8");
    const outcome = await loadStageOutcome(stagePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_shape");
  });

  it("assigns stage.invalid_payload_schema for compile failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-stage-schema-"));
    const stagePath = path.join(root, "bad-schema.yaml");
    await writeFile(
      stagePath,
      [
        "id: bad-schema",
        "system_prompt: test",
        "model: anthropic/claude-sonnet-4-5",
        "payload_schema:",
        "  type: not-a-valid-type",
        "",
      ].join("\n"),
    );
    const outcome = await loadStageOutcome(stagePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_payload_schema");
  });

  it("assigns stage.invalid_gate_kinds for unsupported gate kind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-stage-gate-"));
    const stagePath = path.join(root, "bad-gate.yaml");
    await writeFile(
      stagePath,
      [
        "id: bad-gate",
        "system_prompt: test",
        "model: anthropic/claude-sonnet-4-5",
        "gate_kinds:",
        "  - not_a_kind",
        "",
      ].join("\n"),
    );
    const outcome = await loadStageOutcome(stagePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_gate_kinds");
  });

  it("assigns stage.invalid_clone_input_schema for compile failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-schema-"));
    const stagePath = path.join(root, "bad-clone-schema.yaml");
    await writeFile(
      stagePath,
      [
        "id: bad-clone-schema",
        "system_prompt: test",
        "model: anthropic/claude-sonnet-4-5",
        "clone_input_schema:",
        "  type: not-a-valid-type",
        "",
      ].join("\n"),
    );
    const outcome = await loadStageOutcome(stagePath);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.invalid_clone_input_schema");
  });

  it("assigns stage.invalid_clone_actions for empty or unknown actions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-clone-actions-"));
    const emptyPath = path.join(root, "empty-actions.yaml");
    await writeFile(
      emptyPath,
      [
        "id: empty-actions",
        "system_prompt: test",
        "model: anthropic/claude-sonnet-4-5",
        "clone_actions: []",
        "",
      ].join("\n"),
    );
    const empty = await loadStageOutcome(emptyPath);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.issues[0]?.code).toBe("stage.invalid_clone_actions");
  });

  it("loadPipeline throws for missing uses target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-throw-"));
    const pipelinePath = path.join(root, "broken.pipeline.yaml");
    await writeFile(
      pipelinePath,
      [
        "id: broken",
        "stages:",
        "  - id: missing",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(pipelinePath)).rejects.toThrow(/missing stage/i);
  });
});

describe("loadPipelineValidated", () => {
  it("returns loaded pipeline on success", async () => {
    const result = await loadPipelineValidated(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loaded.pipeline.id).toBe("fork-demo");
    expect(result.loaded.stages.length).toBeGreaterThan(0);
  });

  it("returns pipeline.stage_id_mismatch finding", async () => {
    const result = await loadPipelineValidated(
      path.join(owned, "negative/id-mismatch.pipeline.yaml"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.findings.some((finding) => finding.code === "pipeline.stage_id_mismatch"),
    ).toBe(true);
  });

  it("aggregates multiple findings sorted by path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-multi-"));
    const pipelinePath = path.join(root, "multi.pipeline.yaml");
    await mkdir(path.join(root, "stages"), { recursive: true });
    await writeFile(
      pipelinePath,
      [
        "id: multi",
        "stages:",
        "  - decide",
        "  - id: bad",
        "    uses: ./missing.yaml",
        "",
      ].join("\n"),
    );
    const result = await loadPipelineValidated(pipelinePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.length).toBeGreaterThan(0);
    const paths = result.findings.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);
  });
});

async function writeTempFiles(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-io-ref-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

const STORY_SLICE = [
  "  story-slice:",
  "    type: object",
  "    required: [title]",
  "    properties:",
  "      title:",
  "        type: string",
].join("\n");

describe("io $ref and sequential compatibility", () => {
  it("compiles #/schemas/story-slice on input and output from pipeline schemas", async () => {
    const root = await writeTempFiles({
      "demo.pipeline.yaml": [
        "id: demo",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: produce",
        "    system_prompt: Produce",
        "    io:",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "  - id: consume",
        "    system_prompt: Consume",
        "    needs: [produce]",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => compilePayloadSchema(outcome.value.stages[0]?.payload_schema)).not.toThrow();
    expect(() =>
      compilePayloadSchema(outcome.value.stages[1]?.clone_input_schema),
    ).not.toThrow();
    expect(() =>
      compilePayloadSchema(outcome.value.stages[1]?.payload_schema),
    ).not.toThrow();
  });

  it("resolves $ref on a uses: stage file after pipeline schemas attach", async () => {
    const root = await writeTempFiles({
      "produce.yaml": [
        "id: produce",
        "system_prompt: Produce",
        "io:",
        "  output:",
        "    schema:",
        "      $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: produce",
        "    uses: ./produce.yaml",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(() => compilePayloadSchema(outcome.value.stages[0]?.payload_schema)).not.toThrow();
  });

  it("fails load on a $ref cycle", async () => {
    const root = await writeTempFiles({
      "cycle.pipeline.yaml": [
        "id: cycle",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        "  a:",
        "    $ref: '#/schemas/b'",
        "  b:",
        "    $ref: '#/schemas/a'",
        "stages:",
        "  - id: loop",
        "    system_prompt: Loop",
        "    io:",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/a'",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("cycle.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/\$ref cycle/i);
  });

  it("fails pipeline.io_incompatible when consumer required field is missing from producer", async () => {
    const root = await writeTempFiles({
      "incompat.pipeline.yaml": [
        "id: incompat",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: produce",
        "    system_prompt: Produce",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "          required: [verdict]",
        "          properties:",
        "            verdict:",
        "              type: string",
        "  - id: consume",
        "    system_prompt: Consume",
        "    needs: [produce]",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "          required: [missing_field]",
        "          properties:",
        "            missing_field:",
        "              type: string",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("incompat.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.io_incompatible")).toBe(
      true,
    );
  });

  it("does not treat string-equal $ref as compatible when resolved shapes are not a subset", async () => {
    const root = await writeTempFiles({
      "shared-ref.pipeline.yaml": [
        "id: shared-ref",
        "model: anthropic/claude-sonnet-4-5",
        "schemas:",
        "  produced:",
        "    type: object",
        "    required: [title]",
        "    properties:",
        "      title:",
        "        type: string",
        "  consumed:",
        "    type: object",
        "    required: [title, extra]",
        "    properties:",
        "      title:",
        "        type: string",
        "      extra:",
        "        type: string",
        "stages:",
        "  - id: produce",
        "    system_prompt: Produce",
        "    io:",
        "      output:",
        "        schema:",
        "          $ref: '#/schemas/produced'",
        "  - id: consume",
        "    system_prompt: Consume",
        "    needs: [produce]",
        "    io:",
        "      input:",
        "        schema:",
        "          $ref: '#/schemas/consumed'",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("shared-ref.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.io_incompatible")).toBe(
      true,
    );
  });

  it("AE6: clonable child input is not subset-checked against parent output", async () => {
    const root = await writeTempFiles({
      "clone.pipeline.yaml": [
        "id: clone-edge",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: plan",
        "    system_prompt: Plan",
        "    clonable: true",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "          required: [verdict]",
        "          properties:",
        "            verdict:",
        "              type: string",
        "  - id: investigate",
        "    system_prompt: Investigate",
        "    needs: [plan]",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "          required: [area_id]",
        "          properties:",
        "            area_id:",
        "              type: string",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("clone.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
  });

  it("does not fail io_incompatible on a multi-parent join with child io.input", async () => {
    const root = await writeTempFiles({
      "join.pipeline.yaml": [
        "id: join",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: left",
        "    system_prompt: Left",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "          required: [foo]",
        "          properties:",
        "            foo:",
        "              type: string",
        "  - id: right",
        "    system_prompt: Right",
        "    io:",
        "      output:",
        "        schema:",
        "          type: object",
        "          required: [bar]",
        "          properties:",
        "            bar:",
        "              type: string",
        "  - id: merge",
        "    system_prompt: Join",
        "    needs: [left, right]",
        "    io:",
        "      input:",
        "        schema:",
        "          type: object",
        "          required: [area_id]",
        "          properties:",
        "            area_id:",
        "              type: string",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("join.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
  });

  it("fails isolated stage $ref-only schema with stage.unresolved_schema_ref", async () => {
    const root = await writeTempFiles({
      "ref-only.yaml": [
        "id: ref-only",
        "system_prompt: Isolated",
        "model: anthropic/claude-sonnet-4-5",
        "io:",
        "  output:",
        "    schema:",
        "      $ref: '#/schemas/story-slice'",
        "",
      ].join("\n"),
    });
    const outcome = await loadStageOutcome(path.join(root, "ref-only.yaml"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("stage.unresolved_schema_ref");
  });

  it("fails load when an include fragment declares schemas", async () => {
    const root = await writeTempFiles({
      "fragments/extra.yaml": [
        "schemas:",
        STORY_SLICE,
        "stages:",
        "  - id: gate",
        "    system_prompt: Gate",
        "    model: anthropic/claude-sonnet-4-5",
        "",
      ].join("\n"),
      "main.pipeline.yaml": [
        "id: include-schemas",
        "model: anthropic/claude-sonnet-4-5",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages:",
        "  - id: finish",
        "    system_prompt: Finish",
        "    needs: [gate]",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome(path.join(root, "main.pipeline.yaml"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/schemas/);
  });
});
