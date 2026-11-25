import { useCallback, useEffect, useRef, useState } from "react";
import { LuActivity, LuCode, LuFile, LuFileText, LuImage, LuTable } from "react-icons/lu";
import type { IconType } from "react-icons";
import { fetchCatalogRoots, fetchRuns } from "../../api/client";
import { fetchArtifacts } from "../../api/artifacts";
import { navigate } from "../../routes";
import { DataTable, DataTableRow } from "../shell/DataTable";
import { FilterTabs } from "../shell/FilterTabs";
import { PageHeader } from "../shell/PageHeader";
import {
  ALL_PROJECTS_SCOPE,
  ARTIFACTS_EMPTY_BODY,
  ARTIFACTS_EMPTY_TITLE,
  ARTIFACTS_FILTERED_EMPTY_BODY,
  ARTIFACTS_FILTERED_EMPTY_TITLE,
  DEFAULT_ARTIFACT_LIST_FILTERS,
  activeArtifactProjectWireId,
  applyArtifactPage,
  artifactListFiltersActive,
  artifactListFiltersToQuery,
  artifactListRows,
  ARTIFACT_SEARCH_QUERY_HINT,
  artifactMatchCountLabel,
  artifactSearchQueryRejected,
  artifactProjectScopeOptions,
  artifactScopeQuery,
  artifactStatusPillClass,
  artifactTabCountsFromRecords,
  initialArtifactCursorState,
  parseArtifactListFiltersFromHash,
  replaceArtifactsListInHash,
  unregisteredProjectLabel,
  type ArtifactCursorState,
  type ArtifactListFilterState,
  type ArtifactListRow,
  type ArtifactListTab,
  type ArtifactProjectRoot,
  type ArtifactRunRef,
  type ArtifactScopeOption,
} from "./artifactsPageModel";

const KIND_ICONS: Record<string, IconType> = {
  "static.markdown": LuFileText,
  "static.image": LuImage,
  "static.table": LuTable,
  "static.html": LuCode,
  "static.text": LuFile,
  "live.declarative": LuActivity,
};

function KindIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICONS[kind] ?? LuFile;
  return <Icon aria-hidden className="size-4 shrink-0 text-[var(--sf-text-2)]" />;
}

