import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";

async function writePipelineRoot(
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-model-hier-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

describe("loadPipelineOutcome — model hierarchy", () => {
  it("pipeline-level model fills inline stage that omits model", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": [
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.model).toBe("openai/gpt-4o");
    expect(outcome.value.stages[0]?.model).toBe("openai/gpt-4o");
  });

  it("stageflow.yaml global fills when pipeline and stage omit model", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": [
        "version: 1",
        "model: anthropic/claude-sonnet-4-5",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("global model fills when cwd is nested subdirectory", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": [
        "version: 1",
        "model: test/global-from-root",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
        "",
      ].join("\n"),
      "subdir/demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "",
      ].join("\n"),
    });
    const nested = path.join(root, "subdir");
    const pipelineAbs = path.join(nested, "demo.pipeline.yaml");
    const withoutRoot = await loadPipelineOutcome(pipelineAbs, { cwd: nested });
    expect(withoutRoot.ok).toBe(false);
    if (withoutRoot.ok) return;
    expect(withoutRoot.issues.some((i) => i.code === "stage.missing_model")).toBe(
      true,
    );

    const withRoot = await loadPipelineOutcome(pipelineAbs, {
      cwd: nested,
      projectRoot: root,
    });
    expect(withRoot.ok).toBe(true);
    if (!withRoot.ok) return;
    expect(withRoot.value.stages[0]?.model).toBe("test/global-from-root");
  });

  it("canonical global-default fixture fills from fixture stageflow.yaml", async () => {
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-hierarchy/global-default",
    );
    const outcome = await loadPipelineOutcome("fill.pipeline.yaml", {
      cwd: fixtureRoot,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.model).toBe("test/global-model");
  });

  it("canonical stage-override fixture keeps stage model over loaded global", async () => {
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-hierarchy/stage-override",
    );
    const outcome = await loadPipelineOutcome("override.pipeline.yaml", {
      cwd: fixtureRoot,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.model).toBe("test/stage-model");
  });

  it("canonical pipeline-default fixture fills from pipeline model", async () => {
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-hierarchy/pipeline-default",
    );
    const outcome = await loadPipelineOutcome("fill.pipeline.yaml", {
      cwd: fixtureRoot,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pipeline.model).toBe("test/pipeline-model");
    expect(outcome.value.stages[0]?.model).toBe("test/pipeline-model");
  });

  it("canonical missing-all fixture fails with stage.missing_model", async () => {
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-hierarchy/missing-all",
    );
    const outcome = await loadPipelineOutcome("fail.pipeline.yaml", {
      cwd: fixtureRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "stage.missing_model")).toBe(true);
  });

  it("stage model overrides pipeline and global", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": [
        "version: 1",
        "model: anthropic/claude-sonnet-4-5",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: google/gemini-2.5-pro",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.model).toBe("google/gemini-2.5-pro");
  });

  it("absent stageflow.yaml + no stage/pipeline model → stage.missing_model", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "stage.missing_model")).toBe(true);
    expect(outcome.issues.some((i) => i.code.startsWith("catalog.manifest_"))).toBe(
      false,
    );
  });

  it("invalid empty pipeline model → pipeline.invalid_model", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": [
        "id: demo",
        'model: ""',
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: openai/gpt-4o",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.invalid_model")).toBe(true);
  });

  it("invalid empty manifest model → catalog.manifest_invalid", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": [
        "version: 1",
        'model: ""',
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "catalog.manifest_invalid")).toBe(true);
    expect(outcome.issues.some((i) => i.code === "stage.missing_model")).toBe(false);
  });

  it("invalid manifest fails even when stage declares model", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": [
        "version: 1",
        'model: ""',
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
        "",
      ].join("\n"),
      "demo.pipeline.yaml": [
        "id: demo",
        "stages:",
        "  - id: plan",
        "    system_prompt: Do work",
        "    model: openai/gpt-4o",
        "",
      ].join("\n"),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "catalog.manifest_invalid")).toBe(true);
  });
});
