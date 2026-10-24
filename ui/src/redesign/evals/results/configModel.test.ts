import { describe, expect, it } from "vitest";
import {
  caseSubset,
  changedGraders,
  datasetCard,
  datasetEdited,
  editedChip,
  exportFileName,
  fingerprintNote,
  gradersCard,
  reproduceCommand,
  rerunNote,
  rerunOverrides,
  settingsCard,
  stageCard,
  stageEdited,
} from "./configModel";
import { fixtureRun } from "./fixtures";

describe("configModel cards", () => {
  it("builds the stage card", () => {
    const rows = stageCard(fixtureRun());
    expect(rows[0]).toEqual({ label: "Stage", value: "review in feature-ship" });
    expect(rows[1]).toEqual({ label: "Version", value: "3f9a1c" });
    expect(rows[2]!.value).toBe("anthropic/claude-sonnet-4-5 · thinking medium");
    expect(rows[3]!.value).toBe("1d7e44");
  });

  it("falls back for a file target without model or schema", () => {
    const run = fixtureRun();
    run.config.target = { file: "stages/review.yaml", stage_version_hash: "abcdef0000", stage_definition: {} };
    expect(stageCard(run).map((r) => r.value)).toEqual(["stages/review.yaml", "abcdef", "—", "—"]);
  });

  it("flags a stage edited since", () => {
    const run = fixtureRun();
    run.current.stage_version_hash = "a82e07ffff";
    expect(stageEdited(run)).toBe(true);
    expect(stageCard(run)[1]!.chip).toEqual({ text: "edited since: now a82e07", tone: "needs" });
  });

  it("does not flag unknown current hashes", () => {
    const run = fixtureRun();
    run.current = { stage_version_hash: null, dataset_hash: null, grader_hashes: null };
    expect(stageEdited(run)).toBe(false);
    expect(datasetEdited(run)).toBe(false);
    expect(datasetCard(run).status).toBeNull();
    expect(changedGraders(run)).toEqual([]);
    expect(editedChip("a", "a")).toBeNull();
  });

  it("builds the dataset card in both states", () => {
    const same = datasetCard(fixtureRun());
    expect(same.status).toEqual({ text: "unchanged since this run", tone: "ok" });
    expect(same.rows.map((r) => r.value)).toEqual([
      "datasets/review-diffs.dataset.jsonl",
      "9b41c0",
      "24 of 24 · 0 skipped",
      "io.input · 4a11f9",
    ]);
    const run = fixtureRun();
    run.current.dataset_hash = "ffeedd0000";
    expect(datasetCard(run).status).toEqual({ text: "edited since: now ffeedd", tone: "needs" });
    expect(datasetEdited(run)).toBe(true);
  });

  it("builds the graders card", () => {
    const card = gradersCard(fixtureRun());
    expect(card.count).toBe(5);
    expect(card.summary).toBe("5 · rubrics v3, v2");
    expect(card.rows[0]).toMatchObject({ id: "output-schema", kind: "check", weightText: "must pass", hash: "6b2f10" });
    expect(card.rows[3]).toMatchObject({ kind: "rubric", versionText: "v3", notCalibrated: true, weightText: "×2" });
    expect(card.rows[0]!.notCalibrated).toBe(false);
  });

  it("summarises graders without rubrics and flags edited graders", () => {
    const run = fixtureRun();
    run.config.graders = run.config.graders.slice(0, 2);
    run.current.grader_hashes!["findings-cite-lines"] = "zzzzzz";
    expect(gradersCard(run).summary).toBe("2");
    expect(gradersCard(run).rows[1]!.edited?.text).toBe("edited since: now zzzzzz");
  });

  it("builds the settings card", () => {
    const rows = settingsCard(fixtureRun());
    expect(rows[0]).toMatchObject({ value: "anthropic/claude-sonnet-4-5", chip: { text: "same as stage model" } });
    expect(rows[1]!.value).toBe("3 · 0.80 · $2.00 (spent $0.64)");
    expect(rows[2]!.value).toBe("capability · stage model not overridden");
    expect(rows[3]!.value).toBe("Stageflow 0.38.0 · eval engine promptfoo 0.124.1");
    const run = fixtureRun();
    run.config.settings.judge_same_as_stage = false;
    run.config.overrides.model = "openai/x";
    const other = settingsCard(run);
    expect(other[0]!.chip).toBeUndefined();
    expect(other[2]!.value).toBe("capability · stage model overridden: openai/x");
  });

  it("has a fingerprint note", () => {
    expect(fingerprintNote()).toContain("never edited");
  });
});

describe("configModel reproduce and re-run", () => {
  it("builds the command", () => {
    expect(reproduceCommand(fixtureRun())).toBe(
      "sf eval run evals/review-findings.eval.yaml --repeats 3 --judge anthropic/claude-sonnet-4-5",
    );
    const run = fixtureRun();
    run.config.overrides.model = "openai/x";
    run.config.overrides.max_cost_usd = 5;
    run.components = { case_ids: ["a", "b"] };
    expect(reproduceCommand(run)).toBe(
      "sf eval run evals/review-findings.eval.yaml --repeats 3 --judge anthropic/claude-sonnet-4-5 --model openai/x --max-cost 2 --case a --case b",
    );
  });

  it("builds re-run overrides with only the snapshot's settings", () => {
    expect(rerunOverrides(fixtureRun())).toEqual({
      repeats: 3,
      judge: "anthropic/claude-sonnet-4-5",
      max_cost_usd: 2,
    });
    const run = fixtureRun();
    run.config.overrides.model = "openai/x";
    run.components = { case_ids: ["a"] };
    expect(rerunOverrides(run)).toEqual({
      repeats: 3,
      judge: "anthropic/claude-sonnet-4-5",
      model: "openai/x",
      max_cost_usd: 2,
      case_ids: ["a"],
    });
    expect(caseSubset(run)).toEqual(["a"]);
    expect(caseSubset(fixtureRun())).toBeNull();
  });

  it("skips empty settings", () => {
    const run = fixtureRun();
    run.config.settings = {};
    run.components = { case_ids: [] };
    expect(rerunOverrides(run)).toEqual({});
  });

  it("explains what changed since the run", () => {
    expect(rerunNote(fixtureRun())).toBeNull();
    const run = fixtureRun();
    run.current.stage_version_hash = "bbbbbbbb";
    expect(rerunNote(run)).toBe("The stage changed since this run; this will use the current ones.");
    run.current.dataset_hash = "cccccc";
    expect(rerunNote(run)).toBe("The stage and dataset changed since this run; this will use the current ones.");
    run.current.grader_hashes!["output-schema"] = "dddddd";
    expect(rerunNote(run)).toBe("The stage, dataset and graders changed since this run; this will use the current ones.");
    expect(changedGraders(run)).toEqual(["output-schema"]);
  });

  it("reports added and removed graders as changed", () => {
    const run = fixtureRun();
    run.current.grader_hashes = { "output-schema": "6b2f10aa", "new-one": "x" };
    expect(changedGraders(run)).toEqual(["new-one", "findings-cite-lines", "finds-expected-issues", "no-invented-files", "clear-and-actionable"]);
  });

  it("names export files", () => {
    expect(exportFileName({ eval_id: "e", run_number: 3 }, "config")).toBe("e-run-3-config.json");
  });
});
