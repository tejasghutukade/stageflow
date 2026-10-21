import { describe, expect, it } from "vitest";
import type { EvalDetail, EvalRunEstimate } from "../../../api/evalTypes";
import {
  buildContext,
  buildEstimateRequest,
  buildStartRequest,
  casesOptions,
  compareLabel,
  estimateText,
  filterPickCases,
  initialState,
  isValid,
  judgeSameAsStage,
  modelOptions,
  parseCostLimit,
  parseRepeats,
  startErrorText,
  togglePicked,
  validate,
  type LastCompletedRun,
} from "./runDialogModel";

function detail(overrides: Partial<NonNullable<EvalDetail["definition"]>> = {}): EvalDetail {
  return {
    id: "review-findings",
    path: "evals/review-findings.eval.yaml",
    file_hash: "h",
    definition: {
      version: 1,
      id: "review-findings",
      target: { kind: "stage", pipeline: "p.pipeline.yaml", stage: "review" },
      dataset: "datasets/review-diffs.dataset.jsonl",
      graders: [{ id: "a", type: "schema" }, { id: "b", type: "rubric" }],
      defaults: { repeats: 3, max_cost_usd: 2, judge: "anthropic/claude-sonnet-4-5" },
      ...overrides,
    },
    yaml: "",
    findings: [],
    runs_count: 1,
    last_run: null,
  };
}

const last: LastCompletedRun = { evalRunId: "run-14", runNumber: 14, failedCases: 5 };

function ctx(lastCompleted: LastCompletedRun | null = last, d = detail(), lastRunConfig: Record<string, any> | null = null) {
  return buildContext({ evalId: "review-findings", detail: d, casesTotal: 24, lastCompleted, lastRunConfig });
}

describe("buildContext", () => {
  it("builds title, subtitle and defaults", () => {
    const c = ctx(last, detail(), { target: { model: "anthropic/claude-sonnet-4-5" } });
    expect(c.title).toBe("Run review-findings");
    expect(c.subtitle).toBe("Stage review · dataset review-diffs · 2 graders");
    expect(c.defaults).toEqual({
      repeats: 3,
      maxCostUsd: 2,
      stageModel: "anthropic/claude-sonnet-4-5",
      judge: "anthropic/claude-sonnet-4-5",
    });
  });

  it("falls back to file defaults when the definition omits them", () => {
    const c = ctx(null, detail({ defaults: undefined }));
    expect(c.defaults.repeats).toBe(3);
    expect(c.defaults.maxCostUsd).toBe(2);
    expect(c.defaults.stageModel).toBeNull();
  });
});

describe("start request", () => {
  it("sends nothing when no option changed", () => {
    const c = ctx();
    expect(buildStartRequest(initialState(c), c)).toEqual({});
  });

  it("sends only changed overrides", () => {
    const c = ctx();
    const s = { ...initialState(c), repeats: "5", stageModel: "openai/gpt-5", costLimit: "$1.50" };
    expect(buildStartRequest(s, c)).toEqual({ repeats: 5, model: "openai/gpt-5", max_cost_usd: 1.5 });
  });

  it("does not send an unchanged stage model or an empty judge selection", () => {
    const c = ctx();
    const s = { ...initialState(c), stageModel: "", judgeModel: "" };
    expect(buildStartRequest(s, c)).toEqual({});
    expect(buildStartRequest({ ...s, judgeModel: "openai/gpt-5" }, c)).toEqual({ judge: "openai/gpt-5" });
  });

  it("maps cases modes", () => {
    const c = ctx();
    const base = initialState(c);
    expect(buildStartRequest({ ...base, casesMode: "failed" }, c)).toEqual({ only_failed_from: "run-14" });
    expect(buildStartRequest({ ...base, casesMode: "pick", picked: ["c1", "c3"] }, c)).toEqual({
      case_ids: ["c1", "c3"],
    });
  });

  it("includes project_root when known", () => {
    const c = { ...ctx(), projectRoot: "/work/x" };
    expect(buildStartRequest(initialState(c), c)).toEqual({ project_root: "/work/x" });
  });
});

describe("validation", () => {
  it("accepts repeats 1-10 only", () => {
    expect(parseRepeats("1")).toBe(1);
    expect(parseRepeats("10")).toBe(10);
    expect(parseRepeats("0")).toBeNull();
    expect(parseRepeats("11")).toBeNull();
    expect(parseRepeats("2.5")).toBeNull();
    expect(parseRepeats("")).toBeNull();
  });

  it("accepts cost above zero, with or without a dollar sign", () => {
    expect(parseCostLimit("2")).toBe(2);
    expect(parseCostLimit("$0.50")).toBe(0.5);
    expect(parseCostLimit(".5")).toBe(0.5);
    expect(parseCostLimit("0")).toBeNull();
    expect(parseCostLimit("-1")).toBeNull();
    expect(parseCostLimit("abc")).toBeNull();
  });

  it("reports errors and blocks an empty pick", () => {
    const c = ctx();
    const s = { ...initialState(c), repeats: "0", costLimit: "0", casesMode: "pick" as const };
    expect(Object.keys(validate(s, c)).sort()).toEqual(["costLimit", "picked", "repeats"]);
    expect(isValid(initialState(c), c)).toBe(true);
    expect(buildEstimateRequest(s, c)).toBeNull();
  });
});

