import { describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ValidationResult } from "../src/config/validateCatalog.js";
import { runValidateCommand } from "../src/cli/validateCommand.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import {
  exitCodeForValidation,
  formatValidationHuman,
  formatValidationJson,
} from "../src/cli/validateOutput.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.ts");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fixtures = path.join(root, "tests", "fixtures");
const manifestCatalog = path.join(fixtures, "manifest-catalog");
const demoPipeline = path.join(manifestCatalog, "pipelines", "demo.pipeline.yaml");

function runCli(args: string[], cwd = fixtures) {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

const validStageYaml = (id: string) =>
  [
    `id: ${id}`,
    "system_prompt: test",
    "model: anthropic/claude-sonnet-4-5",
    "",
  ].join("\n");

async function writeCatalog(
  catalogRoot: string,
  files: { pipelines?: Record<string, string>; stages?: Record<string, string> },
): Promise<void> {
  if (files.pipelines) {
    const pipelinesDir = path.join(catalogRoot, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    for (const [name, content] of Object.entries(files.pipelines)) {
      await writeFile(path.join(pipelinesDir, name), content);
    }
  }
  if (files.stages) {
    const stagesDir = path.join(catalogRoot, "stages");
    await mkdir(stagesDir, { recursive: true });
    for (const [name, content] of Object.entries(files.stages)) {
      await writeFile(path.join(stagesDir, name), content);
    }
  }
}

function cannedResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    scope: "full",
    ok: true,
    summary: { errors: 0, warnings: 0 },
    findings: [],
    ...overrides,
  };
}

