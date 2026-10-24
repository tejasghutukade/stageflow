import { describe, expect, it } from "vitest";
import type { EvalListItem } from "../../../api/evalTypes";
import type { PipelineListing } from "../../../api/types";
import {
  addGrader,
  buildDefinition,
  buildStageRows,
  canContinueFromGraders,
  canContinueFromSetup,
  canEnterStep,
  datasetFromConfirm,
  datasetFromSample,
  datasetSummary,
  defaultsErrors,
  deriveDatasetName,
  deriveEvalId,
  evalCountFor,
  evalDirFromFindings,
  goBack,
  goNext,
  inferDirs,
  initialDraft,
  moveGrader,
  parseBudgetInput,
  parsePercent,
  posixRelative,
  preselectRow,
  removeGrader,
  sampleCompatibility,
  setupChecks,
  setBudget,
  validateEvalId,
  visibleFindings,
  draftDatasetCases,
  estimateText,
  holdsCases,
  writeRootsFor,
  withId,
  withTarget,
  filterStageRows,
  judgeSameAsStage,
  caseVerdictText,
  tryDisabledReason,
  type WizardDraft,
  type WizardTarget,
} from "./wizardModel";
import { setScale, withCommon, setJudge } from "./graderForms";

const target: WizardTarget = {
  kind: "pipeline",
  stageId: "review",
  pipelinePath: "pipelines/feature-ship.pipeline.yaml",
  pipelineId: "feature-ship",
  model: "anthropic/claude-sonnet-4-5",
  label: "feature-ship · review",
};

function readyDraft(): WizardDraft {
  let d = withTarget(initialDraft(), target, [{ name: "diff", required: true }], []);
  d = {
    ...d,
    dataset: datasetFromConfirm({ cases: [{ input: { diff: "x" } }], ready: 1, skipped: 0, fileName: "review-diffs.csv" }, "upload", "review", []),
  };
  return d;
}

describe("ids", () => {
  it("derives <stage>-eval and counts up when taken", () => {
    expect(deriveEvalId("review", [])).toBe("review-eval");
    expect(deriveEvalId("review", ["review-eval"])).toBe("review-eval-2");
    expect(deriveEvalId("review", ["review-eval", "review-eval-2"])).toBe("review-eval-3");
    expect(deriveEvalId("Draft Spec!", [])).toBe("draft-spec-eval");
    expect(deriveEvalId("", [])).toBe("stage-eval");
  });
  it("keeps long ids inside the pattern", () => {
    const id = deriveEvalId("a".repeat(100), []);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(validateEvalId(id, [])).toBeNull();
  });
  it("validates pattern and uniqueness", () => {
    expect(validateEvalId("", [])).not.toBeNull();
    expect(validateEvalId("Bad_Id", [])).not.toBeNull();
    expect(validateEvalId("taken", ["taken"])).not.toBeNull();
    expect(validateEvalId("fine-1", ["taken"])).toBeNull();
  });
  it("derives dataset names", () => {
    expect(deriveDatasetName("upload", "review", "My Cases.csv", [])).toBe("my-cases");
    expect(deriveDatasetName("upload", "review", "my-cases.dataset.jsonl", ["my-cases"])).toBe("my-cases-2");
    expect(deriveDatasetName("runs", "review", "", [])).toBe("review-cases");
    expect(deriveDatasetName("sample", "review", "", [])).toBe("critique-sample");
  });
  it("target change re-derives the id unless edited", () => {
    let d = withTarget(initialDraft(), target, null, ["review-eval"]);
    expect(d.id).toBe("review-eval-2");
    d = withId(d, "mine");
    d = withTarget(d, { ...target, stageId: "other" }, null, []);
    expect(d.id).toBe("mine");
  });
  it("changing the target drops the dataset", () => {
    const d = withTarget(readyDraft(), { ...target, stageId: "other" }, null, []);
    expect(d.dataset).toBeNull();
    expect(withTarget(readyDraft(), target, null, []).dataset).not.toBeNull();
  });
});

