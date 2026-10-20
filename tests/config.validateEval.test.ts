import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEvalCatalog } from "../src/config/evalCatalog.js";
import { loadEvalOutcome, type LoadedEval } from "../src/config/loadEval.js";
import { loadStageflowManifestOutcome } from "../src/config/loadStageflowManifest.js";
import { resolveEvalTarget } from "../src/config/resolveEvalTarget.js";
import {
  buildValidationResult,
  validateCatalog,
  type ValidationFinding,
} from "../src/config/validateCatalog.js";
import { validateEval, type DatasetReport } from "../src/config/validateEval.js";
import { runValidateCommand } from "../src/cli/validateCommand.js";
import {
  ModelCatalog,
  resetModelCatalogsForTests,
  setModelCatalogForTests,
} from "../src/models/catalog.js";
import { clearFindProjectRootCacheForTests } from "../src/project/findProjectRoot.js";
import { initTempGitRepo } from "./helpers/projectContext.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const EVAL_FIXTURES = path.join(FIXTURES_ROOT, "evals");

async function load(absPath: string, root: string): Promise<LoadedEval> {
  const outcome = await loadEvalOutcome(absPath, root);
  if (!outcome.ok) throw new Error(`load failed: ${outcome.issues.map((i) => i.message).join("; ")}`);
  return outcome.value;
}

const codes = (findings: ValidationFinding[]): string[] => findings.map((f) => f.code);

const DATASET_LINE = (id: string, diff = "diff --git a/x b/x") =>
  JSON.stringify({ id, input: { diff }, expected: { findings: ["null check"] } });

