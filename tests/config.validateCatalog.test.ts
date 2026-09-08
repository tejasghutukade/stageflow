import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import {
  buildValidationResult,
  loadPipelineValidated,
  validateCatalog,
  validatePipeline,
  type ValidationFinding,
} from "../src/config/validateCatalog.js";
import * as validateCatalogModule from "../src/config/validateCatalog.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { REPO_ROOT, FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const manifestCatalog = path.join(fixtures, "manifest-catalog");
const pipelineOwned = path.join(fixtures, "pipeline-owned");

async function writeManifest(
  root: string,
  manifestYaml: string,
  extra?: { relPath: string; content: string } | { relPath: string; content: string }[],
): Promise<void> {
  await writeFile(path.join(root, "stageflow.yaml"), manifestYaml);
  if (extra) {
    const files = Array.isArray(extra) ? extra : [extra];
    for (const file of files) {
      const abs = path.join(root, file.relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, file.content);
    }
  }
}

const validStageYaml = (id: string) =>
  [
    `id: ${id}`,
    "system_prompt: test",
    "model: anthropic/claude-sonnet-4-5",
    "",
  ].join("\n");

function findingCodes(findings: ValidationFinding[]): string[] {
  return findings.map((f) => f.code);
}

function findingsForPath(findings: ValidationFinding[], relPath: string): ValidationFinding[] {
  return findings.filter((f) => f.path === relPath || f.path.endsWith(relPath));
}

describe("validateCatalog helpers", () => {
  it("does not export regex error mappers (S4-U3)", () => {
    expect("mapPipelineErrorCode" in validateCatalogModule).toBe(false);
    expect("mapStageErrorCode" in validateCatalogModule).toBe(false);
  });

  it("summarizeFindings promotes manifest warnings under strict", () => {
    const findings: ValidationFinding[] = [
      {
        severity: "warning",
        code: "catalog.manifest_missing",
        path: "stageflow.yaml",
        message: "missing",
        category: "catalog",
      },
    ];
    expect(buildValidationResult("full", findings, false).summary).toEqual({
      errors: 0,
      warnings: 1,
    });
    expect(buildValidationResult("full", findings, true).summary).toEqual({
      errors: 1,
      warnings: 0,
    });
    expect(buildValidationResult("full", findings, false).ok).toBe(true);
    expect(buildValidationResult("full", findings, true).ok).toBe(false);
  });

  it("summarizeFindings counts mixed errors and warnings", () => {
    const findings: ValidationFinding[] = [
      {
        severity: "error",
        code: "pipeline.missing_stage",
        path: "pipelines/broken.pipeline.yaml",
        message: "missing",
        category: "pipeline",
      },
      {
        severity: "warning",
        code: "catalog.empty_catalog",
        path: "stageflow.yaml",
        message: "empty",
        category: "catalog",
      },
    ];
    expect(buildValidationResult("full", findings, false).summary).toEqual({
      errors: 1,
      warnings: 1,
    });
    expect(buildValidationResult("full", findings, true).summary).toEqual({
      errors: 2,
      warnings: 0,
    });
  });
});