describe("paths", () => {
  it("computes relative paths from the evals directory", () => {
    expect(posixRelative("evals", "pipelines/a.pipeline.yaml")).toBe("../pipelines/a.pipeline.yaml");
    expect(posixRelative("evals", "datasets/x.dataset.jsonl")).toBe("../datasets/x.dataset.jsonl");
    expect(posixRelative("examples/evals", "examples/evals/x.dataset.jsonl")).toBe("x.dataset.jsonl");
    expect(posixRelative(".", "pipelines/a.yaml")).toBe("pipelines/a.yaml");
  });
  it("infers directories", () => {
    expect(inferDirs(null, [])).toEqual({ evals: "evals", datasets: "datasets" });
    expect(inferDirs("examples/evals", [])).toEqual({ evals: "examples/evals", datasets: "examples/datasets" });
    expect(inferDirs("evals", ["data/sets/a.dataset.jsonl"])).toEqual({ evals: "evals", datasets: "data/sets" });
    expect(evalDirFromFindings([{ severity: "error", code: "x", path: "my/evals/new.eval.yaml", message: "m", category: "eval" as const }])).toBe("my/evals");
    expect(evalDirFromFindings([])).toBeNull();
  });
});

describe("step validity", () => {
  it("needs target, dataset and valid defaults to continue", () => {
    let d = initialDraft();
    expect(canContinueFromSetup(d)).toBe(false);
    d = withTarget(d, target, null, []);
    expect(canContinueFromSetup(d)).toBe(false);
    d = readyDraft();
    expect(canContinueFromSetup(d)).toBe(true);
    expect(canContinueFromSetup({ ...d, defaults: { ...d.defaults, repeats: 11 } })).toBe(false);
    expect(canContinueFromSetup({ ...d, defaults: { ...d.defaults, passThreshold: 0 } })).toBe(false);
    expect(canContinueFromSetup({ ...d, defaults: { ...d.defaults, maxCostUsd: 0 } })).toBe(false);
    expect(canContinueFromSetup({ ...d, dataset: { ...d.dataset!, ready: 0 } })).toBe(false);
  });
  it("graders step needs one grader and a judge for rubrics", () => {
    let d = readyDraft();
    expect(canContinueFromGraders(d)).toBe(false);
    d = addGrader(d, "schema");
    expect(canContinueFromGraders(d)).toBe(true);
    d = addGrader(d, "rubric");
    d = { ...d, graders: d.graders.map((g) => (g.type === "rubric" ? { ...g, rubric: "text" } : g)) };
    expect(canContinueFromGraders(d)).toBe(false);
    expect(canContinueFromGraders({ ...d, defaults: { ...d.defaults, judge: "a/b" } })).toBe(true);
    const own = { ...d, graders: d.graders.map((g) => (g.type === "rubric" ? setJudge(g, "a/b") : g)) };
    expect(canContinueFromGraders(own)).toBe(true);
  });
  it("moves between steps only when allowed", () => {
    let d = initialDraft();
    expect(goNext(d).step).toBe("setup");
    d = readyDraft();
    d = goNext(d);
    expect(d.step).toBe("graders");
    expect(goNext(d).step).toBe("graders");
    d = goNext(addGrader(d, "schema"));
    expect(d.step).toBe("review");
    expect(goBack(d).step).toBe("graders");
    expect(canEnterStep(readyDraft(), "review")).toBe(false);
  });
});

describe("graders list", () => {
  it("adds, reorders and removes in file order", () => {
    let d = readyDraft();
    d = addGrader(addGrader(addGrader(d, "schema"), "field"), "code");
    expect(d.graders.map((g) => g.id)).toEqual(["grader-1", "grader-2", "grader-3"]);
    d = moveGrader(d, 2, 0);
    expect(d.graders.map((g) => g.type)).toEqual(["code", "schema", "field"]);
    expect(moveGrader(d, 0, 9)).toBe(d);
    d = removeGrader(d, 1);
    expect(d.graders.map((g) => g.type)).toEqual(["code", "field"]);
    d = addGrader(d, "schema");
    expect(new Set(d.graders.map((g) => g.id)).size).toBe(3);
  });
  it("stops at 20 graders", () => {
    let d = readyDraft();
    for (let i = 0; i < 25; i += 1) d = addGrader(d, "code");
    expect(d.graders).toHaveLength(20);
  });
});

