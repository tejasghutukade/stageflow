import { describe, expect, it } from "vitest";
import {
  addNewTag,
  afterSave,
  agreementLine,
  buildSaveRequest,
  canSave,
  caseNeighbours,
  drawerHeader,
  errorView,
  expectedFindings,
  flattenPayload,
  gradeRows,
  initReview,
  inputLines,
  isDirty,
  isErrored,
  normalizeTag,
  outputMeta,
  outputView,
  repeatTabs,
  rerunPanelView,
  selectRepeat,
  setLabel,
  setNote,
  tagsEnabled,
  toggleTag,
} from "./drawerModel";
import { fixtureGrade, fixtureResult } from "./fixtures";

describe("drawerModel header and tabs", () => {
  it("builds the header and neighbours", () => {
    const ids = ["a", "b", "c"];
    expect(drawerHeader("e", 14, ids, "b")).toBe("e · Run #14 · case 2 of 3");
    expect(drawerHeader("e", 14, ids, "zz")).toBe("e · Run #14 · case");
    expect(caseNeighbours(ids, "b")).toEqual({ previous: "a", next: "c" });
    expect(caseNeighbours(ids, "a")).toEqual({ previous: null, next: "b" });
    expect(caseNeighbours(ids, "c").next).toBeNull();
    expect(caseNeighbours(ids, "zz")).toEqual({ previous: null, next: null });
  });

  it("builds repeat tabs sorted with tones", () => {
    const tabs = repeatTabs([
      fixtureResult({ repeat_index: 1, score: 0.64, passed: false }),
      fixtureResult({ repeat_index: 0, score: 0.93, passed: true }),
      fixtureResult({ repeat_index: 2, score: null, passed: false, status: "error" }),
    ]);
    expect(tabs).toEqual([
      { index: 0, label: "Repeat 1", scoreText: "0.93", tone: "ok" },
      { index: 1, label: "Repeat 2", scoreText: "0.64", tone: "fail" },
      { index: 2, label: "Repeat 3", scoreText: "", tone: "fail" },
    ]);
  });

  it("selects the requested repeat or the first", () => {
    const repeats = [fixtureResult({ repeat_index: 1 }), fixtureResult({ repeat_index: 0 })];
    expect(selectRepeat(repeats, 1)!.repeat_index).toBe(1);
    expect(selectRepeat(repeats, 7)!.repeat_index).toBe(0);
    expect(selectRepeat(repeats, undefined)!.repeat_index).toBe(0);
    expect(selectRepeat([], 0)).toBeNull();
  });
});

describe("drawerModel input and output", () => {
  it("lists input as key value lines", () => {
    expect(inputLines({ diff: "- a", n: 3, nested: { x: 1 } })).toEqual([
      { key: "diff", value: "- a" },
      { key: "n", value: "3" },
      { key: "nested", value: '{"x":1}' },
    ]);
    expect(inputLines("raw")).toEqual([{ key: "input", value: "raw" }]);
    expect(inputLines(undefined)).toEqual([]);
  });

  it("flattens payloads into key paths", () => {
    expect(flattenPayload({ findings: [{ file: "a.ts", line: 4 }], ok: true, none: [], e: {} })).toEqual([
      'findings[0].file: "a.ts"',
      "findings[0].line: 4",
      "ok: true",
      "none: []",
      "e: {}",
    ]);
    expect(flattenPayload("x")).toEqual([]);
    expect(flattenPayload(undefined)).toEqual([]);
    expect(flattenPayload({ n: null })).toEqual(["n: null"]);
  });

  it("builds the output view with meta text and a line cap", () => {
    const view = outputView(fixtureResult());
    expect(view.summary).toBe("Found one issue.");
    expect(view.lines).toEqual(['findings[0].file: "auth.ts"', "findings[0].line: 42"]);
    expect(view.moreCount).toBe(0);
    expect(view.metaText).toBe("4.6 s · $0.01 · 2.1k tokens");
    const big = Object.fromEntries(Array.from({ length: 45 }, (_v, i) => [`k${i}`, i]));
    const capped = outputView(fixtureResult({ output: { summary: " ", payload: big } }));
    expect(capped.lines).toHaveLength(40);
    expect(capped.moreCount).toBe(5);
    expect(capped.summary).toBeNull();
    expect(outputView(fixtureResult({ output: null })).lines).toEqual([]);
    expect(outputMeta({ latency_ms: null, cost_usd: null, tokens_in: null, tokens_out: null })).toBe("— · — · —");
  });

  it("describes errored results", () => {
    const errored = fixtureResult({ status: "stage_failed", error_code: "EVAL_STAGE_TIMEOUT", error_message: "Timed out" });
    expect(isErrored(errored)).toBe(true);
    expect(isErrored(fixtureResult())).toBe(false);
    expect(errorView(errored)).toEqual({ code: "EVAL_STAGE_TIMEOUT", message: "Timed out" });
    expect(errorView(fixtureResult({ status: "skipped_budget", error_code: null, error_message: null }))).toEqual({
      code: "EVAL_BUDGET_EXCEEDED",
      message: "No further detail was recorded.",
    });
    expect(errorView(fixtureResult({ status: "completed", error_code: null, error_message: null })).code).toBe("completed");
  });
});

