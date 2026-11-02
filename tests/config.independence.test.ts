import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";

async function writePipelineRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-independence-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

const stageBody = (extra: string[] = []) =>
  [
    "  - id: plan",
    "    system_prompt: Do work",
    ...extra,
    "    io:",
    "      input:",
    "        schema:",
    "          type: object",
    "      output:",
    "        schema:",
    "          type: object",
  ].join("\n");

function pipeline(lines: string[]): string {
  return [...lines, ""].join("\n");
}

describe("loadPipelineOutcome — independence", () => {
  it("runs as persistent when the stage, root pipeline, and manifest omit it", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("persistent");
  });

  it("lets the stage body win over the root pipeline and the manifest", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        "model: openai/gpt-4o",
        "independence: strict",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: open",
        "stages:",
        stageBody(["    independence: persistent"]),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("persistent");
  });

  it("lets the root pipeline win over the manifest when the stage omits it", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        "model: openai/gpt-4o",
        "independence: strict",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: open",
        "stages:",
        stageBody(),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("open");
  });

  it("uses the manifest when the stage and root pipeline omit it", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        "model: openai/gpt-4o",
        "independence: strict",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "demo.pipeline.yaml": pipeline(["id: demo", "stages:", stageBody()]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("strict");
  });

  it("ignores independence on an include fragment", async () => {
    const root = await writePipelineRoot({
      "fragments/extra.yaml": pipeline([
        "independence: strict",
        "stages:",
        stageBody(),
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: open",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages: []",
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("open");
  });

  it("ignores an unknown level on a fragment and still loads", async () => {
    const root = await writePipelineRoot({
      "fragments/extra.yaml": pipeline([
        "independence: nope",
        "stages:",
        stageBody(),
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages: []",
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("persistent");
  });

  it("keeps a stage body level declared inside a fragment", async () => {
    const root = await writePipelineRoot({
      "fragments/extra.yaml": pipeline([
        "independence: strict",
        "stages:",
        stageBody(["    independence: open"]),
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: persistent",
        "include:",
        "  - local: ./fragments/extra.yaml",
        "stages: []",
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("open");
  });

  it("fails catalog load on an unknown stage, pipeline, or manifest level", async () => {
    const stage = await writePipelineRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(["    independence: nope"]),
      ]),
    });
    const stageOutcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: stage });
    expect(stageOutcome.ok).toBe(false);
    if (stageOutcome.ok) return;
    expect(stageOutcome.issues.some((issue) => issue.code === "stage.invalid_independence")).toBe(true);

    const pipelineRoot = await writePipelineRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "independence: nope",
        "stages:",
        stageBody(),
      ]),
    });
    const pipelineOutcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: pipelineRoot });
    expect(pipelineOutcome.ok).toBe(false);
    if (pipelineOutcome.ok) return;
    expect(pipelineOutcome.issues.some((issue) => issue.code === "pipeline.invalid_independence")).toBe(true);

    const manifestRoot = await writePipelineRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        "model: openai/gpt-4o",
        "independence: nope",
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "demo.pipeline.yaml": pipeline(["id: demo", "stages:", stageBody()]),
    });
    const manifestOutcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: manifestRoot });
    expect(manifestOutcome.ok).toBe(false);
    if (manifestOutcome.ok) return;
    expect(manifestOutcome.issues.some((issue) => issue.code === "catalog.manifest_invalid")).toBe(true);
  });

  it("does not fail load when the manifest is missing", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.issues?.some((issue) => issue.code.startsWith("catalog.manifest_"))).toBeFalsy();
    expect(outcome.value.stages[0]?.independence).toBe("persistent");
  });

  it("still fails load when a present manifest is invalid", async () => {
    const root = await writePipelineRoot({
      "stageflow.yaml": pipeline([
        "version: 1",
        'model: ""',
        "catalog:",
        "  pipelines: []",
        "  tasks: []",
      ]),
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "catalog.manifest_invalid")).toBe(true);
  });

  it("accepts open and uses it as the effective level", async () => {
    const root = await writePipelineRoot({
      "demo.pipeline.yaml": pipeline([
        "id: demo",
        "model: openai/gpt-4o",
        "stages:",
        stageBody(["    independence: open"]),
      ]),
    });
    const outcome = await loadPipelineOutcome("demo.pipeline.yaml", { cwd: root });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stages[0]?.independence).toBe("open");
  });
});