describe("definition", () => {
  it("writes explicit defaults, relative paths and the file key order", () => {
    let d = readyDraft();
    d = { ...d, name: "Review findings", description: "Review flags real defects", defaults: { ...d.defaults, judge: "anthropic/claude-sonnet-4-5" } };
    d = addGrader(d, "schema");
    d = setBudget(d, "latency_ms", 300000);
    d = setBudget(d, "cost_usd", 0.3);
    const def = buildDefinition(d)!;
    expect(Object.keys(def)).toEqual(["version", "id", "name", "description", "type", "target", "dataset", "defaults", "graders", "budget"]);
    expect(def.target).toEqual({ kind: "stage", pipeline: "../pipelines/feature-ship.pipeline.yaml", stage: "review" });
    expect(def.dataset).toBe("../datasets/review-diffs.dataset.jsonl");
    expect(def.defaults).toEqual({ repeats: 3, judge: "anthropic/claude-sonnet-4-5", pass_threshold: 0.8, max_cost_usd: 2 });
    expect(def.budget).toEqual({ latency_ms: 300000, cost_usd: 0.3 });
  });
  it("matches the schema document's example graders", () => {
    let d = readyDraft();
    d = { ...d, id: "review-findings" };
    const fieldGrader = withCommon(
      {
        id: "findings-cite-lines",
        type: "field",
        checks: [
          { path: "payload.findings[*].file", op: "not_empty" },
          { path: "payload.findings[*].line", op: "exists" },
        ],
      },
      { description: "Every item in findings has a file and a line number" },
    );
    const clarity = setScale({ id: "clear-and-actionable", type: "rubric", rubric: "A developer could act on each finding without asking questions." }, "1_to_5");
    d = { ...d, graders: [{ id: "output-schema", type: "schema", must_pass: true }, fieldGrader, clarity] };
    const def = buildDefinition(d)!;
    expect(def.graders[0]).toEqual({ id: "output-schema", type: "schema", must_pass: true });
    expect(Object.keys(def.graders[1]!)).toEqual(["id", "type", "description", "checks"]);
    expect(def.graders[2]).toEqual({
      id: "clear-and-actionable",
      type: "rubric",
      rubric: "A developer could act on each finding without asking questions.",
      scale: "1_to_5",
      pass_at: 4,
    });
  });
  it("uses a file target relative to the evals directory", () => {
    const d = { ...readyDraft(), target: { kind: "file", stageId: "s", file: "stages/s.yaml", label: "" } as WizardTarget };
    expect(buildDefinition(d)!.target).toEqual({ kind: "stage", file: "../stages/s.yaml" });
  });
  it("returns null before target and dataset exist", () => {
    expect(buildDefinition(initialDraft())).toBeNull();
  });
});

