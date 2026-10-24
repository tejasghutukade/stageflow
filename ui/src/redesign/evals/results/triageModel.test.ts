import { describe, expect, it } from "vitest";
import type { EvalClassifierStatus, EvalSuggestion, EvalSuggestionSummary } from "../../../api/evalTypes";
import { EMPTY_FILTER, filterNeedsReview, filterWithSuggestedType, isFiltered } from "./casesModel";
import {
  acceptableCount,
  bucketBars,
  bucketChip,
  caseIdsForSuggestionFilter,
  isLowConfidence,
  sortButtonView,
  sortDoneText,
  suggestedTypeRows,
  suggestedView,
  suggestionByCase,
  suggestionLine,
  unavailableView,
} from "./triageModel";

function sug(over: Partial<EvalSuggestion> = {}): EvalSuggestion {
  return {
    id: "s1",
    case_id: "c1",
    repeat_index: 0,
    source: "jev",
    bucket: "grader_wrong",
    failure_type: "wrong_or_missing_fact",
    confidence: 0.91,
    bucket_probabilities: { agent_wrong: 0.05, grader_wrong: 0.91, case_wrong: 0.02, unclear: 0.02 },
    grader_false_alarms: [{ grader_id: "never-promises-outcomes", probability: 0.88 }],
    model: "jev-1.14.0",
    prompt_version: "1",
    status: "pending",
    created_at: "2026-10-23T00:00:00Z",
    ...over,
  };
}

const SUMMARY: EvalSuggestionSummary = {
  by_bucket: { agent_wrong: 9, grader_wrong: 6, case_wrong: 2, unclear: 2 },
  by_type: { tone: 2, wrong_or_missing_fact: 7, other: 2 },
  pending: 15,
  accepted: 3,
  dismissed: 1,
  low_confidence: 4,
};

const STATUS_BOTH: EvalClassifierStatus = {
  classifiers: { jev: { available: true, model: "jev-1.14.0" }, judge: { available: true, model: "claude-x" } },
  default: "jev",
};

describe("sortButtonView", () => {
  it("shows the classifier name when available", () => {
    expect(sortButtonView(STATUS_BOTH, false)).toMatchObject({ enabled: true, classifier: "jev", via: "Jev · jev-1.14.0" });
  });

  it("falls to the judge when it is the default", () => {
    const status: EvalClassifierStatus = { ...STATUS_BOTH, default: "judge" };
    expect(sortButtonView(status, false).via).toBe("Judge model · claude-x");
  });

  it("is disabled with the key instructions when nothing is available", () => {
    const status: EvalClassifierStatus = {
      classifiers: { jev: { available: false, model: null, reason: "No TypeSafe key." }, judge: { available: false, model: null } },
      default: null,
    };
    const view = sortButtonView(status, false);
    expect(view.enabled).toBe(false);
    expect(view.reason).toContain("No TypeSafe key.");
    expect(view.reason).toContain("STAGEFLOW_PROVIDER_TYPESAFE_API_KEY");
  });

  it("is disabled while the run is active or status is loading", () => {
    expect(sortButtonView(STATUS_BOTH, true)).toMatchObject({ enabled: false, reason: "Wait for the run to finish." });
    expect(sortButtonView(null, false).enabled).toBe(false);
  });
});

describe("unavailableView", () => {
  it("names Settings, Providers and the env var, and offers the judge when it works", () => {
    const view = unavailableView(STATUS_BOTH);
    expect(view.text).toContain("Settings, Providers");
    expect(view.text).toContain("STAGEFLOW_PROVIDER_TYPESAFE_API_KEY");
    expect(view.judgeFallback).toBe(true);
  });

  it("still mentions the judge without offering a button when it is unavailable", () => {
    const view = unavailableView(null);
    expect(view.judgeFallback).toBe(false);
    expect(view.text).toContain("judge model");
  });
});

describe("confidence", () => {
  it("treats unclear and under 70% as low", () => {
    expect(isLowConfidence(sug({ confidence: 0.69 }))).toBe(true);
    expect(isLowConfidence(sug({ confidence: 0.7 }))).toBe(false);
    expect(isLowConfidence(sug({ bucket: "unclear", confidence: 0.99 }))).toBe(true);
  });

  it("never marks low confidence by tone alone", () => {
    const chip = bucketChip(sug({ confidence: 0.55 }));
    expect(chip.low).toBe(true);
    expect(chip.text).toBe("Grader wrong? · low 55%");
    expect(bucketChip(sug()).text).toBe("Grader wrong");
    expect(suggestionLine(sug({ confidence: 0.4 })).lowText).toMatch(/Low confidence/);
  });

  it("counts only pending confident suggestions as bulk-acceptable", () => {
    const items = [sug({ id: "a" }), sug({ id: "b", confidence: 0.5 }), sug({ id: "c", status: "accepted" }), sug({ id: "d", bucket: "unclear" })];
    expect(acceptableCount(items)).toBe(1);
  });
});