async function copyProject(root: string): Promise<void> {
  for (const dir of ["pipelines", "stages", "evals"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"), path.join(root, "pipelines", "feature-ship.pipeline.yaml"));
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await cp(path.join(EVAL_FIXTURES, "valid.eval.yaml"), path.join(root, "evals", "valid.eval.yaml"));
  await mkdir(path.join(root, "datasets"), { recursive: true });
  await writeFile(
    path.join(root, "datasets", "review-diffs.dataset.jsonl"),
    `${DATASET_LINE("c001")}\n${DATASET_LINE("c002")}\n`,
  );
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
  );
}

function reportFor(
  cases: DatasetReport["cases"],
  findings: ValidationFinding[] = [],
): DatasetReport {
  return {
    path: "/x/datasets/review-diffs.dataset.jsonl",
    relPath: "datasets/review-diffs.dataset.jsonl",
    cases,
    findings,
    contentHash: "abc",
  };
}

const caseOf = (id: string, input: Record<string, unknown> = { diff: "d" }, expected?: unknown) => ({
  id,
  input,
  ...(expected !== undefined ? { expected } : {}),
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-eval-validate-"));
  await copyProject(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("validateEval: the schema doc example", () => {
  it("has no findings when target and dataset resolve", async () => {
    const loaded = await load(path.join(root, "evals", "valid.eval.yaml"), root);
    expect(await validateEval(loaded, { projectRoot: root })).toEqual([]);
  });

  it("has no findings with a clean dataset report", async () => {
    const loaded = await load(path.join(root, "evals", "valid.eval.yaml"), root);
    const report = reportFor([
      caseOf("c001", { diff: "a" }, { findings: ["x"] }),
      caseOf("c002", { diff: "b" }, { findings: ["y"] }),
    ]);
    expect(await validateEval(loaded, { projectRoot: root, datasetReport: report })).toEqual([]);
  });
});

describe("validateEval: target findings", () => {
  it("eval.target_unresolved names what failed", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "target-unresolved.eval.yaml"), FIXTURES_ROOT);
    const findings = await validateEval(loaded, { projectRoot: FIXTURES_ROOT });
    const unresolved = findings.find((f) => f.code === "eval.target_unresolved");
    expect(unresolved?.severity).toBe("error");
    expect(unresolved?.category).toBe("eval");
    expect(unresolved?.path).toBe("evals/target-unresolved.eval.yaml");
    expect(unresolved?.message).toContain('"nope"');
    expect(unresolved?.message).toContain("pipelines/feature-ship.pipeline.yaml");
  });

  it("eval.target_unresolved for a missing pipeline file", async () => {
    const evalPath = path.join(root, "evals", "valid.eval.yaml");
    const text = (await import("node:fs")).readFileSync(evalPath, "utf8").replace("feature-ship", "nothing-here");
    await writeFile(evalPath, text);
    const findings = await validateEval(await load(evalPath, root), { projectRoot: root });
    expect(codes(findings)).toContain("eval.target_unresolved");
  });

  it("file-form targets resolve with the manifest model tier", async () => {
    const evalPath = path.join(root, "evals", "valid.eval.yaml");
    const text = (await import("node:fs"))
      .readFileSync(evalPath, "utf8")
      .replace(/target:\n {2}kind: stage\n {2}pipeline: .*\n {2}stage: review\n/, "target:\n  kind: stage\n  file: ../stages/review.yaml\n");
    await writeFile(evalPath, text);
    const loaded = await load(evalPath, root);
    const resolved = await resolveEvalTarget(loaded.file, loaded.path, root);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.modelResolved).toBe("anthropic/claude-haiku-4-5");
    expect(resolved.value.modelTier).toBe("stage");
    expect(resolved.value.file).toBe(path.join(root, "stages", "review.yaml"));
    expect(resolved.value.pipelinePath).toBeUndefined();
    expect(resolved.value.inputSchema).toBeDefined();
    expect(resolved.value.outputSchema).toBeDefined();
  });

  it("pipeline-form targets use the pipeline tier when the stage has no model", async () => {
    await writeFile(
      path.join(root, "pipelines", "tiered.pipeline.yaml"),
      [
        "id: tiered",
        "model: anthropic/claude-sonnet-4-5",
        "stages:",
        "  - id: inline",
        "    system_prompt: hi",
        "    io:",
        "      input: { schema: { type: object } }",
        "      output: { schema: { type: object } }",
        "",
      ].join("\n"),
    );
    const evalPath = path.join(root, "evals", "valid.eval.yaml");
    const text = (await import("node:fs"))
      .readFileSync(evalPath, "utf8")
      .replace("feature-ship", "tiered")
      .replace("stage: review", "stage: inline");
    await writeFile(evalPath, text);
    const loaded = await load(evalPath, root);
    const resolved = await resolveEvalTarget(loaded.file, loaded.path, root);
    expect(resolved.ok && resolved.value.modelTier).toBe("pipeline");
    expect(resolved.ok && resolved.value.modelResolved).toBe("anthropic/claude-sonnet-4-5");
  });

  it("stage version hash is stable across loads and changes with system_prompt", async () => {
    const loaded = await load(path.join(root, "evals", "valid.eval.yaml"), root);
    const first = await resolveEvalTarget(loaded.file, loaded.path, root);
    const second = await resolveEvalTarget(loaded.file, loaded.path, root);
    if (!first.ok || !second.ok) throw new Error("expected resolve");
    expect(first.value.stageVersionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.value.stageVersionHash).toBe(second.value.stageVersionHash);

    const stagePath = path.join(root, "stages", "review.yaml");
    const original = (await import("node:fs")).readFileSync(stagePath, "utf8");
    await writeFile(stagePath, original.replace("list defects.", "list defects and risks."));
    const changed = await resolveEvalTarget(loaded.file, loaded.path, root);
    if (!changed.ok) throw new Error("expected resolve");
    expect(changed.value.stageVersionHash).not.toBe(first.value.stageVersionHash);
  });

  it("eval.schema_grader_without_output_schema when the stage declares no io", async () => {
    await writeFile(
      path.join(root, "stages", "review.yaml"),
      "id: review\nsystem_prompt: hi\nmodel: anthropic/claude-haiku-4-5\n",
    );
    const findings = await validateEval(await load(path.join(root, "evals", "valid.eval.yaml"), root), {
      projectRoot: root,
    });
    const hit = findings.find((f) => f.code === "eval.schema_grader_without_output_schema");
    expect(hit?.severity).toBe("error");
  });

  it("eval.stage_has_gates warns when the stage declares gate_kinds", async () => {
    const stagePath = path.join(root, "stages", "review.yaml");
    const original = (await import("node:fs")).readFileSync(stagePath, "utf8");
    await writeFile(stagePath, `${original}gate_kinds: [confirm]\n`);
    const findings = await validateEval(await load(path.join(root, "evals", "valid.eval.yaml"), root), {
      projectRoot: root,
    });
    expect(findings.find((f) => f.code === "eval.stage_has_gates")?.severity).toBe("warning");
  });

  it("eval.stage_needs_checkout warns when the stage verifies checkout changes", async () => {
    const stagePath = path.join(root, "stages", "review.yaml");
    const original = (await import("node:fs")).readFileSync(stagePath, "utf8");
    await writeFile(
      stagePath,
      `${original}verify:\n  - id: changed\n    type: checkout_changes\n    when: [after]\n`,
    );
    const findings = await validateEval(await load(path.join(root, "evals", "valid.eval.yaml"), root), {
      projectRoot: root,
    });
    expect(findings.find((f) => f.code === "eval.stage_needs_checkout")?.severity).toBe("warning");
  });
});

