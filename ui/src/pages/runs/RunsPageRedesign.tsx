import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import {
  groupRunsForDisplay,
  type RunsDisplayFilter,
} from "../../catalog/runsGrouping";
import { countRunsThisWeek } from "../../catalog/stats";
import { runsFilterCounts, runsForPipelineView } from "../../catalog/views";
import { runStagePath } from "../../routes";
import { useHotkeys } from "../../redesign/keys";
import { FilterTabs } from "../../redesign/shell/FilterTabs";
import { PageHeader } from "../../redesign/shell/PageHeader";
import { DataTable } from "../../redesign/shell/DataTable";
import { retryStage } from "../../api";
import type { RunSummary } from "../../api";
import { useRunCatalogHandle } from "../../catalog/useRunCatalog";
import { RunsColumnHeader, RunGroup } from "../../redesign/runs/RunsTableChrome";
import {
  RunsFooter,
  RunsFooterHints,
  RunsTableRow,
} from "../../redesign/runs/RunsTableRow";
import { RUNS_COL_HEADER } from "../../redesign/runs/runsTableLayout";

function flattenGroups(
  groups: ReturnType<typeof groupRunsForDisplay>,
): RunSummary[] {
  return groups.flatMap((g) => g.runs);
}

function RunsTableSkeleton() {
  return (
    <>
      <div className={`${RUNS_COL_HEADER} opacity-40`} aria-hidden="true">
        <span className="h-3 w-16 rounded bg-[var(--sf-raised)]" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="flex h-11 items-center gap-3 border-b border-b-[#ffffff12] px-5"
          aria-hidden="true"
        >
          <div className="h-6 w-20 rounded-full bg-[var(--sf-raised)]" />
          <div className="h-3 min-w-0 flex-1 rounded bg-[var(--sf-raised)]" />
        </div>
      ))}
    </>
  );
}