describe("drawerModel grades", () => {
  it("builds expected findings from the reference grader only", () => {
    expect(expectedFindings(fixtureResult())).toEqual([
      { text: "null dereference in auth.ts", found: true },
      { text: "race in session refresh", found: false },
    ]);
    expect(expectedFindings(fixtureResult({ grades: [fixtureGrade()] }))).toBeNull();
    expect(expectedFindings(fixtureResult({ grades: [fixtureGrade({ grader_type: "reference", details: null })] }))).toBeNull();
    expect(
      expectedFindings(fixtureResult({ grades: [fixtureGrade({ grader_type: "reference", details: { items: [] } })] })),
    ).toBeNull();
  });

  it("builds grade rows with values and reasons", () => {
    const rows = gradeRows(fixtureResult());
    expect(rows).toEqual([
      { id: "output-schema", ok: true, valueText: "pass", reason: null, failed: false, judged: false, humanLabel: null },
      { id: "finds-expected-issues", ok: false, valueText: "0.50", reason: "1 of 2 found.", failed: true, judged: false, humanLabel: null },
      { id: "clear-and-actionable", ok: false, valueText: "3 / 5", reason: "Gives no fix.", failed: true, judged: true, humanLabel: null },
    ]);
  });

  it("marks judged graders and carries the author's label", () => {
    const rows = gradeRows(
      fixtureResult({
        grades: [fixtureGrade({ grader_id: "r", grader_type: "rubric", passed: true, score: 1, raw_value: 1 })],
        grader_labels: { r: { label: "fail", note: null } },
      }),
    );
    expect(rows[0]).toMatchObject({ judged: true, humanLabel: "fail" });
  });

  it("formats pass/fail rubrics, passing reasons and error grades", () => {
    const rows = gradeRows(
      fixtureResult({
        grades: [
          fixtureGrade({ grader_id: "r", grader_type: "rubric", passed: false, score: 0, raw_value: 0, reason: "No." }),
          fixtureGrade({ grader_id: "r2", grader_type: "rubric", passed: true, score: 1, raw_value: 1, reason: "Fine." }),
          fixtureGrade({ grader_id: "c", grader_type: "code", passed: true, score: null, raw_value: null }),
          fixtureGrade({
            grader_id: "e",
            status: "error",
            passed: null,
            score: null,
            raw_value: null,
            error_code: "EVAL_JUDGE_ERROR",
            reason: "Judge unavailable",
          }),
          fixtureGrade({ grader_id: "e2", status: "error", passed: null, score: null, raw_value: null }),
        ],
      }),
    );
    expect(rows.map((r) => r.valueText)).toEqual(["fail", "pass", "pass", "error", "error"]);
    expect(rows[0]!.reason).toBe("No.");
    expect(rows[1]!.reason).toBeNull();
    expect(rows[3]).toMatchObject({ ok: null, failed: true, reason: "EVAL_JUDGE_ERROR: Judge unavailable" });
    expect(rows[4]!.reason).toBe("Grader error");
  });
});

