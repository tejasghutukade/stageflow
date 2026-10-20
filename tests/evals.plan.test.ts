import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { caseToTask } from "../src/evals/caseTask.js";
import { RUBRIC_PROMPT_VERSION } from "../src/evals/constants.js";
import { buildEvalPlan, type BuildEvalPlanInput, type EvalOverrides } from "../src/evals/plan.js";
import { buildComponents, computeFingerprint } from "../src/evals/snapshot.js";
import { PACKAGE_VERSION } from "../src/package-meta.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

let root: string;

const caseLine = (i: number, extra: Record<string, unknown> = {}, input: unknown = { diff: `diff ${i}` }) =>
  JSON.stringify({
    id: `c${String(i).padStart(3, "0")}`,
    input,
    expected: { findings: ["null check"] },
    tags: i % 2 === 0 ? ["even"] : ["odd"],
    ...extra,
  });

async function writeDataset(lines: string[]): Promise<void> {
  await writeFile(path.join(root, "datasets", "review-diffs.dataset.jsonl"), `${lines.join("\n")}\n`);
}

async function editFile(rel: string, edit: (text: string) => string): Promise<void> {
  const abs = path.join(root, rel);
  await writeFile(abs, edit(await readFile(abs, "utf8")));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sf-eval-plan-"));
  for (const dir of ["pipelines", "stages", "evals", "datasets"]) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await cp(path.join(FIXTURES_ROOT, "pipelines", "feature-ship.pipeline.yaml"), path.join(root, "pipelines", "feature-ship.pipeline.yaml"));
  await cp(path.join(FIXTURES_ROOT, "stages", "review.yaml"), path.join(root, "stages", "review.yaml"));
  await cp(path.join(FIXTURES_ROOT, "evals", "valid.eval.yaml"), path.join(root, "evals", "valid.eval.yaml"));
  await writeFile(
    path.join(root, "stageflow.yaml"),
    "version: 1\ncatalog:\n  pipelines:\n    - pipelines\n  tasks: []\n",
  );
  await writeDataset(Array.from({ length: 24 }, (_, i) => caseLine(i + 1)));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ENGINE = { name: "fake", version: "1.0.0", nodeVersion: "22.22.0" };

function build(overrides?: EvalOverrides, extra: Partial<BuildEvalPlanInput> = {}) {
  return buildEvalPlan({
    projectRoot: root,
    evalPath: "evals/valid.eval.yaml",
    evalRunId: "er_000000000001",
    ...(overrides ? { overrides } : {}),
    engine: ENGINE,
    ...extra,
  });
}

async function okBuild(overrides?: EvalOverrides, extra: Partial<BuildEvalPlanInput> = {}) {
  const result = await build(overrides, extra);
  if (!result.ok) throw new Error(`plan failed: ${result.findings.map((f) => f.message).join("; ")}`);
  return result;
}

const fingerprintOf = async (overrides?: EvalOverrides, extra: Partial<BuildEvalPlanInput> = {}) =>
  (await okBuild(overrides, extra)).fingerprint;

describe("buildEvalPlan: plan from files", () => {
  it("matches the file and applies defaults", async () => {
    const { plan, snapshot, findings } = await okBuild();
    expect(plan).toMatchObject({
      evalRunId: "er_000000000001",
      projectRoot: root,
      evalId: "valid",
      target: { kind: "stage", pipelinePath: "pipelines/feature-ship.pipeline.yaml", stageId: "review" },
      stageModel: "anthropic/claude-haiku-4-5",
      task: { goal: "Review the change and list defects." },
      repeats: 3,
      passThreshold: 0.8,
      concurrency: 4,
      maxCostUsd: 2,
      budget: { latencyMs: 300000, costUsd: 0.3 },
    });
    expect(plan.modelOverride).toBeUndefined();
    expect(plan.cases).toHaveLength(24);
    expect(plan.cases[0]).toMatchObject({ id: "c001", position: 0, tags: ["odd"] });
    expect(plan.graders.map((g) => g.id)).toEqual([
      "output-schema",
      "findings-cite-lines",
      "finds-expected-issues",
      "no-invented-files",
      "clear-and-actionable",
    ]);
    const rubric = plan.graders.find((g) => g.id === "clear-and-actionable");
    expect(rubric).toMatchObject({ type: "rubric", judge: "anthropic/claude-sonnet-4-5", passAt: 4 });
    expect(plan.outputSchema).toBeDefined();
    expect(plan.targetVersionHash).toBe(snapshot.target.stage_version_hash);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("fills the snapshot", async () => {
    const { snapshot, fingerprint, components } = await okBuild({}, { graderOrdinals: { "no-invented-files": 3 } });
    expect(snapshot.snapshot_version).toBe(1);
    expect(snapshot.eval).toMatchObject({ id: "valid", path: "evals/valid.eval.yaml" });
    expect(snapshot.eval.definition).toMatchObject({ defaults: { repeats: 3, concurrency: 4 }, dataset: "datasets/review-diffs.dataset.jsonl" });
    expect(snapshot.target).toMatchObject({
      kind: "stage",
      pipeline_path: "pipelines/feature-ship.pipeline.yaml",
      stage_id: "review",
      file: null,
      model: "anthropic/claude-haiku-4-5",
    });
    expect(snapshot.target.input_schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.target.stage_definition).toMatchObject({ id: "review" });
    expect(snapshot.dataset).toMatchObject({
      path: "datasets/review-diffs.dataset.jsonl",
      format: "jsonl",
      case_count: 24,
      cases_run: 24,
      cases_skipped: 0,
      skipped_case_ids: [],
    });
    expect(snapshot.graders.find((g) => g.id === "no-invented-files")).toMatchObject({
      version_ordinal: 3,
      weight: 2,
      must_pass: false,
    });
    expect(snapshot.graders.find((g) => g.id === "output-schema")?.version_ordinal).toBe(1);
    expect(snapshot.settings).toEqual({
      repeats: 3,
      pass_threshold: 0.8,
      judge: "anthropic/claude-sonnet-4-5",
      judge_same_as_stage: false,
      max_cost_usd: 2,
      concurrency: 4,
      suite_type: "capability",
    });
    expect(snapshot.engine).toEqual({ name: "fake", version: "1.0.0", rubric_prompt_version: RUBRIC_PROMPT_VERSION, node_version: "22.22.0" });
    expect(snapshot.stageflow_version).toBe(PACKAGE_VERSION);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(components.stage).toBe(snapshot.target.stage_version_hash);
    expect(components.graders["no-invented-files"]).toBe(snapshot.graders[3]?.hash);
  });

  it("stage-file targets carry the file and no pipeline", async () => {
    await editFile("evals/valid.eval.yaml", (t) =>
      t.replace("  pipeline: ../pipelines/feature-ship.pipeline.yaml\n  stage: review\n", "  file: ../stages/review.yaml\n"),
    );
    const { plan, snapshot } = await okBuild();
    expect(plan.target).toEqual({ kind: "stage", file: "stages/review.yaml" });
    expect(snapshot.target).toMatchObject({ pipeline_path: null, file: "stages/review.yaml" });
  });

  it("errors with EVAL_INVALID on a broken eval file", async () => {
    await editFile("evals/valid.eval.yaml", (t) => t.replace("version: 1", "version: 2"));
    const result = await build();
    expect(result).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(!result.ok && result.findings.map((f) => f.code)).toContain("eval.invalid_version");
  });
});

describe("buildEvalPlan: overrides", () => {
  it("repeats, max_cost_usd, judge and model change plan, settings and overrides", async () => {
    const { plan, snapshot } = await okBuild({
      repeats: 5,
      max_cost_usd: 7,
      judge: "openai/gpt-5",
      model: "anthropic/claude-sonnet-4-5",
    });
    expect(plan).toMatchObject({
      repeats: 5,
      maxCostUsd: 7,
      modelOverride: "anthropic/claude-sonnet-4-5",
      stageModel: "anthropic/claude-sonnet-4-5",
    });
    expect(plan.graders.filter((g) => g.type === "rubric").map((g) => g.type === "rubric" && g.judge)).toEqual([
      "openai/gpt-5",
      "openai/gpt-5",
    ]);
    expect(snapshot.overrides).toMatchObject({
      repeats: 5,
      max_cost_usd: 7,
      judge: "openai/gpt-5",
      model: "anthropic/claude-sonnet-4-5",
      case_ids: null,
      tags: null,
    });
    expect(snapshot.settings).toMatchObject({ repeats: 5, max_cost_usd: 7, judge: "openai/gpt-5" });
    expect(snapshot.target.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("a rubric grader with its own judge keeps it under a judge override", async () => {
    await editFile("evals/valid.eval.yaml", (t) =>
      t.replace("    rubric: A developer", "    judge: openai/own-judge\n    rubric: A developer"),
    );
    const { plan } = await okBuild({ judge: "openai/gpt-5" });
    const judges = plan.graders.flatMap((g) => (g.type === "rubric" ? [g.judge] : []));
    expect(judges).toEqual(["openai/gpt-5", "openai/own-judge"]);
  });

  it("judge_same_as_stage compares the judge with the model after the model override", async () => {
    const same = await okBuild({ model: "anthropic/claude-sonnet-4-5" });
    expect(same.snapshot.settings.judge_same_as_stage).toBe(true);
    expect(same.findings.map((f) => f.code)).toContain("eval.judge_same_as_stage");
    const different = await okBuild();
    expect(different.snapshot.settings.judge_same_as_stage).toBe(false);
  });

  it("an unknown case id errors", async () => {
    const result = await build({ case_ids: ["c001", "nope"] });
    expect(result).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(!result.ok && result.findings.some((f) => f.message.includes("nope"))).toBe(true);
  });

  it("case_ids keeps file order and records the override", async () => {
    const { plan, snapshot } = await okBuild({ case_ids: ["c010", "c003"] });
    expect(plan.cases.map((c) => c.id)).toEqual(["c003", "c010"]);
    expect(snapshot.overrides.case_ids).toEqual(["c010", "c003"]);
    expect(snapshot.dataset).toMatchObject({ case_count: 24, cases_run: 2 });
  });

  it("tags picks cases with any listed tag", async () => {
    await writeDataset([
      caseLine(1, { tags: ["a"] }),
      caseLine(2, { tags: ["b"] }),
      caseLine(3, { tags: ["c"] }),
      caseLine(4, { tags: ["a", "c"] }),
      caseLine(5, { tags: [] }),
    ]);
    const { plan, snapshot } = await okBuild({ tags: ["a", "b"] });
    expect(plan.cases.map((c) => c.id)).toEqual(["c001", "c002", "c004"]);
    expect(snapshot.overrides.tags).toEqual(["a", "b"]);
  });

  it("only_failed_from uses the supplied resolver", async () => {
    const asked: string[] = [];
    const { plan, snapshot } = await okBuild(
      { only_failed_from: "er_past" },
      {
        failedCaseIdsOf: (id) => {
          asked.push(id);
          return ["c005", "c001", "gone"];
        },
      },
    );
    expect(asked).toEqual(["er_past"]);
    expect(plan.cases.map((c) => c.id)).toEqual(["c001", "c005"]);
    expect(snapshot.overrides.only_failed_from).toBe("er_past");
  });

  it("only_failed_from errors when the resolver does not know the run", async () => {
    const result = await build({ only_failed_from: "er_x" }, { failedCaseIdsOf: () => undefined });
    expect(result.ok).toBe(false);
    const noResolver = await build({ only_failed_from: "er_x" });
    expect(noResolver.ok).toBe(false);
  });

  it("selections are mutually exclusive", async () => {
    for (const overrides of [
      { case_ids: ["c001"], tags: ["odd"] },
      { tags: ["odd"], only_failed_from: "er_x" },
      { case_ids: ["c001"], only_failed_from: "er_x" },
    ] satisfies EvalOverrides[]) {
      const result = await build(overrides, { failedCaseIdsOf: () => ["c001"] });
      expect(result).toMatchObject({ ok: false, code: "EVAL_INVALID" });
      expect(!result.ok && result.findings[0]?.message).toContain("mutually exclusive");
    }
  });

  it("rejects out-of-range overrides", async () => {
    for (const overrides of [{ repeats: 0 }, { repeats: 1.5 }, { max_cost_usd: 0 }, { judge: "" }] satisfies EvalOverrides[]) {
      expect((await build(overrides)).ok).toBe(false);
    }
  });
});

describe("buildEvalPlan: skipped cases and limits", () => {
  it("22 of 24 plan cases when 2 cases fail the input schema", async () => {
    await writeDataset(
      Array.from({ length: 24 }, (_, i) =>
        caseLine(i + 1, {}, i === 3 || i === 9 ? { diff: 42 } : { diff: "d" }),
      ),
    );
    const { plan, snapshot, skippedCaseIds, findings } = await okBuild();
    expect(plan.cases).toHaveLength(22);
    expect(skippedCaseIds).toEqual(["c004", "c010"]);
    expect(snapshot.dataset).toMatchObject({
      case_count: 24,
      cases_run: 22,
      cases_skipped: 2,
      skipped_case_ids: ["c004", "c010"],
    });
    expect(findings.find((f) => f.code === "eval.cases_skipped")?.severity).toBe("warning");
    expect(findings.filter((f) => f.code === "dataset.input_mismatch")).toHaveLength(2);
    expect(plan.cases.find((c) => c.id === "c005")?.position).toBe(4);
  });

  it("only invalid cases gives eval.no_valid_cases", async () => {
    await writeDataset(Array.from({ length: 6 }, (_, i) => caseLine(i + 1, {}, { diff: 1 })));
    const result = await build();
    expect(result).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(!result.ok && result.findings.map((f) => f.code)).toContain("eval.no_valid_cases");
  });

  it("a selection that leaves no valid case gives eval.no_valid_cases", async () => {
    const result = await build({ tags: ["nothing"] });
    expect(!result.ok && result.findings.map((f) => f.code)).toContain("eval.no_valid_cases");
  });

  it("repeats 11 is an error and returns no plan", async () => {
    const viaFile = await (async () => {
      await editFile("evals/valid.eval.yaml", (t) => t.replace("repeats: 3", "repeats: 11"));
      return build();
    })();
    expect(viaFile).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(await build({ repeats: 11 })).toMatchObject({ ok: false, code: "EVAL_INVALID" });
  });

  it("concurrency 9 is an error", async () => {
    await editFile("evals/valid.eval.yaml", (t) => t.replace("concurrency: 4", "concurrency: 9"));
    const result = await build();
    expect(result).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(!result.ok && result.findings.some((f) => f.code === "eval.invalid_field")).toBe(true);
  });

  it("results over 5,000 is an error; a selection that brings it down is allowed", async () => {
    await writeDataset(Array.from({ length: 600 }, (_, i) => caseLine(i + 1)));
    const over = await build({ repeats: 10 });
    expect(over).toMatchObject({ ok: false, code: "EVAL_INVALID" });
    expect(!over.ok && over.findings.map((f) => f.code)).toContain("eval.too_large_run");
    const ok = await okBuild({ repeats: 10, tags: ["odd"] });
    expect(ok.plan.cases).toHaveLength(300);
    expect(ok.findings.map((f) => f.code)).toContain("eval.large_run");
  });

  it("warns above 500 results using the effective repeats", async () => {
    await writeDataset(Array.from({ length: 200 }, (_, i) => caseLine(i + 1)));
    expect((await okBuild()).findings.map((f) => f.code)).toContain("eval.large_run");
    expect((await okBuild({ repeats: 1 })).findings.map((f) => f.code)).not.toContain("eval.large_run");
  });
});

describe("fingerprint", () => {
  it("is stable for identical inputs", async () => {
    expect(await fingerprintOf()).toBe(await fingerprintOf());
    expect(await fingerprintOf(undefined, { evalRunId: "er_other" })).toBe(await fingerprintOf());
  });

  it("changes with the stage prompt", async () => {
    const before = await fingerprintOf();
    await editFile("stages/review.yaml", (t) => t.replace("list defects", "list every defect"));
    expect(await fingerprintOf()).not.toBe(before);
  });

  it("changes with a dataset case", async () => {
    const before = await fingerprintOf();
    await writeDataset(Array.from({ length: 24 }, (_, i) => caseLine(i + 1, i === 5 ? { title: "edited" } : {})));
    expect(await fingerprintOf()).not.toBe(before);
  });

  it("changes with a grader's rubric text", async () => {
    const before = await fingerprintOf();
    await editFile("evals/valid.eval.yaml", (t) => t.replace("without asking questions", "without asking anyone"));
    expect(await fingerprintOf()).not.toBe(before);
  });

  it("changes with the judge", async () => {
    expect(await fingerprintOf({ judge: "openai/gpt-5" })).not.toBe(await fingerprintOf());
  });

  it("changes with the model", async () => {
    expect(await fingerprintOf({ model: "anthropic/claude-sonnet-4-5" })).not.toBe(await fingerprintOf());
  });

  it("changes with repeats", async () => {
    expect(await fingerprintOf({ repeats: 4 })).not.toBe(await fingerprintOf());
  });

  it("changes with the pass threshold", async () => {
    const before = await fingerprintOf();
    await editFile("evals/valid.eval.yaml", (t) => t.replace("pass_threshold: 0.8", "pass_threshold: 0.9"));
    expect(await fingerprintOf()).not.toBe(before);
  });

  it("changes with the engine version", async () => {
    expect(await fingerprintOf(undefined, { engine: { ...ENGINE, version: "2.0.0" } })).not.toBe(await fingerprintOf());
  });

  it("changes with the rubric prompt version", async () => {
    const { components } = await okBuild();
    const bumped = { ...components, rubric_prompt_version: components.rubric_prompt_version + 1 };
    expect(computeFingerprint(bumped)).not.toBe(computeFingerprint(components));
    const rebuilt = buildComponents({
      stageVersionHash: components.stage,
      model: components.model,
      datasetHash: components.dataset,
      caseIds: components.case_ids,
      graders: Object.entries(components.graders).map(([id, hash]) => ({ id, hash })),
      judge: components.judge,
      repeats: components.repeats,
      passThreshold: components.pass_threshold,
      engine: components.engine,
      rubricPromptVersion: RUBRIC_PROMPT_VERSION + 1,
    });
    expect(computeFingerprint(rebuilt)).toBe(computeFingerprint(bumped));
  });

  it("changes with the case subset", async () => {
    const all = await fingerprintOf();
    const subset = await fingerprintOf({ case_ids: ["c001", "c002"] });
    expect(subset).not.toBe(all);
    expect(await fingerprintOf({ case_ids: ["c002", "c001"] })).toBe(subset);
    expect(await fingerprintOf({ tags: ["odd"] })).not.toBe(all);
  });

  it("a selection of every valid case equals no selection", async () => {
    const ids = Array.from({ length: 24 }, (_, i) => `c${String(i + 1).padStart(3, "0")}`);
    expect(await fingerprintOf({ case_ids: ids })).toBe(await fingerprintOf());
  });

  it("does not change with max_cost_usd", async () => {
    expect(await fingerprintOf({ max_cost_usd: 9 })).toBe(await fingerprintOf());
  });

  it("does not change with concurrency", async () => {
    const before = await fingerprintOf();
    await editFile("evals/valid.eval.yaml", (t) => t.replace("concurrency: 4", "concurrency: 2"));
    expect(await fingerprintOf()).toBe(before);
  });

  it("has no input for label, Stageflow version or Node version", async () => {
    const before = await okBuild();
    const other = await okBuild(undefined, { engine: { ...ENGINE, nodeVersion: "24.0.0" } });
    expect(other.fingerprint).toBe(before.fingerprint);
    expect(other.snapshot.engine.node_version).toBe("24.0.0");
    expect(Object.keys(before.components)).not.toContain("label");
    expect(JSON.stringify(before.components)).not.toContain(PACKAGE_VERSION);
  });

  it("components list every fingerprint input so snapshots can be diffed by key", async () => {
    const { components } = await okBuild();
    expect(Object.keys(components).sort()).toEqual(
      [
        "case_ids",
        "dataset",
        "engine",
        "graders",
        "judge",
        "model",
        "pass_threshold",
        "repeats",
        "rubric_prompt_version",
        "stage",
      ].sort(),
    );
    expect(components.case_ids).toBeNull();
    const subset = await okBuild({ case_ids: ["c002", "c001"] });
    expect(subset.components.case_ids).toEqual(["c001", "c002"]);
    expect(Object.keys(subset.components.graders)).toEqual([...Object.keys(subset.components.graders)].sort());
  });
});

describe("caseToTask", () => {
  const plan = { task: { goal: "Eval goal", context: "ctx", constraints: "limits" } };

  it("uses the case goal first, then the eval goal, then a generated one", () => {
    expect(caseToTask(plan, { id: "a", goal: "Case goal", input: { x: 1 } }, "er_1", 2)).toEqual({
      id: "eval-er_1-a-2",
      goal: "Case goal",
      context: "ctx",
      constraints: "limits",
      input: { x: 1 },
    });
    expect(caseToTask(plan, { id: "a", input: {} }, "er_1", 0).goal).toBe("Eval goal");
    expect(caseToTask({ task: {} }, { id: "a", input: {} }, "er_1", 0).goal).toBe("Evaluate case a");
  });

  it("omits absent optional fields", () => {
    const task = caseToTask({ task: {} }, { id: "a", input: { k: "v" } }, "er_1", 1);
    expect(Object.keys(task).sort()).toEqual(["goal", "id", "input"]);
  });
});