describe("defaults", () => {
  it("validates and parses", () => {
    expect(defaultsErrors({ repeats: 3, passThreshold: 0.8, maxCostUsd: 2, judge: null })).toEqual({});
    expect(defaultsErrors({ repeats: 0, passThreshold: 2, maxCostUsd: -1, judge: null })).toEqual(
      expect.objectContaining({ repeats: expect.any(String), passThreshold: expect.any(String), maxCostUsd: expect.any(String) }),
    );
    expect(parsePercent("80")).toBe(0.8);
    expect(parsePercent("87.5%")).toBe(0.875);
    expect(parsePercent("")).toBeNull();
    expect(parseBudgetInput("300", "latency_ms")).toEqual({ ok: true, value: 300000 });
    expect(parseBudgetInput("-1", "cost_usd").ok).toBe(false);
  });
  it("detects the judge matching the stage model", () => {
    const d = readyDraft();
    expect(judgeSameAsStage(d, "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(judgeSameAsStage(d, "other/model")).toBe(false);
    expect(judgeSameAsStage(d, null)).toBe(false);
  });
});

describe("dataset", () => {
  it("summarises cases and skips", () => {
    const ds = readyDraft().dataset!;
    expect(datasetSummary(ds)).toEqual({ title: "1 case", match: "all match io.input" });
    expect(datasetSummary({ ...ds, ready: 12, skipped: 2 })).toEqual({ title: "12 cases", match: "2 skipped" });
  });
  it("checks sample compatibility", () => {
    expect(sampleCompatibility([{ name: "draft", required: true, type: "string" }])).toEqual({ ok: true });
    expect(sampleCompatibility([{ name: "diff", required: true }]).ok).toBe(false);
    expect(sampleCompatibility(null).ok).toBe(false);
    expect(sampleCompatibility([{ name: "draft", required: true }, { name: "plan", required: true }]).ok).toBe(false);
    expect(sampleCompatibility([{ name: "draft", required: true }, { name: "plan", required: false }]).ok).toBe(true);
    expect(sampleCompatibility([{ name: "draft", required: true, type: "object" }]).ok).toBe(false);
    expect(datasetFromSample("s", []).ready).toBe(8);
  });
});

describe("findings and checks", () => {
  const dsFinding = { severity: "error" as const, code: "eval.dataset_unresolved", path: "evals/x.eval.yaml", message: "Dataset not found", category: "eval" as const };
  const other = { severity: "warning" as const, code: "eval.judge_same_as_stage", path: "evals/x.eval.yaml", message: "same", category: "eval" as const };
  it("hides dataset findings until the dataset is on disk", () => {
    expect(visibleFindings([dsFinding, other], false)).toEqual([other]);
    expect(visibleFindings([{ ...dsFinding, code: "dataset.load_error" }], false)).toEqual([]);
    expect(visibleFindings([dsFinding, other], true)).toHaveLength(2);
  });
  it("builds the checks list", () => {
    const lines = setupChecks(readyDraft(), [other]);
    expect(lines.map((l) => l.text)).toEqual([
      "Stage review found in pipelines/feature-ship.pipeline.yaml",
      "1 of 1 cases match the stage's io.input",
      "same",
      "No graders yet. Add at least one next.",
    ]);
    expect(lines[2]!.tone).toBe("warning");
  });
});

describe("try on one case", () => {
  it("words the case score against the threshold", () => {
    expect(caseVerdictText(0.75, 0.8)).toBe("Just under the 80% threshold");
    expect(caseVerdictText(0.5, 0.8)).toBe("Below the 80% threshold");
    expect(caseVerdictText(0.9, 0.8)).toBe("Meets the 80% threshold");
    expect(caseVerdictText(null, 0.8)).toBe("No score");
  });
  it("is disabled without cases, graders or while errors exist", () => {
    const base = readyDraft();
    expect(tryDisabledReason(base, [])).toBe("Add a grader first.");
    const withGrader = addGrader(base, "schema");
    expect(tryDisabledReason(withGrader, [])).toBeNull();
    expect(tryDisabledReason(withGrader, [{ severity: "error", code: "x", path: "", message: "m", category: "eval" as const }])).toMatch(/errors/);
    expect(tryDisabledReason({ ...withGrader, dataset: datasetFromSample("s", []) }, [])).toMatch(/cases in hand/);
    expect(tryDisabledReason(initialDraft(), [])).toBe("Add a dataset first.");
  });
});

describe("stage rows", () => {
  const pipelines: PipelineListing[] = [
    { path: "pipelines/a.pipeline.yaml", id: "a", project_root: "/p", stages: [{ id: "review", uses_path: "stages/review.yaml", model: "m/1" }, { id: "inline", inline: true }] },
    { path: "pipelines/b.pipeline.yaml", id: "b", project_root: "/p", stages: [{ id: "review", uses_path: "stages/review.yaml" }] },
    { path: "x.pipeline.yaml", id: "x", project_root: "examples", stages: [{ id: "ex" }] },
  ];
  const rows = buildStageRows(pipelines, new Set(["examples"]));
  it("merges stages used by several pipelines", () => {
    expect(rows.map((r) => r.stageId)).toEqual(["ex", "inline", "review"]);
    expect(rows.find((r) => r.stageId === "review")!.pipelines.map((p) => p.id)).toEqual(["a", "b"]);
    expect(rows.find((r) => r.stageId === "ex")!.readOnly).toBe(true);
  });
  it("filters by stage, model or pipeline", () => {
    expect(filterStageRows(rows, "m/1").map((r) => r.stageId)).toEqual(["review"]);
    expect(filterStageRows(rows, "").length).toBe(3);
  });
  it("preselects from the query", () => {
    const hit = preselectRow(rows, { pipeline: "pipelines/b.pipeline.yaml", stage: "review" })!;
    expect(hit.target).toMatchObject({ kind: "pipeline", pipelinePath: "pipelines/b.pipeline.yaml", stageId: "review", projectRoot: "/p" });
    expect(preselectRow(rows, { file: "stages/review.yaml" })!.target).toMatchObject({ kind: "file", file: "stages/review.yaml" });
    expect(preselectRow(rows, { stage: "nope" })).toBeNull();
  });
  it("counts evals per stage", () => {
    const evals = [
      { project_root: "/p", target: { kind: "stage", pipeline_path: "pipelines/b.pipeline.yaml", stage_id: "review", label: "" } },
      { project_root: "/p", target: { kind: "stage", file: "stages/review.yaml", label: "" } },
      { project_root: "/p", target: { kind: "stage", pipeline_path: "pipelines/a.pipeline.yaml", stage_id: "inline", label: "" } },
    ] as EvalListItem[];
    expect(evalCountFor(rows.find((r) => r.stageId === "review")!, evals)).toBe(2);
    expect(evalCountFor(rows.find((r) => r.stageId === "inline")!, evals)).toBe(1);
  });
});

describe("draft cases, write roots and estimate", () => {
  it("holds cases only for uploaded or pasted datasets", () => {
    const d = readyDraft();
    expect(holdsCases(d)).toBe(true);
    expect(draftDatasetCases(d)).toEqual([{ input: { diff: "x" } }]);
    const sample = { ...d, dataset: datasetFromSample("review", []) };
    expect(draftDatasetCases({ ...sample, dataset: { ...sample.dataset, cases: null } })).toBeUndefined();
    expect(holdsCases(initialDraft())).toBe(false);
  });
  it("write roots win over the guess and only apply to the same project root", () => {
    const roots = { project_root: "/p", evals_dir: "qa/evals", datasets_dir: "qa/data" };
    expect(inferDirs("x", ["a/b.dataset.jsonl"], roots)).toEqual({ evals: "qa/evals", datasets: "qa/data" });
    expect(inferDirs(null, [], null)).toEqual({ evals: "evals", datasets: "datasets" });
    expect(writeRootsFor(roots, null)).toBe(roots);
    expect(writeRootsFor(roots, { ...target, projectRoot: "/p" })).toBe(roots);
    expect(writeRootsFor(roots, { ...target, projectRoot: "/other" })).toBeNull();
    expect(writeRootsFor(undefined, null)).toBeNull();
  });
  it("shows no cost history only when estimate_usd is null", () => {
    const base = { estimate_seconds: 90, judge_included: true };
    expect(estimateText(null).hasEstimate).toBe(false);
    expect(estimateText({ ...base, estimate_usd: null })).toEqual({ title: "No cost history yet", hasEstimate: false });
    const t = estimateText({ ...base, estimate_usd: 0.42 });
    expect(t.hasEstimate).toBe(true);
    expect(t.title).toContain("$0.42");
  });
});