function EmptyState({
  filtered,
  onClearFilters,
  hint,
}: {
  filtered: boolean;
  onClearFilters?: () => void;
  hint?: string;
}) {
  if (filtered) {
    return (
      <div className="mx-5 mt-6 flex max-w-[640px] flex-col gap-3 rounded-lg border border-[var(--sf-hairline)] px-6 py-8" data-testid="artifacts-empty-filtered">
        <h2 className="text-[15px] font-semibold text-[var(--sf-text-1)]">{ARTIFACTS_FILTERED_EMPTY_TITLE}</h2>
        <p className="text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{hint ?? ARTIFACTS_FILTERED_EMPTY_BODY}</p>
        {onClearFilters ? (
          <button
            type="button"
            className="mt-1 w-fit rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-3 py-1.5 text-[13px] text-[var(--sf-text-1)]"
            onClick={onClearFilters}
          >
            Clear filters
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="mx-5 mt-6 flex max-w-[640px] flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] px-6 py-8" data-testid="artifacts-empty">
      <h2 className="text-[15px] font-semibold text-[var(--sf-text-1)]">{ARTIFACTS_EMPTY_TITLE}</h2>
      <p className="text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{ARTIFACTS_EMPTY_BODY}</p>
      <p className="text-[13px] text-[var(--sf-text-3)]">See the Artifacts section in the project docs for the full index rules.</p>
    </div>
  );
}

function ArtifactRow({ row }: { row: ArtifactListRow }) {
  const unregistered = unregisteredProjectLabel(row);
  return (
    <DataTableRow onClick={() => navigate(row.detailPath)}>
      <span className="flex items-center gap-3">
        <KindIcon kind={row.kind} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--sf-text-1)]">{row.title}</span>
        <span className="hidden shrink-0 text-xs text-[var(--sf-text-2)] sm:inline">{row.ownerLabel}</span>
        <span className="sf-pill shrink-0">
          <span className="sf-pill__label">{row.kindLabel}</span>
        </span>
        <span className={`${artifactStatusPillClass(row.statusPill.variant)} shrink-0`} title={row.expiredReason ?? undefined}>
          <span className="sf-pill__label">{row.statusPill.label}</span>
        </span>
        {row.expiryNote ? (
          <span className="hidden shrink-0 text-xs text-[var(--sf-text-3)] lg:inline">{row.expiryNote}</span>
        ) : null}
        {row.showProject ? (
          <span className="shrink-0 text-xs text-[var(--sf-text-2)]">{row.projectLabel}</span>
        ) : null}
        <span className="shrink-0 text-xs text-[var(--sf-text-2)]">
          {row.runLabel}
        </span>
        <span className="shrink-0 text-xs text-[var(--sf-text-3)]">{row.updatedLabel}</span>
        {unregistered ? (
          <span className="sf-pill sf-pill--needs shrink-0">
            <span className="sf-pill__label">{unregistered}</span>
          </span>
        ) : null}
      </span>
    </DataTableRow>
  );
}

export function ArtifactsPageView({
  rows,
  error,
  loading,
  scopeOptions,
  scopeId,
  onScope,
  filters,
  onFiltersChange,
  onClearFilters,
  showLoadMore,
  onLoadMore,
  tabCounts,
  search,
  onSearch,
  onClearSearch,
  matchCount,
}: {
  rows: ArtifactListRow[] | null;
  error: string | null;
  loading: boolean;
  scopeOptions: ArtifactScopeOption[];
  scopeId: string;
  onScope?: (id: string) => void;
  filters: ArtifactListFilterState;
  onFiltersChange: (next: ArtifactListFilterState) => void;
  onClearFilters?: () => void;
  showLoadMore: boolean;
  onLoadMore?: () => void;
  tabCounts: { all: number; live: number; static: number };
  search?: string;
  onSearch?: (value: string) => void;
  onClearSearch?: () => void;
  matchCount?: number | null;
}) {
  const invalidQuery = artifactSearchQueryRejected(error);
  const tabs = [
    { id: "all", label: "All", count: tabCounts.all },
    { id: "live", label: "Live", count: tabCounts.live },
    { id: "static", label: "Static", count: tabCounts.static },
  ];
  const filtersActive = artifactListFiltersActive(filters);
  const sortValue = `${filters.sort}:${filters.order}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title="Artifacts"
        actions={
          scopeOptions.length > 0 ? (
            <select
              aria-label="Project"
              className="h-8 max-w-[240px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2.5 text-[13px] text-[var(--sf-text-1)]"
              value={scopeId}
              onChange={(event) => onScope?.(event.target.value)}
            >
              {scopeOptions.map((option) => (
                <option key={option.id === ALL_PROJECTS_SCOPE ? "all" : option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null
        }
      />
      <FilterTabs
        tabs={tabs}
        activeId={filters.tab}
        onChange={(id) => onFiltersChange({ ...filters, tab: id as ArtifactListTab })}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-b-[#ffffff12] px-5 py-2" data-testid="artifacts-filter-bar">
        <input
          aria-label="Search artifacts"
          placeholder="Search"
          className="h-8 w-[220px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={search ?? filters.q}
          onChange={(event) => onSearch?.(event.target.value)}
        />
        {(search ?? filters.q).length > 0 ? (
          <button
            type="button"
            aria-label="Clear search"
            className="h-8 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
            onClick={onClearSearch}
          >
            Clear
          </button>
        ) : null}
        {filters.q.trim().length > 0 && matchCount != null && !loading ? (
          <span className="text-[13px] text-[var(--sf-text-2)]" data-testid="artifacts-match-count">
            {artifactMatchCountLabel(matchCount)}
          </span>
        ) : null}
        <input
          aria-label="Kind"
          placeholder="Kind"
          className="h-8 w-[120px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={filters.kind}
          onChange={(event) => onFiltersChange({ ...filters, kind: event.target.value })}
        />
        <input
          aria-label="Owner"
          placeholder="Owner"
          className="h-8 w-[140px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={filters.owner}
          onChange={(event) => onFiltersChange({ ...filters, owner: event.target.value })}
        />
        <input
          aria-label="Tag"
          placeholder="Tag"
          className="h-8 w-[100px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={filters.tag}
          onChange={(event) => onFiltersChange({ ...filters, tag: event.target.value })}
        />
        <select
          aria-label="Status"
          className="h-8 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={filters.status}
          onChange={(event) =>
            onFiltersChange({
              ...filters,
              status: event.target.value as ArtifactListFilterState["status"],
            })
          }
        >
          <option value="">Any status</option>
          <option value="available">Available</option>
          <option value="expired">Expired</option>
        </select>
        <select
          aria-label="Sort"
          className="h-8 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2 text-[13px] text-[var(--sf-text-1)]"
          value={sortValue}
          onChange={(event) => {
            const [sort, order] = event.target.value.split(":") as [ArtifactListFilterState["sort"], ArtifactListFilterState["order"]];
            onFiltersChange({ ...filters, sort, order });
          }}
        >
          <option value="updated:desc">Updated (newest)</option>
          <option value="updated:asc">Updated (oldest)</option>
          <option value="title:asc">Title (A–Z)</option>
          <option value="title:desc">Title (Z–A)</option>
          <option value="size:desc">Size (largest)</option>
          <option value="size:asc">Size (smallest)</option>
        </select>
      </div>
      {invalidQuery ? (
        <EmptyState filtered hint={ARTIFACT_SEARCH_QUERY_HINT} onClearFilters={onClearFilters} />
      ) : error ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{error}</p>
      ) : loading || rows === null ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">Loading artifacts…</p>
      ) : rows.length === 0 ? (
        <EmptyState filtered={filtersActive} onClearFilters={onClearFilters} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <DataTable>
            {rows.map((row) => (
              <ArtifactRow key={row.key} row={row} />
            ))}
          </DataTable>
          {showLoadMore ? (
            <div className="px-5 py-3">
              <button
                type="button"
                className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-3 py-1.5 text-[13px] text-[var(--sf-text-1)]"
                onClick={onLoadMore}
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ArtifactsPage() {
  const [roots, setRoots] = useState<ArtifactProjectRoot[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [filters, setFilters] = useState<ArtifactListFilterState>(() => parseArtifactListFiltersFromHash().filters);
  const [draftQ, setDraftQ] = useState(() => parseArtifactListFiltersFromHash().filters.q);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [cursor, setCursor] = useState<ArtifactCursorState>(initialArtifactCursorState());
  const [runsById, setRunsById] = useState<ReadonlyMap<string, ArtifactRunRef>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const skipHashSync = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const catalog = await fetchCatalogRoots().catch(() => ({ roots: [] as ArtifactProjectRoot[] }));
      const listed = await fetchRuns().catch(() => ({ runs: [] as ArtifactRunRef[] }));
      if (cancelled) return;
      const nextRoots = catalog.roots;
      setRoots(nextRoots);
      setRunsById(new Map(listed.runs.map((run) => [run.run_id, run])));
      const parsed = parseArtifactListFiltersFromHash();
      const defaultScope = parsed.projectRoot ?? ALL_PROJECTS_SCOPE;
      setScope(defaultScope);
      if (parsed.filters) setFilters(parsed.filters);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onHash = () => {
      if (skipHashSync.current) return;
      const parsed = parseArtifactListFiltersFromHash();
      setFilters(parsed.filters);
      setDraftQ(parsed.filters.q);
      if (parsed.projectRoot != null) setScope(parsed.projectRoot);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const syncHash = useCallback((nextFilters: ArtifactListFilterState, scopeId: string) => {
    skipHashSync.current = true;
    replaceArtifactsListInHash(
      nextFilters,
      scopeId === ALL_PROJECTS_SCOPE ? undefined : scopeId,
    );
    window.setTimeout(() => {
      skipHashSync.current = false;
    }, 0);
  }, []);

  const applyFilters = useCallback(
    (next: ArtifactListFilterState) => {
      setFilters(next);
      if (scope !== null) syncHash(next, scope);
    },
    [scope, syncHash],
  );

  useEffect(() => {
    if (draftQ === filters.q) return;
    const handle = window.setTimeout(() => {
      applyFilters({ ...filters, q: draftQ });
    }, 200);
    return () => window.clearTimeout(handle);
  }, [draftQ, filters, applyFilters]);

  useEffect(() => {
    if (scope === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const listQuery = artifactListFiltersToQuery(filters);
    void fetchArtifacts(artifactScopeQuery(scope), listQuery)
      .then((page) => {
        if (cancelled) return;
        setCursor(applyArtifactPage(initialArtifactCursorState(), page, "replace"));
        setMatchCount(page.match_count ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setCursor(initialArtifactCursorState());
        setMatchCount(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, filters]);

  const scopeId = scope ?? activeArtifactProjectWireId(roots);
  const options = artifactProjectScopeOptions(roots, scopeId);
  const rows = loading
    ? null
    : artifactListRows(cursor.records, Date.now(), {
        runs: runsById,
        showProject: scopeId === ALL_PROJECTS_SCOPE,
      });
  const tabCounts = artifactTabCountsFromRecords(cursor.records);

  return (
    <ArtifactsPageView
      rows={rows}
      error={error}
      loading={scope === null || loading}
      scopeOptions={options}
      scopeId={scopeId}
      onScope={(id) => {
        setScope(id);
        syncHash(filters, id);
      }}
      filters={filters}
      onFiltersChange={applyFilters}
      onClearFilters={() => {
        setDraftQ("");
        applyFilters({ ...DEFAULT_ARTIFACT_LIST_FILTERS });
      }}
      search={draftQ}
      onSearch={setDraftQ}
      onClearSearch={() => {
        setDraftQ("");
        applyFilters({ ...filters, q: "" });
      }}
      matchCount={matchCount}
      showLoadMore={!loading && cursor.nextCursor !== null}
      tabCounts={tabCounts}
      onLoadMore={() => {
        const next = cursor.nextCursor;
        const current = scope;
        if (!next || current === null) return;
        const listQuery = { ...artifactListFiltersToQuery(filters), cursor: next };
        void fetchArtifacts(artifactScopeQuery(current), listQuery)
          .then((page) => {
            setCursor((prev) => {
              if (prev.nextCursor !== next) return prev;
              return applyArtifactPage(prev, page, "append");
            });
          })
          .catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          });
      }}
    />
  );
}