describe("validateEval: judge findings", () => {
  it("eval.judge_missing", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "judge-missing.eval.yaml"), FIXTURES_ROOT);
    const findings = await validateEval(loaded, { projectRoot: FIXTURES_ROOT });
    expect(findings.find((f) => f.code === "eval.judge_missing")?.severity).toBe("error");
  });

  it("eval.judge_unknown_model warns once per unknown id", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "judge-unknown-model.eval.yaml"), FIXTURES_ROOT);
    const findings = await validateEval(loaded, {
      projectRoot: FIXTURES_ROOT,
      isKnownModel: async () => false,
    });
    const hits = findings.filter((f) => f.code === "eval.judge_unknown_model");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("warning");
    expect(hits[0]?.message).toContain("nowhere/no-such-model");
  });

  it("no unknown-model warning for a known judge or when no catalog is supplied", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "judge-unknown-model.eval.yaml"), FIXTURES_ROOT);
    expect(codes(await validateEval(loaded, { projectRoot: FIXTURES_ROOT, isKnownModel: async () => true }))).not.toContain(
      "eval.judge_unknown_model",
    );
    expect(codes(await validateEval(loaded, { projectRoot: FIXTURES_ROOT }))).not.toContain(
      "eval.judge_unknown_model",
    );
  });

  it("eval.judge_same_as_stage compares the judge with the effective stage model", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "judge-same-as-stage.eval.yaml"), FIXTURES_ROOT);
    const findings = await validateEval(loaded, { projectRoot: FIXTURES_ROOT });
    expect(findings.find((f) => f.code === "eval.judge_same_as_stage")?.severity).toBe("warning");
  });

  it("defaults.model changes which model the judge is compared with", async () => {
    const evalPath = path.join(root, "evals", "valid.eval.yaml");
    const text = (await import("node:fs"))
      .readFileSync(evalPath, "utf8")
      .replace("  concurrency: 4", "  concurrency: 4\n  model: anthropic/claude-sonnet-4-5");
    await writeFile(evalPath, text);
    const findings = await validateEval(await load(evalPath, root), { projectRoot: root });
    expect(codes(findings).filter((c) => c === "eval.judge_same_as_stage")).toHaveLength(2);
  });
});

