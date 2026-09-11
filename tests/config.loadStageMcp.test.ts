import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { SINGLE_PIPELINE } from "./helpers/fixturePaths.js";

async function writeUsesPipeline(
  dir: string,
  fileMcpLines: string[],
  entryMcpLines?: string[],
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
      ...fileMcpLines,
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
      ...(entryMcpLines ?? []),
      "",
    ].join("\n"),
  );
  return pipelinePath;
}

describe("loadPipeline mcp merge", () => {
  it("overlays pipeline-entry mcp over the stage file list", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-overlay-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["mcp:", "  - github"],
      ["    mcp:", "      - notion"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.mcp).toEqual(["notion"]);
  });

  it("clears the file mcp list when the entry sets an empty array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-clear-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["mcp:", "  - github"],
      ["    mcp: []"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.mcp).toEqual([]);
  });

  it("keeps the file mcp list when the entry omits mcp", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-keep-"));
    const pipelinePath = await writeUsesPipeline(dir, ["mcp:", "  - github"]);
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.mcp).toEqual(["github"]);
  });

  it("leaves clarify.mcp undefined on the single-stage fixture", async () => {
    const loaded = await loadPipeline(SINGLE_PIPELINE);
    const clarify = loaded.stages.find((stage) => stage.id === "clarify");
    expect(clarify?.mcp).toBeUndefined();
  });
});
