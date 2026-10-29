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
import { graderIdsOf, judgedGraderIds } from "./gradersModel";
import { fetchEvalLabelSummary } from "../../../api";
import { LabelQueue } from "./LabelQueue";
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
  const [labeling, setLabeling] = useState(false);
  const [needs, setNeeds] = useState<{ ids: Set<string> | null; error: string | null }>({ ids: null, error: null });
  const [needsNonce, setNeedsNonce] = useState(0);
  const filterKey = JSON.stringify(filter);
  const labelNeeded = filter.labelNeeded ?? null;

  useEffect(() => {
    if (!labelNeeded) {
      setNeeds({ ids: null, error: null });
      return;
    }
    let cancelled = false;
    setNeeds({ ids: null, error: null });
    fetchEvalLabelSummary(run.eval_run_id, labelNeeded).then(
      (summary) => !cancelled && setNeeds({ ids: new Set(summary.unlabeled.map((u) => u.case_id)), error: null }),
      (err) => !cancelled && setNeeds({ ids: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [run.eval_run_id, labelNeeded, needsNonce]);

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
  const byClient = bySuggestion || labelNeeded !== null;
  const paged = useResultsPage(run.eval_run_id, query);
  const everything = useAllResultsFor(run.eval_run_id, { ...buildResultsQuery(filter, null), limit: 200 }, byClient);
  const { data, error: pagedError, loading: pagedLoading } = paged;
  const error = byClient ? (everything.error ?? needs.error) : pagedError;
  const loading = byClient ? everything.loading || everything.data === null || (labelNeeded !== null && needs.ids === null && needs.error === null) : pagedLoading;
  const threshold = thresholdOf(run);
  const byCase = suggestionByCase(suggestions);
  const matching = bySuggestion ? caseIdsForSuggestionFilter(suggestions, filter) : null;
  const sourceRows = byClient
    ? (everything.data ?? []).filter((r) => (matching === null || matching.has(r.case_id)) && (labelNeeded === null || (needs.ids?.has(r.case_id) ?? false)))
    : (data?.items ?? []);
  const rows = sourceRows.map((row) => {
    const view = caseRowView(row, threshold);
    const s = byCase.get(row.case_id);
    return s ? { ...view, bucket: bucketChip(s) } : view;
  });
  const graderIds = graderIdsOf(run);
  const judgedIds = judgedGraderIds(run);
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
        {judgedIds.length > 0 ? (
          <>
            <select
              aria-label="Filter by label status"
              className={SELECT}
              value={labelNeeded ?? ""}
              onChange={(e) => onFilter({ ...filter, labelNeeded: e.target.value || null })}
            >
              <option value="">Any label status</option>
              {judgedIds.map((id) => (
                <option key={id} value={id}>
                  Needs my label · {id}
                </option>
              ))}
            </select>
            {labelNeeded ? (
              <button
                type="button"
                className="flex h-8 items-center rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] text-[var(--sf-ground)]"
                onClick={() => setLabeling(true)}
              >
                Label these
              </button>
            ) : null}
          </>
        ) : null}
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
          <span>{byClient ? `${rows.length} ${rows.length === 1 ? "case" : "cases"}` : pageLabel(paging, rows.length, countFor(counts, filter.tab))}</span>
          <span className={`flex gap-2 ${byClient ? "hidden" : ""}`}>
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
      {labeling && labelNeeded ? (
        <LabelQueue
          evalId={run.eval_id}
          evalRunId={run.eval_run_id}
          graderId={labelNeeded}
          onClose={() => {
            setLabeling(false);
            setNeedsNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
