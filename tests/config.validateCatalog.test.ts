import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPipelines } from "../src/config/listConfig.js";
import { loadPipelineValidated } from "../src/config/loadPipeline.js";
import {
  buildValidationResult,
  validateCatalog,
  type ValidationFinding,
} from "../src/config/validateCatalog.js";
import * as validateCatalogModule from "../src/config/validateCatalog.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturesStagesDir = path.join(fixtures, "stages");

async function writeCatalog(
  root: string,
  files: { pipelines?: Record<string, string>; stages?: Record<string, string> },
): Promise<void> {
  if (files.pipelines) {
    const pipelinesDir = path.join(root, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    for (const [name, content] of Object.entries(files.pipelines)) {
      await writeFile(path.join(pipelinesDir, name), content);
    }
  }
  if (files.stages) {
    const stagesDir = path.join(root, "stages");
    await mkdir(stagesDir, { recursive: true });
    for (const [name, content] of Object.entries(files.stages)) {
      await writeFile(path.join(stagesDir, name), content);
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

  it("summarizeFindings treats orphan warnings as errors under strict", () => {
    const findings: ValidationFinding[] = [
      {
        severity: "warning",
        code: "catalog.orphan_stage",
        path: "stages/unused.yaml",
        message: "orphan",
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
        path: "pipelines/broken.yaml",
        message: "missing",
        category: "pipeline",
      },
      {
        severity: "warning",
        code: "catalog.orphan_stage",
        path: "stages/unused.yaml",
        message: "orphan",
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

describe("validateCatalog", () => {
  it("AE-S1-1: full catalog surfaces missing stage on broken.yaml", async () => {
    const result = await validateCatalog({
      scope: "full",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(false);
    const brokenFindings = findingsForPath(result.findings, "pipelines/broken.yaml");
    expect(brokenFindings.some((f) => f.severity === "error")).toBe(true);
    expect(
      brokenFindings.some(
        (f) => f.severity === "error" && /missing stage/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("AE-S1-2: targeted docs-only passes with broken sibling in catalog", async () => {
    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: "docs-only",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.path.includes("broken.yaml"))).toBe(false);
  });

  it("AE-S5-3: targeted validate agrees with loadPipelineValidated for docs-only", async () => {
    const validateResult = await validateCatalog({
      scope: "pipeline",
      pipeline: "docs-only",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    const loadResult = await loadPipelineValidated("docs-only", {
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(validateResult.ok).toBe(true);
    expect(loadResult.ok).toBe(true);
    expect(validateResult.findings.some((f) => f.path.includes("broken.yaml"))).toBe(false);
  });

  it("AE-S1-3: orphan stage warns by default and fails under strict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-orphan-"));
    await writeCatalog(root, {
      pipelines: {
        "alpha.yaml": [
          "id: alpha",
          "stages:",
          "  - used",
          "",
        ].join("\n"),
      },
      stages: {
        "used.yaml": validStageYaml("used"),
        "unused.yaml": validStageYaml("unused"),
      },
    });

    const defaultResult = await validateCatalog({ scope: "full", cwd: root });
    expect(defaultResult.ok).toBe(true);
    expect(
      defaultResult.findings.some(
        (f) => f.code === "catalog.orphan_stage" && f.path === "stages/unused.yaml",
      ),
    ).toBe(true);

    const strictResult = await validateCatalog({ scope: "full", cwd: root, strict: true });
    expect(strictResult.ok).toBe(false);
    expect(strictResult.summary.errors).toBeGreaterThanOrEqual(1);
    expect(
      strictResult.findings.find((f) => f.code === "catalog.orphan_stage")?.severity,
    ).toBe("warning");
  });

  it("AE-S1-4: stage id must match filename stem", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-id-mismatch-"));
    await writeCatalog(root, {
      pipelines: {
        "mismatch.yaml": [
          "id: mismatch",
          "stages:",
          "  - wrong-id",
          "",
        ].join("\n"),
      },
      stages: {
        "wrong-id.yaml": validStageYaml("other"),
      },
    });

    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: "mismatch",
      cwd: root,
    });
    expect(result.ok).toBe(false);
    const mismatch = result.findings.find((f) => f.code === "stage.id_filename_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.path).toBe("stages/wrong-id.yaml");
    expect(mismatch?.message).toMatch(/other/);
    expect(mismatch?.message).toMatch(/wrong-id/);
  });

  it("AE-S1-5: duplicate pipeline id across files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-dup-id-"));
    await writeCatalog(root, {
      pipelines: {
        "one.yaml": [
          "id: shared",
          "stages:",
          "  - alpha",
          "",
        ].join("\n"),
        "two.yaml": [
          "id: shared",
          "stages:",
          "  - alpha",
          "",
        ].join("\n"),
      },
      stages: {
        "alpha.yaml": validStageYaml("alpha"),
      },
    });

    const result = await validateCatalog({ scope: "full", cwd: root });
    expect(result.ok).toBe(false);
    const dupFindings = result.findings.filter(
      (f) => f.code === "catalog.duplicate_pipeline_id",
    );
    expect(dupFindings).toHaveLength(2);
    expect(dupFindings.map((f) => f.path).sort()).toEqual([
      "pipelines/one.yaml",
      "pipelines/two.yaml",
    ]);
  });

  it("AE-S1-6: full catalog scans all pipelines including invalid ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-multi-"));
    await writeCatalog(root, {
      pipelines: {
        "valid.yaml": [
          "id: valid",
          "stages:",
          "  - alpha",
          "",
        ].join("\n"),
        "bad-shape.yaml": "not_a_pipeline: true\n",
        "missing-stage.yaml": [
          "id: missing-stage",
          "stages:",
          "  - ghost",
          "",
        ].join("\n"),
      },
      stages: {
        "alpha.yaml": validStageYaml("alpha"),
      },
    });

    const result = await validateCatalog({ scope: "full", cwd: root });
    expect(result.ok).toBe(false);
    expect(findingsForPath(result.findings, "pipelines/bad-shape.yaml").length).toBeGreaterThan(
      0,
    );
    expect(
      findingsForPath(result.findings, "pipelines/missing-stage.yaml").some((f) =>
        /missing stage/i.test(f.message),
      ),
    ).toBe(true);
    expect(
      findingsForPath(result.findings, "pipelines/valid.yaml").filter(
        (f) => f.severity === "error",
      ),
    ).toHaveLength(0);
  });

  it("AE-S1-7: cycle-referenced stages are not orphans and stages are validated", async () => {
    const result = await validateCatalog({
      scope: "full",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    const cycleFindings = findingsForPath(result.findings, "pipelines/cycle.yaml");
    expect(cycleFindings.some((f) => f.severity === "error" && /cycle/i.test(f.message))).toBe(
      true,
    );
    expect(
      result.findings.some(
        (f) => f.code === "catalog.orphan_stage" && f.path === "stages/clarify.yaml",
      ),
    ).toBe(false);
    expect(
      result.findings.some(
        (f) => f.code === "catalog.orphan_stage" && f.path === "stages/design-doc.yaml",
      ),
    ).toBe(false);
  });

  it("full fixtures catalog does not throw and reports known broken pipelines", async () => {
    const result = await validateCatalog({
      scope: "full",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(false);
    expect(findingCodes(result.findings)).toContain("pipeline.missing_stage");
    expect(findingCodes(result.findings)).toContain("pipeline.dag_error");
  });

  it("cycle pipeline produces pipeline.dag_error", async () => {
    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: "cycle",
      cwd: fixtures,
      stagesDir: fixturesStagesDir,
    });
    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (f) => f.code === "pipeline.dag_error" && /cycle/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("empty project returns ok with no findings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-empty-"));
    const result = await validateCatalog({ scope: "full", cwd: root });
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toEqual({ errors: 0, warnings: 0 });
  });

  it("throws when pipeline scope omits pipeline name", async () => {
    await expect(
      validateCatalog({ scope: "pipeline", cwd: fixtures }),
    ).rejects.toThrow(/pipeline is required/i);
  });

  it("respects custom stagesDir option", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-validate-stages-dir-"));
    const customStages = path.join(root, "custom-stages");
    await writeCatalog(root, {
      pipelines: {
        "alpha.yaml": [
          "id: alpha",
          "stages:",
          "  - beta",
          "",
        ].join("\n"),
      },
    });
    await mkdir(customStages, { recursive: true });
    await writeFile(path.join(customStages, "beta.yaml"), validStageYaml("beta"));

    const result = await validateCatalog({
      scope: "pipeline",
      pipeline: "alpha",
      cwd: root,
      stagesDir: customStages,
    });
    expect(result.ok).toBe(true);
  });

  it("listPipelines behavior is unchanged", async () => {
    const pipelines = await listPipelines(fixtures);
    const ids = pipelines.map((p) => p.id).sort();
    expect(ids).toContain("docs-only");
    expect(ids).not.toContain("broken");
    expect(ids).not.toContain("cycle");
  });
});
