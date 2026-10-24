import { describe, expect, it } from "vitest";
import type { EvalRunListItem } from "../../api";
import { stageRunBannerModel } from "./stageRunBannerModel";

const base: EvalRunListItem = {
  eval_run_id: "er1",
  eval_id: "review-quality",
  run_number: 4,
  status: "completed",
  passed: true,
  pass_rate: 1,
  pass_rate_ci: null,
  results_executed: 1,
  cost_total: 0,
  finished_at: null,
  fingerprint: "f",
  label: null,
};

describe("stageRunBannerModel", () => {
  it("is null for a normal run", () => {
    expect(stageRunBannerModel([])).toBeNull();
  });

  it("links to the case when the lookup names one", () => {
    const item: EvalRunListItem = { ...base, result: { case_id: "c1", repeat_index: 1 } };
    expect(stageRunBannerModel([item])).toEqual({
      text: "This run was started by eval review-quality, run #4",
      href: "/evals/review-quality/runs/4/case/c1?repeat=1",
    });
  });

  it("links to the run without a result", () => {
    expect(stageRunBannerModel([base])?.href).toBe("/evals/review-quality/runs/4");
  });
});