describe("runValidateCommand", () => {
  it("calls validateCatalog with full scope by default", async () => {
    const validateCatalog = vi.fn(async () => cannedResult());
    const cwd = "/tmp/project";
    const code = await runValidateCommand([], {
      cwd,
      validateCatalog,
      io: { log: () => undefined, error: () => undefined },
    });
    expect(code).toBe(0);
    expect(validateCatalog).toHaveBeenCalledWith({
      scope: "full",
      cwd,
      pipeline: undefined,
      task: undefined,
      strict: false,
    });
  });

  it("passes pipeline scope for --pipeline docs-only", async () => {
    const validateCatalog = vi.fn(async () => cannedResult({ scope: "pipeline" }));
    const cwd = "/tmp/project";
    const code = await runValidateCommand(["--pipeline", demoPipeline], {
      cwd,
      validateCatalog,
      io: { log: () => undefined, error: () => undefined },
    });
    expect(code).toBe(0);
    expect(validateCatalog).toHaveBeenCalledWith({
      scope: "pipeline",
      cwd,
      pipeline: demoPipeline,
      task: undefined,
      strict: false,
    });
  });

  it("passes strict: true when --strict is set", async () => {
    const validateCatalog = vi.fn(async () => cannedResult());
    const cwd = "/tmp/project";
    await runValidateCommand(["--strict"], {
      cwd,
      validateCatalog,
      io: { log: () => undefined, error: () => undefined },
    });
    expect(validateCatalog).toHaveBeenCalledWith({
      scope: "full",
      cwd,
      pipeline: undefined,
      task: undefined,
      strict: true,
    });
  });

  it("passes task scope for --task", async () => {
    const validateCatalog = vi.fn(async () => cannedResult({ scope: "task" }));
    const cwd = "/tmp/project";
    const taskPath = "/tmp/project/tasks/hello.task.yaml";
    const code = await runValidateCommand(["--task", taskPath], {
      cwd,
      validateCatalog,
      io: { log: () => undefined, error: () => undefined },
    });
    expect(code).toBe(0);
    expect(validateCatalog).toHaveBeenCalledWith({
      scope: "task",
      cwd,
      pipeline: undefined,
      task: taskPath,
      strict: false,
    });
  });

  it("AE5: rejects both --pipeline and --task", async () => {
    const errors: string[] = [];
    const code = await runValidateCommand(
      ["--pipeline", "a.yaml", "--task", "b.yaml"],
      {
        cwd: fixtures,
        io: { log: () => undefined, error: (line) => errors.push(line) },
      },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/at most one/i);
  });

  it("--task without value exits non-zero", async () => {
    const errors: string[] = [];
    const code = await runValidateCommand(["--task"], {
      cwd: fixtures,
      io: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/Missing value for --task/);
  });

  it("prints JSON only to stdout in --json mode", async () => {
    const result = cannedResult({
      ok: false,
      summary: { errors: 1, warnings: 0 },
      findings: [
        {
          severity: "error",
          code: "pipeline.missing_stage",
          path: "pipelines/broken.pipeline.yaml",
          message: "missing stage",
          category: "pipeline",
        },
      ],
    });
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runValidateCommand(["--json"], {
      cwd: fixtures,
      validateCatalog: async () => result,
      io: {
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      },
    });
    expect(code).toBe(1);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(() => JSON.parse(logs[0]!)).not.toThrow();
    expect(logs[0]).not.toMatch(/Validation passed/);
  });
});

describe("formatValidationHuman", () => {
  it("groups findings by path with errors before warnings within a file", () => {
    const result = cannedResult({
      ok: false,
      summary: { errors: 1, warnings: 1 },
      findings: [
        {
          severity: "warning",
          code: "catalog.orphan_stage",
          path: "stages/a.yaml",
          message: "warn-a",
          category: "catalog",
        },
        {
          severity: "error",
          code: "stage.load_error",
          path: "stages/a.yaml",
          message: "err-a",
          category: "stage",
        },
        {
          severity: "error",
          code: "pipeline.missing_stage",
          path: "pipelines/b.yaml",
          message: "err-b",
          category: "pipeline",
        },
      ],
    });
    const output = formatValidationHuman(result);
    expect(output).toMatch(/Scope: catalog YAML/);
    expect(output.indexOf("stages/a.yaml")).toBeLessThan(output.indexOf("pipelines/b.yaml"));
    const aSection = output.slice(
      output.indexOf("stages/a.yaml"),
      output.indexOf("pipelines/b.yaml"),
    );
    expect(aSection.indexOf("error: err-a")).toBeLessThan(aSection.indexOf("warning: warn-a"));
    expect(output).toMatch(/Validation failed: 1 error\(s\), 1 warning\(s\)\./);
  });

  it("prints Validation passed for empty findings", () => {
    const output = formatValidationHuman(cannedResult());
    expect(output).toMatch(/Validation passed\./);
  });

  it("promotes manifest_missing warning to error under strict", () => {
    const result = cannedResult({
      ok: false,
      summary: { errors: 1, warnings: 0 },
      findings: [
        {
          severity: "warning",
          code: "catalog.manifest_missing",
          path: "stageflow.yaml",
          message: "No catalog manifest",
          category: "catalog",
        },
      ],
    });
    const output = formatValidationHuman(result, { strict: true });
    expect(output).toMatch(/error: No catalog manifest/);
    expect(output).not.toMatch(/warning: No catalog manifest/);
  });
});

describe("formatValidationJson and exitCodeForValidation", () => {
  it("emits ok, summary, and findings with file mapped from path", () => {
    const result = cannedResult({
      ok: false,
      summary: { errors: 1, warnings: 0 },
      findings: [
        {
          severity: "error",
          code: "pipeline.dag_error",
          path: "pipelines/cycle.pipeline.yaml",
          message: "dependency cycle",
          category: "pipeline",
        },
      ],
    });
    const parsed = JSON.parse(formatValidationJson(result)) as {
      ok: boolean;
      scope: string;
      checks: string;
      summary: { errors: number; warnings: number };
      findings: Array<{
        severity: string;
        category: string;
        code: string;
        file: string;
        message: string;
      }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.scope).toBe("full");
    expect(parsed.checks).toMatch(
      /catalog YAML \(pipelines, stages, tasks as selected by flags\)/,
    );
    expect(parsed.summary).toEqual({ errors: 1, warnings: 0 });
    expect(parsed.findings[0]).toEqual({
      severity: "error",
      category: "pipeline",
      code: "pipeline.dag_error",
      file: "pipelines/cycle.pipeline.yaml",
      message: "dependency cycle",
    });
  });

  it("maps exit codes from result.ok", () => {
    expect(exitCodeForValidation(cannedResult())).toBe(0);
    expect(
      exitCodeForValidation(
        cannedResult({ ok: false, summary: { errors: 1, warnings: 0 } }),
      ),
    ).toBe(1);
  });
});

describe("sf validate integration", { timeout: 30_000 }, () => {
  it("AE-S2-2: manifest-all reports broken pipeline in catalog", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = runCli(["validate"], root);
      expect(result.status).toBe(1);
      const out = result.stdout + result.stderr;
      expect(out).toMatch(/invalid|error/i);
      expect(out).toMatch(/broken/);
      expect(out).not.toMatch(/at Object/);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE-S2-3: targeted validate passes when sibling pipeline is broken", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const demoPath = path.join(root, "pipelines", "demo.pipeline.yaml");
      const result = runCli(["validate", "--pipeline", demoPath], root);
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toMatch(/Validation passed/);
      expect(out).not.toMatch(/broken\.pipeline\.yaml/);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE-S2-5: JSON output reports duplicate pipeline id failure", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await cp(manifestCatalog, root, { recursive: true });
      clearFindProjectRootCacheForTests();
      const result = runCli(["validate", "--json"], root);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        findings: Array<{ severity: string; file: string; message: string; code: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(
        parsed.findings.some(
          (finding) =>
            finding.severity === "error" &&
            finding.code === "catalog.duplicate_pipeline_id",
        ),
      ).toBe(true);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });

  it("AE-S2-4: manifest_missing warns by default and fails under strict", async () => {
    const catalogRoot = await mkdtemp(path.join(tmpdir(), "sf-validate-cli-orphan-"));
    await writeCatalog(catalogRoot, {
      pipelines: {
        "alpha.yaml": ["id: alpha", "stages:", "  - used", ""].join("\n"),
      },
      stages: {
        "used.yaml": validStageYaml("used"),
        "unused.yaml": validStageYaml("unused"),
      },
    });

    const defaultResult = runCli(["validate"], catalogRoot);
    expect(defaultResult.status).toBe(0);
    const defaultOut = defaultResult.stdout + defaultResult.stderr;
    expect(defaultOut).toMatch(/warning:/i);
    expect(defaultOut).toMatch(/manifest/i);

    const strictResult = runCli(["validate", "--strict"], catalogRoot);
    expect(strictResult.status).toBe(1);
    const strictOut = strictResult.stdout + strictResult.stderr;
    expect(strictOut).toMatch(/error:/i);
    expect(strictOut).toMatch(/manifest/i);
  });

  it("AE-S2-1: full catalog pass with two valid pipelines", async () => {
    const { root, cleanup } = await initTempGitRepo();
    try {
      await writeFile(
        path.join(root, "stageflow.yaml"),
        [
          "version: 1",
          "catalog:",
          "  pipelines: [pipelines]",
          "  tasks: [tasks/placeholder.task.yaml]",
          "  patterns:",
          "    pipeline: \"*.pipeline.yaml\"",
          "    task: \"*.task.yaml\"",
          "",
        ].join("\n"),
      );
      await writeCatalog(root, {
        pipelines: {
          "alpha.pipeline.yaml": [
            "id: alpha",
            "stages:",
            "  - id: alpha-stage",
            "    system_prompt: test",
            "    model: anthropic/claude-sonnet-4-5",
            "",
          ].join("\n"),
          "beta.pipeline.yaml": [
            "id: beta",
            "stages:",
            "  - id: beta-stage",
            "    system_prompt: test",
            "    model: anthropic/claude-sonnet-4-5",
            "",
          ].join("\n"),
        },
      });
      await mkdir(path.join(root, "tasks"), { recursive: true });
      await writeFile(
        path.join(root, "tasks/placeholder.task.yaml"),
        "id: t\ngoal: g\n",
      );
      clearFindProjectRootCacheForTests();
      const result = runCli(["validate"], root);
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Validation passed/);
    } finally {
      clearFindProjectRootCacheForTests();
      await cleanup();
    }
  });
});

describe("validateCommand module boundaries", () => {
  it("does not import run store or pipeline runner modules", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, "src", "cli", "validateCommand.ts"), "utf8"),
    );
    expect(source).not.toMatch(/createRunStore/);
    expect(source).not.toMatch(/runPipeline/);
    expect(source).not.toMatch(/loadTask/);
  });
});