describe("validateCatalog manifest-all", () => {
  it("AE4: missing manifest warns by default and fails under strict", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      clearFindProjectRootCacheForTests();
      const defaultResult = await validateCatalog({ scope: "full", cwd: root });
      expect(defaultResult.ok).toBe(true);
      expect(defaultResult.findings.some((f) => f.code === "catalog.manifest_missing")).toBe(
        true,
      );

      const strictResult = await validateCatalog({ scope: "full", cwd: root, strict: true });
      expect(strictResult.ok).toBe(false);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE5: validates pipeline-owned fixtures via manifest", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(result.findings.some((f) => f.code === "catalog.orphan_stage")).toBe(false);
      expect(
        result.findings.some(
          (f) =>
            f.path.includes("fork-demo.pipeline.yaml") &&
            f.severity === "error",
        ),
      ).toBe(false);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE6: standalone stage beside pipeline is not an orphan finding", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeManifest(
        root,
        [
          "version: 1",
          "catalog:",
          "  pipelines: [catalog]",
          "  tasks: [tasks/placeholder.task.yaml]",
          "",
        ].join("\n"),
        {
          relPath: "catalog/demo.pipeline.yaml",
          content: [
            "id: demo",
            "stages:",
            "  - id: used",
            "    uses: ./used.yaml",
            "",
          ].join("\n"),
        },
      );
      await writeFile(path.join(root, "catalog/used.yaml"), validStageYaml("used"));
      await writeFile(path.join(root, "catalog/unused.yaml"), validStageYaml("unused"));
      await mkdir(path.join(root, "tasks"), { recursive: true });
      await writeFile(
        path.join(root, "tasks/placeholder.task.yaml"),
        "id: t\ngoal: g\n",
      );
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(result.findings.some((f) => f.code === "catalog.orphan_stage")).toBe(false);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE7: duplicate pipeline id across manifest entries", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      const dupFindings = result.findings.filter(
        (f) => f.code === "catalog.duplicate_pipeline_id",
      );
      expect(dupFindings.length).toBeGreaterThanOrEqual(2);
      expect(dupFindings.some((f) => f.path.includes("dup-a.pipeline.yaml"))).toBe(true);
      expect(dupFindings.some((f) => f.path.includes("dup-b.pipeline.yaml"))).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("invalid manifest shape fails closed", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(path.join(root, "stageflow.yaml"), "version: 2\n");
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(result.ok).toBe(false);
      expect(result.findings.some((f) => f.code === "catalog.manifest_invalid")).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("excluded pipeline is not validated", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(result.findings.some((f) => f.path.includes("excluded/hidden"))).toBe(false);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("reports broken pipeline files from manifest scan", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(
        findingsForPath(result.findings, "pipelines/broken.pipeline.yaml").length,
      ).toBeGreaterThan(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

describe("validateCatalog pipeline scope", () => {
  it.skip("AE-S1-2: targeted docs-only passes — legacy fixtures S7", async () => {
    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: pipelinePath("docs-only"),
      cwd: fixtures,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.path.includes("broken.pipeline.yaml"))).toBe(false);
  });

  it.skip("AE-S5-3: targeted validate agrees with loadPipelineValidated — legacy S7", async () => {
    const validateResult = await validateCatalog({
      scope: "pipeline",
      pipeline: pipelinePath("docs-only"),
      cwd: fixtures,
    });
    const loadResult = await loadPipelineValidated(pipelinePath("docs-only"), {
      cwd: fixtures,
    });
    expect(validateResult.ok).toBe(true);
    expect(loadResult.ok).toBe(true);
    expect(validateResult.findings.some((f) => f.path.includes("broken.pipeline.yaml"))).toBe(false);
  });

  it("AE-S1-4: stage id must match filename stem", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-id-mismatch-"));
    await writeManifest(
      root,
      [
        "version: 1",
        "catalog:",
        "  pipelines: [pipelines/mismatch.pipeline.yaml]",
        "  tasks: [tasks/t.task.yaml]",
        "",
      ].join("\n"),
      {
        relPath: "pipelines/mismatch.pipeline.yaml",
        content: [
          "id: mismatch",
          "stages:",
          "  - id: wrong-id",
          "    uses: ../stages/wrong-id.yaml",
          "",
        ].join("\n"),
      },
    );
    await mkdir(path.join(root, "stages"), { recursive: true });
    await writeFile(path.join(root, "stages/wrong-id.yaml"), validStageYaml("other"));
    await mkdir(path.join(root, "tasks"), { recursive: true });
    await writeFile(path.join(root, "tasks/t.task.yaml"), "id: t\ngoal: g\n");

    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: path.join(root, "pipelines/mismatch.pipeline.yaml"),
      cwd: root,
    });
    expect(result.ok).toBe(false);
    const mismatch = result.findings.find(
      (f) => f.code === "pipeline.stage_id_mismatch" || f.code === "stage.id_filename_mismatch",
    );
    expect(mismatch).toBeDefined();
  });

  it("cycle pipeline produces pipeline.dag_error", async () => {
    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: path.join(pipelineOwned, "negative/include-cycle/a.pipeline.yaml"),
      cwd: pipelineOwned,
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (f) => f.code === "pipeline.dag_error" || f.code === "pipeline.include_cycle",
      ),
    ).toBe(true);
  });

  it("throws when pipeline scope omits pipeline name", async () => {
    await expect(
      validateCatalog({ scope: "pipeline", cwd: fixtures }),
    ).rejects.toThrow(/pipeline is required/i);
  });
});

describe("validateCatalog task scope", () => {
  it("AE4: valid task file passes with scope task", async () => {
    const taskPath = SAMPLE_TASK;
    const result = await validateCatalog({
      scope: "task",
      task: taskPath,
      cwd: fixtures,
    });
    expect(result.scope).toBe("task");
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("invalid shape produces task finding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-task-"));
    const taskPath = path.join(root, "bad.task.yaml");
    await writeFile(taskPath, "id: bad\n");
    const result = await validateCatalog({
      scope: "task",
      task: taskPath,
      cwd: root,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "task.invalid_shape")).toBe(true);
  });

  it("missing file produces load_error finding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-task-"));
    const result = await validateCatalog({
      scope: "task",
      task: path.join(root, "missing.task.yaml"),
      cwd: root,
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === "task.load_error")).toBe(true);
  });

  it("throws when task scope omits task path", async () => {
    await expect(validateCatalog({ scope: "task", cwd: fixtures })).rejects.toThrow(
      /task is required/i,
    );
  });
});

