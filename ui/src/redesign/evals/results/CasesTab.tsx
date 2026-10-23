import { useEffect, useMemo, useState } from "react";
import type { EvalResultRow, EvalRunDetail } from "../../../api/evalTypes";
import { FilterTabs } from "../../shell/FilterTabs";
import { CaseRowsTable } from "./CaseRowsTable";
import {
  FIRST_PAGE,
  buildResultsQuery,
  caseRowView,
  caseTabs,
  countFor,
  currentCursor,
  emptyText,
  isFiltered,
  pageLabel,
  pagingNext,
  pagingPrevious,
  tagOptions,
  EMPTY_FILTER,
  type CasesFilter,
  type CasesTabId,
  type Paging,
} from "./casesModel";
import { graderDefinitions } from "./gradersModel";
import { thresholdOf } from "./headerModel";
import { isAgentRun } from "../agentRun";
import { useAllResultsFor, useResultsPage } from "./useResultsData";
import { BUCKETS, BUCKET_LABEL, bucketChip, caseIdsForSuggestionFilter, suggestionByCase, suggestionFilterActive } from "./triageModel";
import type { EvalBucket, EvalSuggestion } from "../../../api/evalTypes";

const SELECT =
  "h-8 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-2 text-[13px] text-[var(--sf-text-1)]";

export function CasesTab({
  run,
  filter,
  onFilter,
  vocabulary,
  allRows,
  onOpen,
  suggestions,
}: {
  run: EvalRunDetail;
  filter: CasesFilter;
  onFilter: (filter: CasesFilter) => void;
  vocabulary: string[];
  allRows: EvalResultRow[];
  onOpen: (caseId: string) => void;
  suggestions: EvalSuggestion[];
}) {
  const [paging, setPaging] = useState<Paging>(FIRST_PAGE);
  const [search, setSearch] = useState(filter.q);
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    setPaging(FIRST_PAGE);
    setSearch(filter.q);
  }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (search === filter.q) return;
    const timer = window.setTimeout(() => onFilter({ ...filter, q: search }), 250);
    return () => window.clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useMemo(() => buildResultsQuery(filter, currentCursor(paging)), [filter, paging]);
  const bySuggestion = suggestionFilterActive(filter);
  const paged = useResultsPage(run.eval_run_id, query);
  const everything = useAllResultsFor(run.eval_run_id, { ...buildResultsQuery(filter, null), limit: 200 }, bySuggestion);
  const { data, error: pagedError, loading: pagedLoading } = paged;
  const error = bySuggestion ? everything.error : pagedError;
  const loading = bySuggestion ? everything.loading || everything.data === null : pagedLoading;
  const threshold = thresholdOf(run);
  const byCase = suggestionByCase(suggestions);
  const matching = bySuggestion ? caseIdsForSuggestionFilter(suggestions, filter) : null;
  const sourceRows = bySuggestion ? (everything.data ?? []).filter((r) => matching!.has(r.case_id)) : (data?.items ?? []);
  const rows = sourceRows.map((row) => {
    const view = caseRowView(row, threshold);
    const s = byCase.get(row.case_id);
    return s ? { ...view, bucket: bucketChip(s) } : view;
  });
  const graderIds = graderDefinitions(run).map((g) => String(g.id));
  const tags = tagOptions(vocabulary, allRows);
  const counts = data?.counts ?? null;

  return (
    <div className="flex min-h-0 flex-col">
      <FilterTabs
        tabs={caseTabs(counts)}
        activeId={filter.tab}
        onChange={(id) => onFilter({ ...filter, tab: id as CasesTabId })}
      />
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        <select
          aria-label="Filter by grader"
          className={SELECT}
          value={filter.grader ?? ""}
          onChange={(e) => onFilter({ ...filter, grader: e.target.value || null })}
        >
          <option value="">All graders</option>
          {graderIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by tag"
          className={SELECT}
          value={filter.tag ?? ""}
          onChange={(e) => onFilter({ ...filter, tag: e.target.value || null })}
        >
          <option value="">All tags</option>
          {filter.tag && !tags.includes(filter.tag) ? <option value={filter.tag}>{filter.tag}</option> : null}
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by suggested bucket"
          className={SELECT}
          value={filter.bucket ?? ""}
          onChange={(e) => onFilter({ ...filter, bucket: (e.target.value || null) as EvalBucket | null })}
        >
          <option value="">All buckets</option>
          {BUCKETS.map((b) => (
            <option key={b} value={b}>
              {BUCKET_LABEL[b]}
            </option>
          ))}
        </select>
        <label className="flex h-8 items-center gap-1.5 text-[13px] text-[var(--sf-text-1)]">
          <input
            type="checkbox"
            checked={filter.needsReview === true}
            onChange={(e) => onFilter({ ...filter, needsReview: e.target.checked })}
          />
          Needs review
        </label>
        {filter.suggestedType ? (
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-lg border border-[var(--sf-hairline-strong)] px-2 text-[13px] text-[var(--sf-text-1)]"
            onClick={() => onFilter({ ...filter, suggestedType: null })}
            aria-label={`Remove suggested type filter ${filter.suggestedType}`}
          >
            Suggested type: {filter.suggestedType} ×
          </button>
        ) : null}
        <input
          aria-label="Search cases"
          placeholder="Search by id, title or input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${SELECT} w-64`}
        />
        {isFiltered(filter) ? (
          <button type="button" className="text-[13px] text-[var(--sf-text-2)] underline" onClick={() => onFilter(EMPTY_FILTER)}>
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="mx-5 mb-4 overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]">
        {error ? (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-fail)]" role="alert">
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">{loading ? "Loading cases…" : emptyText(filter)}</p>
        ) : (
          <CaseRowsTable rows={rows} onOpen={onOpen} agent={isAgentRun(run)} />
        )}
        <div className="flex items-center justify-between border-t border-[var(--sf-hairline)] px-4 py-2 text-xs text-[var(--sf-text-3)]">
          <span>{bySuggestion ? `${rows.length} ${rows.length === 1 ? "case" : "cases"}` : pageLabel(paging, rows.length, countFor(counts, filter.tab))}</span>
          <span className={`flex gap-2 ${bySuggestion ? "hidden" : ""}`}>
            <button
              type="button"
              disabled={paging.index === 0}
              onClick={() => setPaging(pagingPrevious(paging))}
              className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!data?.next_cursor}
              onClick={() => setPaging(pagingNext(paging, data?.next_cursor ?? null))}
              className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