describe("drawerModel review state machine", () => {
  const failed = fixtureResult({ passed: false });
  const passed = fixtureResult({ passed: true, repeat_index: 0 });

  it("initialises from the stored review", () => {
    const empty = initReview(failed);
    expect(empty).toMatchObject({ label: null, note: "", tags: [] });
    expect(isDirty(empty)).toBe(false);
    const stored = initReview(fixtureResult({ review: { label: "fail", note: "why" }, tags: ["a"] }));
    expect(stored).toMatchObject({ label: "fail", note: "why", tags: ["a"] });
    expect(isDirty(stored)).toBe(false);
  });

  it("requires a label to save", () => {
    let state = initReview(failed);
    state = setNote(state, "because");
    expect(isDirty(state)).toBe(true);
    expect(canSave(state)).toBe(false);
    expect(buildSaveRequest(state, failed)).toBeNull();
    state = setLabel(state, "fail");
    expect(canSave(state)).toBe(true);
  });

  it("builds the save request with note and tags for failed results", () => {
    let state = initReview(failed);
    state = setLabel(state, "fail");
    state = setNote(state, "  Did not mention the race.  ");
    state = toggleTag(state, "Missed", tagsEnabled(failed));
    expect(buildSaveRequest(state, failed)).toEqual({ label: "fail", note: "Did not mention the race.", tags: ["Missed"] });
  });

  it("never sends tags for passed results and ignores tag edits", () => {
    expect(tagsEnabled(passed)).toBe(false);
    let state = setLabel(initReview(passed), "pass");
    state = toggleTag(state, "x", false);
    state = addNewTag(state, "y", false);
    expect(state.tags).toEqual([]);
    expect(buildSaveRequest(state, passed)).toEqual({ label: "pass" });
  });

  it("clears a previously saved note with null", () => {
    const state = setNote(initReview(fixtureResult({ review: { label: "fail", note: "old" } })), "");
    expect(buildSaveRequest(state, failed)).toEqual({ label: "fail", note: null, tags: [] });
  });

  it("toggles and adds tags case-insensitively", () => {
    let state = initReview(failed);
    state = addNewTag(state, "  Too   vague ", true);
    expect(state.tags).toEqual(["Too vague"]);
    state = addNewTag(state, "too vague", true);
    expect(state.tags).toEqual(["Too vague"]);
    state = addNewTag(state, "   ", true);
    expect(state.tags).toEqual(["Too vague"]);
    state = addNewTag(state, "x".repeat(61), true);
    expect(state.tags).toEqual(["Too vague"]);
    state = toggleTag(state, "TOO VAGUE", true);
    expect(state.tags).toEqual([]);
    expect(normalizeTag(" a ")).toBe("a");
  });

  it("caps the note and resets after save", () => {
    let state = setNote(initReview(failed), "x".repeat(600));
    expect(state.note).toHaveLength(500);
    state = setLabel(state, "fail");
    const after = afterSave({ label: "fail", note: null, tags: ["a"] });
    expect(after).toMatchObject({ label: "fail", note: "", tags: ["a"] });
    expect(isDirty(after)).toBe(false);
    expect(canSave(after)).toBe(false);
  });

  it("detects a tag-only change", () => {
    const base = initReview(fixtureResult({ review: { label: "fail", note: null }, tags: ["a"] }));
    expect(isDirty(toggleTag(base, "b", true))).toBe(true);
    expect(isDirty(toggleTag(toggleTag(base, "b", true), "b", true))).toBe(false);
  });
});

describe("drawerModel agreement line", () => {
  it("agrees and disagrees", () => {
    const failed = { passed: false, repeat_index: 1 };
    expect(agreementLine(failed, null)).toBeNull();
    expect(agreementLine(failed, "fail")).toBe("The judge also said fail for repeat 2. You agree.");
    expect(agreementLine(failed, "pass")).toBe("You disagree with the grade.");
    expect(agreementLine({ passed: true, repeat_index: 0 }, "pass")).toBe("The judge also said pass for repeat 1. You agree.");
    expect(agreementLine({ passed: true, repeat_index: 0 }, "fail")).toBe("You disagree with the grade.");
  });
});

describe("drawerModel re-run panel", () => {
  it("shows a temporary result", () => {
    const view = rerunPanelView({ result: fixtureResult({ passed: true, score: 0.9 }), stage_run_id: "r", cost_usd: 0.02 });
    expect(view).toMatchObject({
      title: "Re-run · not stored",
      verdict: "Passed",
      verdictTone: "ok",
      scoreText: "0.90",
      summary: "Found one issue.",
      metaText: "4.6 s · $0.02",
      error: null,
    });
    expect(view.grades).toHaveLength(3);
    expect(rerunPanelView({ result: fixtureResult({ passed: false }), stage_run_id: null, cost_usd: 0 }).verdict).toBe("Failed");
  });

  it("shows errors without grades", () => {
    const view = rerunPanelView({
      result: fixtureResult({ status: "error", error_code: "EVAL_ENGINE_ERROR", error_message: "Boom", passed: false, score: null }),
      stage_run_id: null,
      cost_usd: 0,
    });
    expect(view.verdict).toBe("Errored");
    expect(view.error).toEqual({ code: "EVAL_ENGINE_ERROR", message: "Boom" });
    expect(view.grades).toEqual([]);
    expect(view.scoreText).toBe("—");
  });
});
