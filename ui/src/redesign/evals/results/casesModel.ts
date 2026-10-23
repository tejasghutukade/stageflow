import type { EvalBucket, EvalResultRow, EvalResultsPage, EvalResultsQuery, EvalResultStatus } from "../../../api/evalTypes";
import { formatCost, formatDuration, formatMean, formatScore } from "../format";
import type { Tone } from "./headerModel";
import { suggestionFilterActive, type BucketChipView } from "./triageModel";

export const PAGE_SIZE = 25;

export type DotKind = "passed" | "failed" | "muted";

export type CaseRowView = {
  caseId: string;
  position: string;
  title: string;
  dots: DotKind[];
  scoreText: string;
  scoreTone: Tone;
  failedGraders: string;
  timeText: string;
  costText: string;
  /** Agent runs only: mean per case, from the API. */
  turnsText?: string;
  toolsText?: string;
  /** Failure sorting: the suggested bucket chip, when this case has a live suggestion. */
  bucket?: BucketChipView;
};

export function dotKind(status: EvalResultStatus, passed: boolean): DotKind {
  if (status === "completed") return passed ? "passed" : "failed";
  if (status === "stage_failed" || status === "needs_input" || status === "error") return "failed";
  return "muted";
}

export function scoreTone(score: number | null, threshold: number): Tone {
  if (score === null) return "muted";
  if (score >= threshold) return "ok";
  if (score >= threshold - 0.05) return "needs";
  return "fail";
}

export function caseRowView(row: EvalResultRow, threshold: number): CaseRowView {
  return {
    caseId: row.case_id,
    position: row.position > 0 ? `#${row.position}` : "—",
    title: row.title?.trim() ? row.title : row.case_id,
    dots: row.repeats.map((r) => dotKind(r.status, r.passed)),
    scoreText: formatScore(row.mean_score),
    scoreTone: scoreTone(row.mean_score, threshold),
    failedGraders: row.failed_graders.length > 0 ? row.failed_graders.join(", ") : "—",
    timeText: formatDuration(row.latency_ms_p50),
    costText: formatCost(row.cost_usd),
    ...(row.turns !== undefined || row.tool_calls !== undefined
      ? { turnsText: formatMean(row.turns), toolsText: formatMean(row.tool_calls) }
      : {}),
  };
}

export type CasesTabId = "all" | "failed" | "flaky" | "errored" | "passed";

export type CasesFilter = {
  tab: CasesTabId;
  grader: string | null;
  tag: string | null;
  q: string;
  bucket?: EvalBucket | null;
  needsReview?: boolean;
  suggestedType?: string | null;
};

export const EMPTY_FILTER: CasesFilter = { tab: "all", grader: null, tag: null, q: "" };

export function filterWithTag(tag: string): CasesFilter {
  return { ...EMPTY_FILTER, tag };
}

export function filterWithSuggestedType(suggestedType: string): CasesFilter {
  return { ...EMPTY_FILTER, tab: "failed", suggestedType };
}

export function filterNeedsReview(): CasesFilter {
  return { ...EMPTY_FILTER, tab: "failed", needsReview: true };
}

export function filterWithGrader(grader: string): CasesFilter {
  return { ...EMPTY_FILTER, tab: "failed", grader };
}

export function isFiltered(filter: CasesFilter): boolean {
  return filter.tab !== "all" || filter.grader !== null || filter.tag !== null || filter.q.trim() !== "" || suggestionFilterActive(filter);
}

export function caseTabs(counts: EvalResultsPage["counts"] | null): Array<{ id: CasesTabId; label: string; count?: number }> {
  return [
    { id: "all", label: "All", count: counts?.all },
    { id: "failed", label: "Failed", count: counts?.failed },
    { id: "flaky", label: "Flaky", count: counts?.flaky },
    { id: "errored", label: "Errored", count: counts?.errored },
    { id: "passed", label: "Passed", count: counts?.passed },
  ];
}

export function buildResultsQuery(filter: CasesFilter, cursor: string | null): EvalResultsQuery {
  const query: EvalResultsQuery = { limit: PAGE_SIZE };
  if (filter.tab !== "all") query.status = filter.tab;
  if (filter.grader) query.grader = filter.grader;
  if (filter.tag) query.tag = filter.tag;
  if (filter.q.trim() !== "") query.q = filter.q.trim();
  if (cursor) query.cursor = cursor;
  return query;
}

export function countFor(counts: EvalResultsPage["counts"] | null, tab: CasesTabId): number | null {
  return counts ? counts[tab] : null;
}

export type Paging = { cursors: Array<string | null>; index: number };

export const FIRST_PAGE: Paging = { cursors: [null], index: 0 };

export function pagingNext(paging: Paging, nextCursor: string | null): Paging {
  if (nextCursor === null) return paging;
  const cursors = paging.cursors.slice(0, paging.index + 1);
  cursors.push(nextCursor);
  return { cursors, index: paging.index + 1 };
}

export function pagingPrevious(paging: Paging): Paging {
  return paging.index === 0 ? paging : { ...paging, index: paging.index - 1 };
}

export function currentCursor(paging: Paging): string | null {
  return paging.cursors[paging.index] ?? null;
}

export function pageLabel(paging: Paging, shown: number, total: number | null): string {
  if (shown === 0) return "No cases";
  const from = paging.index * PAGE_SIZE + 1;
  const to = from + shown - 1;
  return total === null ? `Showing ${from} to ${to}` : `Showing ${from} to ${to} of ${total}`;
}

export function emptyText(filter: CasesFilter): string {
  return isFiltered(filter) ? "No cases match these filters." : "No cases in this run.";
}

export function tagOptions(vocabulary: string[], rows: EvalResultRow[]): string[] {
  const seen = new Map<string, string>();
  const add = (tag: string) => {
    if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  };
  vocabulary.forEach(add);
  rows.forEach((row) => {
    row.tags.forEach(add);
    row.failure_tags.forEach(add);
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