describe("summary views", () => {
  it("builds the four bucket bars from the API counts", () => {
    const bars = bucketBars(SUMMARY);
    expect(bars.map((b) => [b.bucket, b.count])).toEqual([
      ["agent_wrong", 9],
      ["grader_wrong", 6],
      ["case_wrong", 2],
      ["unclear", 2],
    ]);
    expect(bars[0]!.fraction).toBeCloseTo(9 / 19);
    expect(bars[0]!.fix).toBe("Change the agent or stage");
  });

  it("handles an all-zero summary", () => {
    const empty: EvalSuggestionSummary = { ...SUMMARY, by_bucket: { agent_wrong: 0, grader_wrong: 0, case_wrong: 0, unclear: 0 }, by_type: {} };
    expect(bucketBars(empty).every((b) => b.fraction === 0)).toBe(true);
    expect(suggestedView({ ...empty, pending: 0, accepted: 0, dismissed: 0, low_confidence: 0 }, []).empty).toBe(true);
  });

  it("orders failure types by count then name", () => {
    expect(suggestedTypeRows(SUMMARY).map((r) => r.type)).toEqual(["wrong_or_missing_fact", "other", "tone"]);
    expect(suggestedTypeRows(SUMMARY)[0]!.fraction).toBe(1);
  });

  it("labels the actions", () => {
    const view = suggestedView(SUMMARY, [sug(), sug({ id: "b", confidence: 0.2 })]);
    expect(view.acceptAllText).toBe("Accept all above 70% (1)");
    expect(view.acceptAllEnabled).toBe(true);
    expect(view.reviewText).toBe("Review suggestions (4)");
    expect(view.headline).toBe("15 pending · 3 accepted · 1 dismissed");
    expect(suggestedView(SUMMARY, []).acceptAllEnabled).toBe(false);
  });

  it("describes a finished sort", () => {
    expect(sortDoneText({ sorted: 17, skipped: 1, failed: 0, triage_cost_usd: 0.25, model: "jev-1.14.0" })).toBe(
      "Sorted 17 · 1 skipped · sorting cost $0.25 · jev-1.14.0",
    );
  });
});

describe("suggestion line", () => {
  it("matches the spec copy", () => {
    expect(suggestionLine(sug()).text).toBe(
      "Jev suggests: grader wrong · false alarm on never-promises-outcomes · wrong_or_missing_fact · 91%",
    );
  });

  it("omits the false alarm for other buckets and shows accepted state", () => {
    const line = suggestionLine(sug({ bucket: "agent_wrong", status: "accepted", failure_type: null, source: "judge" }));
    expect(line.text).toBe("Judge model suggests: agent wrong · 91%");
    expect(line.pending).toBe(false);
    expect(line.acceptedNote).toMatch(/Accepted/);
  });
});

describe("case filters", () => {
  const items = [
    sug({ id: "a", case_id: "c1" }),
    sug({ id: "b", case_id: "c2", bucket: "agent_wrong", failure_type: "tone", confidence: 0.4 }),
    sug({ id: "c", case_id: "c3", status: "dismissed" }),
    sug({ id: "d", case_id: "c4", bucket: "unclear", failure_type: "tone", status: "accepted" }),
  ];

  it("filters by bucket, needs review and type; dismissed never match", () => {
    expect([...caseIdsForSuggestionFilter(items, { bucket: "grader_wrong" })]).toEqual(["c1"]);
    expect([...caseIdsForSuggestionFilter(items, { needsReview: true })]).toEqual(["c2"]);
    expect([...caseIdsForSuggestionFilter(items, { suggestedType: "tone" })].sort()).toEqual(["c2", "c4"]);
  });

  it("keeps one suggestion per case, pending first", () => {
    const map = suggestionByCase([
      sug({ id: "x", case_id: "c1", status: "accepted", repeat_index: 0 }),
      sug({ id: "y", case_id: "c1", status: "pending", repeat_index: 1 }),
      sug({ id: "z", case_id: "c2", status: "dismissed" }),
    ]);
    expect(map.get("c1")!.id).toBe("y");
    expect(map.has("c2")).toBe(false);
  });

  it("counts as a filter and builds helper filters", () => {
    expect(isFiltered({ ...EMPTY_FILTER, bucket: "agent_wrong" })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTER, needsReview: true })).toBe(true);
    expect(filterWithSuggestedType("tone")).toMatchObject({ tab: "failed", suggestedType: "tone" });
    expect(filterNeedsReview()).toMatchObject({ tab: "failed", needsReview: true });
  });
});