describe("cases options", () => {
  it("disables Failed last time without a completed run", () => {
    const c = ctx(null);
    const options = casesOptions(c, initialState(c));
    expect(options.map((o) => o.label)).toEqual(["All 24", "Failed last time", "Pick cases"]);
    expect(options[1]!.disabled).toBe(true);
    expect(compareLabel(c)).toBeNull();
    expect(initialState(c).compare).toBe(false);
  });

  it("shows the failed count from the last completed run", () => {
    const c = ctx();
    const options = casesOptions(c, initialState(c));
    expect(options[1]).toEqual({ id: "failed", label: "Failed last time · 5", disabled: false });
    expect(compareLabel(c)).toBe("Compare with Run #14 when it finishes");
    expect(initialState(c).compare).toBe(true);
  });

  it("shows the picked count", () => {
    const c = ctx();
    const s = { ...initialState(c), casesMode: "pick" as const, picked: ["a", "b"] };
    expect(casesOptions(c, s)[2]!.label).toBe("Pick cases · 2");
  });
});

describe("judge hint", () => {
  it("shows when the effective judge equals the effective stage model", () => {
    const c = ctx(last, detail(), { target: { model: "anthropic/claude-sonnet-4-5" } });
    const s = initialState(c);
    expect(judgeSameAsStage(s, c)).toBe(true);
    expect(judgeSameAsStage({ ...s, stageModel: "openai/gpt-5" }, c)).toBe(false);
    expect(judgeSameAsStage({ ...s, judgeModel: "openai/gpt-5" }, c)).toBe(false);
    expect(judgeSameAsStage({ ...s, stageModel: "openai/gpt-5", judgeModel: "openai/gpt-5" }, c)).toBe(true);
  });

  it("stays quiet when the stage model is unknown", () => {
    const c = ctx();
    expect(judgeSameAsStage(initialState(c), c)).toBe(false);
  });
});

describe("estimate text", () => {
  const full: EvalRunEstimate = {
    results_total: 72,
    stage_calls: 72,
    judge_calls: 144,
    estimate_usd: 0.64,
    estimate_seconds: 220,
    judge_included: true,
    based_on_run_number: 14,
  };

  it("formats the complete estimate", () => {
    expect(estimateText(full, 2)).toEqual({
      headline: "About $0.64 and 3 m 40 s",
      detail: "72 stage calls and 144 judge calls, based on run #14",
      notes: [],
      stops: "stops at $2.00",
    });
  });

  it("explains missing cost history", () => {
    const t = estimateText(
      { ...full, estimate_usd: null, estimate_seconds: null, judge_included: false, based_on_run_number: null },
      2,
    );
    expect(t.headline).toBe("No cost history yet; the limit still applies");
    expect(t.detail).toBe("72 stage calls and 144 judge calls. No previous run to base this on");
  });

  it("notes when judge calls are excluded", () => {
    const t = estimateText({ ...full, judge_included: false, estimate_seconds: null, based_on_run_number: null }, 1);
    expect(t.headline).toBe("About $0.64");
    expect(t.notes).toEqual(["Estimate excludes judge calls."]);
    expect(t.stops).toBe("stops at $1.00");
  });

  it("handles a time-only estimate and singular calls", () => {
    const t = estimateText({ ...full, estimate_usd: null, judge_calls: 0, stage_calls: 1 }, 2);
    expect(t.headline).toBe("About 3 m 40 s");
    expect(t.notes).toEqual(["No cost history yet; the limit still applies"]);
    expect(t.detail).toBe("1 stage call, based on run #14");
  });
});

describe("pick helpers", () => {
  const cases = [
    { id: "c001", title: "Race in refresh", input: { text: "alpha" }, input_check: null },
    { id: "c002", input: { text: "Beta thing" }, input_check: null },
  ];

  it("filters by id, title and input", () => {
    expect(filterPickCases(cases, "")).toHaveLength(2);
    expect(filterPickCases(cases, "race").map((c) => c.id)).toEqual(["c001"]);
    expect(filterPickCases(cases, "beta").map((c) => c.id)).toEqual(["c002"]);
    expect(filterPickCases(cases, "c00").length).toBe(2);
  });

  it("toggles picks", () => {
    expect(togglePicked([], "a")).toEqual(["a"]);
    expect(togglePicked(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("start errors", () => {
  it("shows the server message", () => {
    expect(startErrorText(new Error("A run of this eval is already active."))).toBe("A run of this eval is already active.");
    expect(startErrorText("x")).toBe("The run could not be started.");
  });
});

describe("model options", () => {
  const models = [{ id: "a/x" }, { id: "b/y", judge_capable: false }];
  it("puts the default first and drops non-judge models for the judge", () => {
    expect(modelOptions(models, "Stage default", false).map((o) => o.value)).toEqual(["", "a/x", "b/y"]);
    expect(modelOptions(models, "Eval default", true).map((o) => o.value)).toEqual(["", "a/x"]);
  });
});
