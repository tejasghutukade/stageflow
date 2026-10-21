import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { parseStageSecrets } from "../src/runtime/stageSecretDecl.js";

async function writeUsesPipeline(
  dir: string,
  fileSecretLines: string[],
  entrySecretLines?: string[],
): Promise<string> {
  await writeFile(
    path.join(dir, "worker.yaml"),
    [
      "id: worker",
      "system_prompt: x",
      "model: anthropic/claude-sonnet-4-5",
      "io:",
      "  input:",
      "    schema:",
      "      type: object",
      "  output:",
      "    schema:",
      "      type: object",
      ...fileSecretLines,
      "",
    ].join("\n"),
  );
  const pipelinePath = path.join(dir, "overlay.pipeline.yaml");
  await writeFile(
    pipelinePath,
    [
      "id: overlay",
      "stages:",
      "  - id: worker",
      "    uses: ./worker.yaml",
      ...(entrySecretLines ?? []),
      "",
    ].join("\n"),
  );
  return pipelinePath;
}

describe("loadPipeline secrets merge", () => {
  it("overlays pipeline-entry secrets over the stage file list", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-sec-overlay-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["secrets:", "  - GITHUB_TOKEN"],
      ["    secrets:", "      - NPM_TOKEN"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.secrets).toEqual([{ name: "NPM_TOKEN" }]);
  });

  it("clears the file secrets list when the entry sets an empty array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-sec-clear-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["secrets:", "  - GITHUB_TOKEN"],
      ["    secrets: []"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.secrets).toEqual([]);
  });

  it("keeps the file secrets list when the entry omits secrets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-sec-keep-"));
    const pipelinePath = await writeUsesPipeline(dir, [
      "secrets:",
      "  - GITHUB_TOKEN",
    ]);
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.secrets).toEqual([{ name: "GITHUB_TOKEN" }]);
  });
});

describe("parseStageSecrets", () => {
  it("rejects permanently denied secret names", () => {
    const outcome = parseStageSecrets(
      ["STAGEFLOW_CONTROL_TOKEN"],
      "test",
      "s1",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.issues[0]?.code).toBe("stage.denied_secret");
    }
  });

  it("accepts as: env form", () => {
    const outcome = parseStageSecrets(
      [{ name: "GITHUB_TOKEN", as: "env" }],
      "test",
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual([{ name: "GITHUB_TOKEN", as: "env" }]);
    }
  });
});
