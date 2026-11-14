import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { loadStageOutcome } from "../src/config/loadStage.js";
import { validatePipeline } from "../src/config/validateCatalog.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { stageMcpTools } from "../src/types/stage.js";
import { SINGLE_PIPELINE } from "./helpers/fixturePaths.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

const FILE_IO = [
  "io:",
  "  input:",
  "    schema:",
  "      type: object",
  "  output:",
  "    schema:",
  "      type: object",
];

async function writeStage(dir: string, name: string, mcpLines: string[]): Promise<string> {
  const filePath = path.join(dir, `${name}.yaml`);
  await writeFile(
    filePath,
    [
      `id: ${name}`,
      "system_prompt: x",
      "model: anthropic/claude-sonnet-4-5",
      ...FILE_IO,
      ...mcpLines,
      "",
    ].join("\n"),
  );
  return filePath;
}

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

  it("replaces a stage-file tool map when the pipeline entry lists server names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-replace-map-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["mcp:", "  wonder:", "    - get_artboards"],
      ["    mcp:", "      - wonder"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.mcp).toEqual(["wonder"]);
    expect(stageMcpTools(loaded.stages[0])).toBeUndefined();
  });

  it("clears a stage-file tool map when the entry sets an empty array", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-clear-map-"));
    const pipelinePath = await writeUsesPipeline(
      dir,
      ["mcp:", "  wonder:", "    - get_artboards"],
      ["    mcp: []"],
    );
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.stages[0]?.mcp).toEqual([]);
    expect(stageMcpTools(loaded.stages[0])).toBeUndefined();
  });
});

describe("stage mcp tool list", () => {
  it("loads mcp as a name list as every tool of that server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-names-"));
    const filePath = await writeStage(dir, "named", ["mcp:", "  - wonder"]);
    const outcome = await loadStageOutcome(filePath);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mcp).toEqual(["wonder"]);
    expect(stageMcpTools(outcome.value)).toBeUndefined();
  });

  it("loads an mcp map as the named tools of that server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-map-"));
    const filePath = await writeStage(dir, "mapped", [
      "mcp:",
      "  wonder:",
      "    - get_artboards",
    ]);
    const outcome = await loadStageOutcome(filePath);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mcp).toEqual(["wonder"]);
    expect(stageMcpTools(outcome.value)).toEqual({
      wonder: ["get_artboards"],
    });
    expect(JSON.parse(JSON.stringify(outcome.value)).mcp_tools).toEqual({
      wonder: ["get_artboards"],
    });
  });

  it("loads an mcp map whose only entry is * as every tool of that server", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-star-"));
    const filePath = await writeStage(dir, "starred", [
      "mcp:",
      "  wonder:",
      '    - "*"',
    ]);
    const outcome = await loadStageOutcome(filePath);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.mcp).toEqual(["wonder"]);
    expect(stageMcpTools(outcome.value)).toBeUndefined();
  });

  it("rejects an empty tool list and a bare server string as stage.invalid_mcp", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-map-bad-"));
    const cases = [
      { name: "empty-tools", mcpLines: ["mcp:", "  wonder: []"] },
      { name: "bare-string", mcpLines: ["mcp: wonder"] },
    ];
    for (const { name, mcpLines } of cases) {
      const outcome = await loadStageOutcome(await writeStage(dir, name, mcpLines));
      expect(outcome.ok, name).toBe(false);
      if (outcome.ok) return;
      expect(outcome.issues[0]?.code, name).toBe("stage.invalid_mcp");
    }
  });

  it("accepts a tool name validate has not seen", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { wonder: { type: "http", url: "https://example.test/mcp" } },
        }),
      );
      const pipelinePath = path.join(root, "worker.pipeline.yaml");
      await writeFile(
        pipelinePath,
        [
          "id: worker",
          "stages:",
          "  - id: worker",
          "    system_prompt: test",
          "    model: anthropic/claude-sonnet-4-5",
          "    io:",
          "      input:",
          "        schema:",
          "          type: object",
          "      output:",
          "        schema:",
          "          type: object",
          "    mcp:",
          "      wonder:",
          "        - get_artboards",
          "",
        ].join("\n"),
      );
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(true);
      expect(result.findings.some((finding) => finding.message.includes("get_artboards"))).toBe(
        false,
      );
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
