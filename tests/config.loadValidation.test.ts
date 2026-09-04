import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline, loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { loadPipelineValidated } from "../src/config/validateCatalog.js";
import { loadStageOutcome } from "../src/config/loadStage.js";

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