describe("validateEval: dataset file", () => {
  it("eval.dataset_unresolved when the file is missing", async () => {
    const loaded = await load(path.join(EVAL_FIXTURES, "dataset-unresolved.eval.yaml"), FIXTURES_ROOT);
    const findings = await validateEval(loaded, { projectRoot: FIXTURES_ROOT });
    expect(findings.find((f) => f.code === "eval.dataset_unresolved")?.severity).toBe("error");
  });

  it("eval.dataset_unresolved when a symlink points outside the project", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "sf-eval-outside-"));
    try {
      await writeFile(path.join(outside, "x.dataset.jsonl"), `${DATASET_LINE("c001")}\n`);
      const link = path.join(root, "datasets", "review-diffs.dataset.jsonl");
      await rm(link);
      (await import("node:fs")).symlinkSync(path.join(outside, "x.dataset.jsonl"), link);
      const loaded = await load(path.join(root, "evals", "valid.eval.yaml"), root);
      const findings = await validateEval(loaded, { projectRoot: root });
      expect(findings.find((f) => f.code === "eval.dataset_unresolved")?.message).toContain("outside");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("validateEval: dataset-dependent findings (fake report; story 03 supplies real ones)", () => {
  async function findingsWith(report: DatasetReport, edit?: (text: string) => string) {
    const evalPath = path.join(root, "evals", "valid.eval.yaml");
    if (edit) {
      const text = (await import("node:fs")).readFileSync(evalPath, "utf8");
      await writeFile(evalPath, edit(text));
    }
    return validateEval(await load(evalPath, root), { projectRoot: root, datasetReport: report });
  }

  it("eval.dataset_invalid summarizes the dataset's own error findings", async () => {
    const report = reportFor([caseOf("c001", { diff: "d" }, { findings: ["x"] })], [
      {
        severity: "error",
        code: "dataset.case_missing_id",
        path: "datasets/review-diffs.dataset.jsonl",
        message: "line 3 has no id",
        category: "catalog",
      },
    ]);
    const findings = await findingsWith(report);
    const hit = findings.find((f) => f.code === "eval.dataset_invalid");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("line 3 has no id");
  });

  it("dataset warnings alone do not make the dataset invalid", async () => {
    const report = reportFor([caseOf("c001", { diff: "d" }, { findings: ["x"] })], [
      {
        severity: "warning",
        code: "dataset.input_mismatch",
        path: "datasets/review-diffs.dataset.jsonl",
        message: "x",
        category: "catalog",
      },
    ]);
    expect(codes(await findingsWith(report))).not.toContain("eval.dataset_invalid");
  });

  it("eval.cases_skipped counts cases failing io.input.schema and names the first", async () => {
    const report = reportFor([
      caseOf("c001", { diff: "d" }, { findings: ["x"] }),
      caseOf("c002", { diff: 7 }, { findings: ["x"] }),
      caseOf("c003", {}, { findings: ["x"] }),
    ]);
    const findings = await findingsWith(report);
    const hit = findings.find((f) => f.code === "eval.cases_skipped");
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toContain("2 case(s)");
    expect(hit?.message).toContain("c002");
    expect(codes(findings)).not.toContain("eval.no_valid_cases");
  });

  it("eval.no_valid_cases when every case is skipped", async () => {
    const report = reportFor([caseOf("c001", { diff: 1 }, { findings: ["x"] })]);
    const findings = await findingsWith(report);
    expect(findings.find((f) => f.code === "eval.no_valid_cases")?.severity).toBe("error");
    expect(codes(findings)).toContain("eval.cases_skipped");
  });

  it("eval.no_valid_cases for an empty dataset", async () => {
    expect(codes(await findingsWith(reportFor([])))).toContain("eval.no_valid_cases");
  });

  it("eval.cases_missing_expected warns per reference grader", async () => {
    const report = reportFor([
      caseOf("c001", { diff: "d" }, { findings: ["x"] }),
      caseOf("c002", { diff: "d" }, { other: 1 }),
      caseOf("c003", { diff: "d" }),
    ]);
    const hit = (await findingsWith(report)).find((f) => f.code === "eval.cases_missing_expected");
    expect(hit?.severity).toBe("warning");
    expect(hit?.message).toContain("2 of 3");
    expect(hit?.message).toContain("c002");
  });

  it("eval.large_run above 500 results and eval.too_large_run above 5000", async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => caseOf(`c${i}`, { diff: "d" }, { findings: ["x"] }));
    const large = await findingsWith(reportFor(many(200))); // 200 x 3 = 600
    expect(large.find((f) => f.code === "eval.large_run")?.severity).toBe("warning");
    expect(codes(large)).not.toContain("eval.too_large_run");
    const tooLarge = await findingsWith(reportFor(many(1700))); // 1700 x 3 = 5100
    expect(tooLarge.find((f) => f.code === "eval.too_large_run")?.severity).toBe("error");
    expect(codes(tooLarge)).not.toContain("eval.large_run");
    const boundary = await findingsWith(reportFor(many(500)), (t) =>
      t.replace("repeats: 3", "repeats: 10"),
    ); // 5000 is allowed
    expect(codes(boundary)).toContain("eval.large_run");
    expect(codes(boundary)).not.toContain("eval.too_large_run");
  });
});