export function RunsPageRedesign({
  onOpen,
  onNew,
}: {
  onOpen: (runId: string) => void;
  onNew: () => void;
}) {
  const { snapshot, error, loading } = useRunCatalog();
  const catalog = useRunCatalogHandle();
  const [filter, setFilter] = useState<RunsDisplayFilter>("all");
  const [search, setSearch] = useState("");
  const [pipelineId, setPipelineId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retryRunId, setRetryRunId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const counts = runsFilterCounts(snapshot);
  const waitingCount = counts.waiting;
  const weekCount = countRunsThisWeek(snapshot.runs, now);

  const baseRuns = useMemo(() => {
    if (!pipelineId) return snapshot.runs;
    return runsForPipelineView(snapshot, pipelineId);
  }, [snapshot, pipelineId]);

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return baseRuns;
    return baseRuns.filter((run) => {
      const hay = [
        run.run_id,
        run.task_id,
        run.pipeline_id,
        run.waiting_summary,
        run.failed_reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [baseRuns, search]);

  const groups = useMemo(
    () => groupRunsForDisplay(filteredRuns, filter, now),
    [filteredRuns, filter, now],
  );

  const flat = useMemo(() => flattenGroups(groups), [groups]);

  useEffect(() => {
    if (flat.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !flat.some((r) => r.run_id === selectedId)) {
      setSelectedId(flat[0].run_id);
    }
  }, [flat, selectedId]);

  const selectedIndex = selectedId
    ? flat.findIndex((r) => r.run_id === selectedId)
    : -1;
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : null;

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (flat.length === 0) return;
      const current = selectedIndex >= 0 ? selectedIndex : 0;
      const next = (current + delta + flat.length) % flat.length;
      setSelectedId(flat[next].run_id);
    },
    [flat, selectedIndex],
  );

  const openRun = useCallback(
    (run: RunSummary) => {
      onOpen(run.run_id);
    },
    [onOpen],
  );

  const answerRun = useCallback(
    (run: RunSummary) => {
      if (!run.waiting_stage_id) return;
      window.location.hash = `#${runStagePath(run.run_id, run.waiting_stage_id)}`;
    },
    [],
  );

  const retryRun = useCallback(async (run: RunSummary) => {
    if (!run.failed_stage_id) return;
    setRetryRunId(run.run_id);
    setRetryError(null);
    try {
      await retryStage(run.run_id, run.failed_stage_id);
      catalog.refresh();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryRunId(null);
    }
  }, [catalog]);

  useHotkeys(
    [
      {
        key: "j",
        scope: "runs",
        when: () => flat.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(1);
        },
      },
      {
        key: "k",
        scope: "runs",
        when: () => flat.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(-1);
        },
      },
      {
        key: "enter",
        scope: "runs",
        when: () => Boolean(selected),
        handler: (e) => {
          e.preventDefault();
          if (selected) openRun(selected);
        },
      },
      {
        key: "r",
        scope: "runs",
        when: () => Boolean(selected?.failed_stage_id),
        handler: (e) => {
          e.preventDefault();
          if (selected) void retryRun(selected);
        },
      },
      {
        key: "a",
        scope: "runs",
        when: () => Boolean(selected?.waiting_stage_id),
        handler: (e) => {
          e.preventDefault();
          if (selected) answerRun(selected);
        },
      },
    ],
    "runs",
  );

  const pipelineOptions = useMemo(() => {
    const ids = new Set(snapshot.runs.map((r) => r.pipeline_id));
    return [...ids].sort();
  }, [snapshot.runs]);

  const tabs = [
    { id: "all", label: "All", count: counts.all },
    { id: "waiting", label: "Needs you", count: counts.waiting },
    { id: "running", label: "Running", count: counts.running },
    { id: "failed", label: "Failed", count: counts.failed },
    { id: "finished", label: "Succeeded", count: counts.finished },
  ];

  const showEmpty = !loading && flat.length === 0;

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col">
      <PageHeader
        title="Runs"
        subtitle={`${weekCount} this week · ${waitingCount} waiting on you`}
        actions={
          <>
            <button type="button" className="sf-btn sf-btn--secondary" disabled>
              Filter
            </button>
            <button type="button" className="sf-btn sf-btn--primary" onClick={onNew}>
              Start a run
            </button>
          </>
        }
      />
      <FilterTabs tabs={tabs} activeId={filter} onChange={(id) => setFilter(id as RunsDisplayFilter)} />
      <div className="flex h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-b-[#ffffff12] px-5">
        <label className="flex items-center gap-2 text-[11px] text-[var(--sf-text-3)]">
          <span className="font-['Geist_Mono',monospace] uppercase">Pipeline</span>
          <select
            className="min-w-[160px] rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2 py-1.5 text-[13px] text-[var(--sf-text-1)]"
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
          >
            <option value="">All pipelines</option>
            {pipelineOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[220px] flex-1 items-center gap-2 text-[11px] text-[var(--sf-text-3)]">
          <span className="font-['Geist_Mono',monospace] uppercase">Search</span>
          <input
            type="search"
            className="min-w-0 flex-1 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2 py-1.5 text-[13px] text-[var(--sf-text-1)]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search runs, tasks, ids"
          />
        </label>
      </div>

      {error ? (
        <p className="px-5 py-2 text-[13px] text-[var(--sf-fail)]">
          Could not load runs: {error}
        </p>
      ) : null}
      {retryError ? (
        <p className="px-5 py-2 text-[13px] text-[var(--sf-fail)]">{retryError}</p>
      ) : null}

      <RunsColumnHeader />

      {loading ? (
        <RunsTableSkeleton />
      ) : showEmpty ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-2)]">
          No runs match this filter.
        </p>
      ) : (
        <DataTable className="min-w-0 flex-1">
          {groups.map((group) => (
            <RunGroup
              key={group.id}
              groupId={group.id}
              label={group.label}
              runs={group.runs}
              now={now}
            >
              {group.runs.map((run) => (
                <RunsTableRow
                  key={run.run_id}
                  run={run}
                  groupId={group.id}
                  selected={run.run_id === selectedId}
                  now={now}
                  onOpen={() => openRun(run)}
                  onAnswer={() => answerRun(run)}
                  onRetry={() => void retryRun(run)}
                  retryBusy={retryRunId === run.run_id}
                />
              ))}
            </RunGroup>
          ))}
        </DataTable>
      )}

      <RunsFooter visibleRuns={flat} hints={<RunsFooterHints />} />
    </div>
  );
}
