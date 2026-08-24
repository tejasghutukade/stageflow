import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline, loadPipelineOutcome, loadPipelineValidated } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturesStagesDir = path.join(fixtures, "stages");

describe("load seam outcomes", () => {
  it("AE-S4-1: missing stage assigns pipeline.missing_stage at rule site", async () => {
    const outcome = await loadPipelineOutcome("broken", {
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const issue = outcome.issues[0];
    expect(issue.code).toBe("pipeline.missing_stage");
    expect(issue.message).toMatch(/missing stage/i);
  });

  it("AE-S4-1: dag cycle assigns pipeline.dag_error at rule site", async () => {
    const outcome = await loadPipelineOutcome("cycle", {
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(true);
  });

  it("assigns pipeline.invalid_shape for missing id and stages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-load-shape-"));
    const pipelinesDir = path.join(root, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    const pipelinePath = path.join(pipelinesDir, "bad.yaml");
    await writeFile(pipelinePath, "not_a_pipeline: true\n");
    const outcome = await loadPipelineOutcome(pipelinePath, { cwd: root });
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

  it("AE-S4-4: loadPipeline still throws for broken pipeline", async () => {
    await expect(
      loadPipeline("broken", {
        cwd: fixtures,
        stagesDir: fixturesStagesDir,
      }),
    ).rejects.toThrow(/missing stage/i);
  });
});

describe("loadPipelineValidated", () => {
  it("returns loaded pipeline on success", async () => {
    const result = await loadPipelineValidated("docs-only", {
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loaded.pipeline.id).toBe("docs-only");
    expect(result.loaded.stages.length).toBeGreaterThan(0);
  });

  it("returns pipeline.missing_stage finding for broken pipeline", async () => {
    const result = await loadPipelineValidated("broken", {
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.findings.some(
        (finding) =>
          finding.code === "pipeline.missing_stage" && /missing stage/i.test(finding.message),
      ),
    ).toBe(true);
  });
});