describe("loadEvalCatalog and duplicate ids", () => {
  it("two eval files with the same id each get eval.duplicate_id", async () => {
    const dupDir = path.join(root, "evals", "more");
    await mkdir(dupDir, { recursive: true });
    const text = (await import("node:fs")).readFileSync(path.join(root, "evals", "valid.eval.yaml"), "utf8");
    await writeFile(path.join(dupDir, "valid.eval.yaml"), text.replace(/\.\.\//g, "../../"));

    const manifest = await loadStageflowManifestOutcome(root);
    if (!manifest.ok) throw new Error("manifest");
    const entries = await loadEvalCatalog(manifest.value);
    expect(entries.map((e) => e.relPath)).toEqual(["evals/more/valid.eval.yaml", "evals/valid.eval.yaml"]);
    for (const entry of entries) {
      const dup = entry.findings.filter((f) => f.code === "eval.duplicate_id");
      expect(dup).toHaveLength(1);
      expect(dup[0]?.severity).toBe("error");
      expect(dup[0]?.path).toBe(entry.relPath);
    }
  });

  it("reports load failures as findings and keeps good evals", async () => {
    await cp(path.join(EVAL_FIXTURES, "unknown-key.eval.yaml"), path.join(root, "evals", "unknown-key.eval.yaml"));
    const manifest = await loadStageflowManifestOutcome(root);
    if (!manifest.ok) throw new Error("manifest");
    const entries = await loadEvalCatalog(manifest.value);
    const bad = entries.find((e) => e.relPath === "evals/unknown-key.eval.yaml");
    expect(bad?.outcome.ok).toBe(false);
    expect(codes(bad?.findings ?? [])).toEqual(["eval.unknown_key"]);
    const good = entries.find((e) => e.relPath === "evals/valid.eval.yaml");
    expect(good?.outcome.ok).toBe(true);
    expect(good?.findings).toEqual([]);
  });

  it("checks judges against the Host model catalog when it lists models", async () => {
    setModelCatalogForTests(
      root,
      new ModelCatalog({
        cwd: root,
        cursor: () => ({ connected: false, modelIds: [] }),
        createRuntime: async () => ({
          getProviders: () => [{ id: "anthropic" }],
          getProviderAuthStatus: () => ({ configured: true }),
          listCredentials: async () => [],
          getModels: () => [{ id: "claude-sonnet-4-5", provider: "anthropic" }],
          refresh: async () => undefined,
        }),
      }),
    );
    try {
      const evalPath = path.join(root, "evals", "valid.eval.yaml");
      const manifest = await loadStageflowManifestOutcome(root);
      if (!manifest.ok) throw new Error("manifest");
      expect((await loadEvalCatalog(manifest.value))[0]?.findings).toEqual([]);
      const text = (await import("node:fs")).readFileSync(evalPath, "utf8");
      await writeFile(evalPath, text.replace("judge: anthropic/claude-sonnet-4-5", "judge: nowhere/x"));
      const findings = (await loadEvalCatalog(manifest.value))[0]?.findings ?? [];
      expect(codes(findings)).toEqual(["eval.judge_unknown_model"]);
    } finally {
      resetModelCatalogsForTests();
    }
  });

  it("uses datasetReportFor when provided", async () => {
    const manifest = await loadStageflowManifestOutcome(root);
    if (!manifest.ok) throw new Error("manifest");
    const entries = await loadEvalCatalog(manifest.value, {
      datasetReportFor: async () => reportFor([]),
    });
    expect(codes(entries[0]?.findings ?? [])).toContain("eval.no_valid_cases");
  });
});

describe("sf validate integration", () => {
  async function gitProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const repo = await initTempGitRepo();
    clearFindProjectRootCacheForTests();
    await copyProject(repo.root);
    return { dir: repo.root, cleanup: repo.cleanup };
  }

  it("a clean eval project validates with no eval findings", async () => {
    const { dir, cleanup } = await gitProject();
    try {
      const result = await validateCatalog({ scope: "full", cwd: dir });
      expect(result.findings.filter((f) => f.category === "eval")).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("reports eval findings in the shared shape, in --json, and --strict promotes warnings", async () => {
    const { dir, cleanup } = await gitProject();
    try {
      await cp(path.join(EVAL_FIXTURES, "unknown-key.eval.yaml"), path.join(dir, "evals", "unknown-key.eval.yaml"));
      const stagePath = path.join(dir, "stages", "review.yaml");
      const original = (await import("node:fs")).readFileSync(stagePath, "utf8");
      await writeFile(stagePath, `${original}gate_kinds: [confirm]\n`);

      const result = await validateCatalog({ scope: "full", cwd: dir });
      expect(result.ok).toBe(false);
      const evalFindings = result.findings.filter((f) => f.category === "eval");
      expect(evalFindings.map((f) => [f.path, f.code, f.severity])).toEqual(
        expect.arrayContaining([
          ["evals/unknown-key.eval.yaml", "eval.unknown_key", "error"],
          ["evals/valid.eval.yaml", "eval.stage_has_gates", "warning"],
        ]),
      );

      const lines: string[] = [];
      const code = await runValidateCommand(["--json"], {
        cwd: dir,
        projectRoot: dir,
        io: { log: (line) => lines.push(line), error: () => undefined },
      });
      expect(code).toBe(1);
      const parsed = JSON.parse(lines.join("\n")) as { findings: Array<{ category: string; code: string; file: string }> };
      expect(parsed.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "eval", code: "eval.unknown_key", file: "evals/unknown-key.eval.yaml" }),
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  it("--strict fails on an eval warning that passes otherwise", async () => {
    const { dir, cleanup } = await gitProject();
    try {
      const stagePath = path.join(dir, "stages", "review.yaml");
      const original = (await import("node:fs")).readFileSync(stagePath, "utf8");
      await writeFile(stagePath, `${original}gate_kinds: [confirm]\n`);
      const relaxed = await validateCatalog({ scope: "full", cwd: dir });
      expect(relaxed.ok).toBe(true);
      expect(relaxed.summary.warnings).toBeGreaterThan(0);
      const strict = await validateCatalog({ scope: "full", cwd: dir, strict: true });
      expect(strict.ok).toBe(false);

      const lines: string[] = [];
      const code = await runValidateCommand(["--strict"], {
        cwd: dir,
        projectRoot: dir,
        io: { log: (line) => lines.push(line), error: () => undefined },
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("error: Target stage declares gate_kinds");
    } finally {
      await cleanup();
    }
  });

  it("buildValidationResult promotes an eval warning under strict only", () => {
    const warning: ValidationFinding = {
      severity: "warning",
      code: "eval.large_run",
      path: "evals/a.eval.yaml",
      message: "big",
      category: "eval",
    };
    expect(buildValidationResult("full", [warning], false).ok).toBe(true);
    expect(buildValidationResult("full", [warning], true).ok).toBe(false);
  });
});
