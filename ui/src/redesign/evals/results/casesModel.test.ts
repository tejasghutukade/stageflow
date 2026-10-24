import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  FIRST_PAGE,
  buildResultsQuery,
  caseRowView,
  caseTabs,
  countFor,
  currentCursor,
  dotKind,
  emptyText,
  filterWithGrader,
  filterWithTag,
  isFiltered,
  pageLabel,
  pagingNext,
  pagingPrevious,
  scoreTone,
  tagOptions,
} from "./casesModel";
import { fixtureRow } from "./fixtures";

describe("casesModel", () => {
  it("builds the row view", () => {
    expect(caseRowView(fixtureRow(), 0.8)).toEqual({
      caseId: "c012",
      position: "#12",
      title: "SQL injection in query.ts",
      dots: ["failed", "failed"],
      scoreText: "0.41",
      scoreTone: "fail",
      failedGraders: "finds-expected-issues, no-invented-files",
      timeText: "5.2 s",
      costText: "$0.01",
    });
  });

  it("falls back for missing title, position, graders and score", () => {
    const view = caseRowView(
      fixtureRow({ title: null, position: 0, failed_graders: [], mean_score: null, latency_ms_p50: null }),
      0.8,
    );
    expect(view.title).toBe("c012");
    expect(view.position).toBe("—");
    expect(view.failedGraders).toBe("—");
    expect(view.scoreText).toBe("—");
    expect(view.scoreTone).toBe("muted");
    expect(view.timeText).toBe("—");
  });

  it("maps dots and tones", () => {
    expect(dotKind("completed", true)).toBe("passed");
    expect(dotKind("completed", false)).toBe("failed");
    expect(dotKind("error", false)).toBe("failed");
    expect(dotKind("skipped_budget", false)).toBe("muted");
    expect(scoreTone(0.8, 0.8)).toBe("ok");
    expect(scoreTone(0.77, 0.8)).toBe("needs");
    expect(scoreTone(0.5, 0.8)).toBe("fail");
  });

  it("builds tabs, queries and filters", () => {
    const counts = { all: 24, failed: 6, flaky: 3, errored: 1, passed: 18 };
    expect(caseTabs(counts).map((t) => `${t.label} ${t.count}`)).toEqual([
      "All 24",
      "Failed 6",
      "Flaky 3",
      "Errored 1",
      "Passed 18",
    ]);
    expect(caseTabs(null)[0]!.count).toBeUndefined();
    expect(countFor(counts, "flaky")).toBe(3);
    expect(countFor(null, "flaky")).toBeNull();
    expect(buildResultsQuery(EMPTY_FILTER, null)).toEqual({ limit: 25 });
    expect(buildResultsQuery({ tab: "failed", grader: "g", tag: "t", q: " x " }, "cur")).toEqual({
      limit: 25,
      status: "failed",
      grader: "g",
      tag: "t",
      q: "x",
      cursor: "cur",
    });
    expect(isFiltered(EMPTY_FILTER)).toBe(false);
    expect(isFiltered(filterWithTag("t"))).toBe(true);
    expect(filterWithGrader("g")).toEqual({ tab: "failed", grader: "g", tag: null, q: "" });
    expect(emptyText(EMPTY_FILTER)).toBe("No cases in this run.");
    expect(emptyText(filterWithTag("t"))).toBe("No cases match these filters.");
  });

  it("pages with a cursor stack", () => {
    expect(pagingNext(FIRST_PAGE, null)).toBe(FIRST_PAGE);
    const second = pagingNext(FIRST_PAGE, "c1");
    expect(currentCursor(second)).toBe("c1");
    expect(pageLabel(second, 25, 60)).toBe("Showing 26 to 50 of 60");
    expect(pageLabel(FIRST_PAGE, 0, 0)).toBe("No cases");
    expect(pageLabel(FIRST_PAGE, 3, null)).toBe("Showing 1 to 3");
    const back = pagingPrevious(second);
    expect(back.index).toBe(0);
    expect(pagingPrevious(FIRST_PAGE)).toBe(FIRST_PAGE);
    expect(currentCursor(pagingNext(back, "c9"))).toBe("c9");
  });

  it("merges tag options case-insensitively", () => {
    const rows = [fixtureRow({ tags: ["Edge"], failure_tags: ["too vague"] })];
    expect(tagOptions(["Too vague", "Missed"], rows)).toEqual(["Edge", "Missed", "Too vague"]);
  });
});