describe("validateCatalog legacy fixtures", () => {
  it.skip("full fixtures catalog cwd scan — legacy S7", async () => {
    const result = await validateCatalog({
      scope: "full",
      cwd: fixtures,
    });
    expect(result.ok).toBe(false);
    expect(findingCodes(result.findings)).toContain("pipeline.missing_stage");
    expect(findingCodes(result.findings)).toContain("pipeline.dag_error");
  });

  it("full scope on project without manifest emits manifest_missing", async () => {
    clearFindProjectRootCacheForTests();
    const { root, cleanup } = await initTempGitRepo();
    try {
      const result = await validateCatalog({ scope: "full", cwd: root });
      expect(result.findings.some((f) => f.code === "catalog.manifest_missing")).toBe(
        true,
      );
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

async function writeInlinePipeline(
  root: string,
  options: { id?: string; mcp?: string[] } = {},
): Promise<string> {
  const id = options.id ?? "worker";
  const mcpLines =
    options.mcp === undefined
      ? []
      : options.mcp.length === 0
        ? ["    mcp: []"]
        : ["    mcp:", ...options.mcp.map((name) => `      - ${name}`)];
  const pipelinePath = path.join(root, `${id}.pipeline.yaml`);
  await writeFile(
    pipelinePath,
    [
      `id: ${id}`,
      "stages:",
      `  - id: ${id}`,
      "    system_prompt: test",
      "    model: anthropic/claude-sonnet-4-5",
      ...mcpLines,
      "",
    ].join("\n"),
  );
  return pipelinePath;
}

function catalogFindings(findings: ValidationFinding[]): ValidationFinding[] {
  return findings.filter((f) => f.code === "catalog.invalid_mcp");
}

describe("validateCatalog stage MCP catalog inspect", () => {
  it("AE6: no-mcp pipeline without .mcp.json has no catalog.invalid_mcp", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const pipelinePath = await writeInlinePipeline(root);
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(true);
      expect(catalogFindings(result.findings)).toHaveLength(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE4: listed name without .mcp.json reports catalog.invalid_mcp missing catalog", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const pipelinePath = await writeInlinePipeline(root, { mcp: ["github"] });
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      const mcpFindings = catalogFindings(result.findings);
      expect(mcpFindings.length).toBeGreaterThan(0);
      expect(mcpFindings[0]?.message).toMatch(/missing/i);
      expect(mcpFindings[0]?.message).toMatch(/\.mcp\.json/);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE5: unknown allowlist name reports catalog.invalid_mcp", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.test" } } }),
      );
      const pipelinePath = await writeInlinePipeline(root, { mcp: ["notion"] });
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      const mcpFindings = catalogFindings(result.findings);
      expect(mcpFindings.length).toBeGreaterThan(0);
      expect(mcpFindings[0]?.message).toMatch(/unknown/i);
      expect(mcpFindings[0]?.message).toContain("notion");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE3: reserved catalog key stageflow fails even when allowlists are empty", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { stageflow: { command: "npx" } } }),
      );
      const pipelinePath = await writeInlinePipeline(root);
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      const mcpFindings = catalogFindings(result.findings);
      expect(mcpFindings.length).toBeGreaterThan(0);
      expect(mcpFindings[0]?.message).toMatch(/reserved/i);
      expect(mcpFindings[0]?.message).toContain("stageflow");
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("invalid JSON in .mcp.json reports catalog.invalid_mcp", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(path.join(root, ".mcp.json"), "{ not json");
      const pipelinePath = await writeInlinePipeline(root);
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      expect(catalogFindings(result.findings).length).toBeGreaterThan(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("mcpServers as an array reports catalog.invalid_mcp", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: [{ name: "github" }] }),
      );
      const pipelinePath = await writeInlinePipeline(root);
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      expect(catalogFindings(result.findings).length).toBeGreaterThan(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("R6: known object entry validates without env interpolation", async () => {
    const { root, cleanup } = await initTempGitRepo();
    const prevToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            github: {
              type: "http",
              url: "https://api.github.com/mcp",
              headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
            },
          },
        }),
      );
      const pipelinePath = await writeInlinePipeline(root, { mcp: ["github"] });
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(true);
      expect(catalogFindings(result.findings)).toHaveLength(0);
    } finally {
      if (prevToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = prevToken;
      }
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("single.pipeline.yaml validates with no mcp and no repo-root catalog file", async () => {
    clearFindProjectRootCacheForTests();
    const result = await validatePipeline(SINGLE_PIPELINE, { cwd: REPO_ROOT });
    expect(result.findings.some((f) => f.code === "catalog.invalid_mcp")).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("single-style pipeline validates against a well-formed catalog with no reserved key", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
      );
      const pipelinePath = await writeInlinePipeline(root);
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(true);
      expect(catalogFindings(result.findings)).toHaveLength(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("missing project root with a non-empty allowlist reports catalog.invalid_mcp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-nogit-"));
    try {
      const pipelinePath = await writeInlinePipeline(root, { mcp: ["github"] });
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(false);
      expect(catalogFindings(result.findings).length).toBeGreaterThan(0);
    } finally {
      clearFindProjectRootCacheForTests();
    }
  });

  it("empty mcp list without .mcp.json has no catalog.invalid_mcp", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      const pipelinePath = await writeInlinePipeline(root, { mcp: [] });
      clearFindProjectRootCacheForTests();
      const result = await validatePipeline(pipelinePath, { cwd: root });
      expect(result.ok).toBe(true);
      expect(catalogFindings(result.findings)).toHaveLength(0);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});
