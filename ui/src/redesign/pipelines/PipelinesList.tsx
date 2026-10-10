import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuPlus, LuSearch, LuWrench } from "react-icons/lu";
import {
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type TaskListing,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { relativeTime } from "../../catalogJoin";
import { NewPipelinePanel } from "../../components/NewPipelinePanel";
import { navigate, pipelinePath } from "../../routes";
import { showToast } from "../../toast";
import { Keycap } from "../Keycap";
import { useHotkeys, type HotkeyDef } from "../keys";
import {
  movePipelineSelection,
  pipelineEditorPath,
  pipelineStartRunPath,
  pipelineWorkshopPath,
  resolvePipelineSelection,
} from "./pipelineActions";
import {
  buildPipelineListView,
  type PipelineListRow,
  type PipelineSort,
} from "./pipelineViews";
import { PipelinesInspector } from "./PipelinesInspector";
import {
  PipelinesColumnHeader,
  PipelinesTableRow,
} from "./PipelinesTableRow";

const SORT_ORDER: PipelineSort[] = ["last-run", "id", "stage-count"];

const SORT_LABEL: Record<PipelineSort, string> = {
  "last-run": "Last run",
  id: "Id",
  "stage-count": "Stage count",
};

function nextSort(sort: PipelineSort): PipelineSort {
  const index = SORT_ORDER.indexOf(sort);
  return SORT_ORDER[(index + 1) % SORT_ORDER.length] ?? "last-run";
}

export function PipelinesList({
  onNew,
}: {
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } =
    useRunCatalog();
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [pipelinesSettled, setPipelinesSettled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PipelineSort>("last-run");
  const [selectionPin, setSelectionPin] = useState<string | null | undefined>(
    undefined,
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const settledRef = useRef(false);
  const requestId = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableBodyRef = useRef<HTMLDivElement>(null);

  if (!initialLoadDone && pipelinesSettled && !catalogLoading) {
    setInitialLoadDone(true);
  }

  const load = useCallback(async () => {
    const id = ++requestId.current;
    if (settledRef.current) setRefreshing(true);
    try {
      const [pipelinesResult, tasksResult] = await Promise.all([
        fetchPipelines(),
        fetchTasks(),
      ]);
      if (id !== requestId.current) return;
      setPipelines(pipelinesResult.pipelines);
      setTasks(tasksResult.tasks);
      setPipelinesError(null);
      setLoadedAt(new Date().toISOString());
    } catch (err) {
      if (id !== requestId.current) return;
      setPipelinesError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id !== requestId.current) return;
      settledRef.current = true;
      setPipelinesSettled(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const view = useMemo(
    () =>
      buildPipelineListView({
        pipelines,
        tasks,
        runs: snapshot.runs,
        search,
        sort,
      }),
    [pipelines, tasks, snapshot.runs, search, sort],
  );

  const selectedKey = !initialLoadDone
    ? null
    : resolvePipelineSelection(
        selectionPin,
        view.filteredRows.map((row) => row.key),
      );

  const selectedRow =
    view.filteredRows.find((row) => row.key === selectedKey) ?? null;
  const catalogFailed = initialLoadDone && Boolean(catalogError);
  const showTableChrome = !initialLoadDone || pipelines.length > 0;
  const showFirstError =
    initialLoadDone && pipelines.length === 0 && Boolean(pipelinesError);
  const showEmpty =
    initialLoadDone && pipelines.length === 0 && !pipelinesError;
  const showSearchEmpty =
    initialLoadDone && pipelines.length > 0 && view.filteredRows.length === 0;

  function scrollRowIntoView(key: string) {
    const body = tableBodyRef.current;
    if (!body) return;
    const rows = body.querySelectorAll<HTMLElement>("[data-pipeline-row]");
    for (const row of rows) {
      if (row.dataset.pipelineRow === key) {
        row.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }

  function moveSelection(delta: number) {
    const next = movePipelineSelection(
      view.filteredRows.map((row) => row.key),
      selectedKey,
      delta,
    );
    if (!next) return;
    setSelectionPin(next);
    scrollRowIntoView(next);
  }

  function openEditor(row: PipelineListRow | null) {
    const path = pipelineEditorPath(row);
    if (path) navigate(path);
  }

  function startRun(row: PipelineListRow | null) {
    const path = pipelineStartRunPath(row);
    if (path) navigate(path);
  }

  function openWorkshop(row: PipelineListRow | null) {
    const path = pipelineWorkshopPath(row);
    if (path) navigate(path);
  }

  const hotkeys: HotkeyDef[] = [
    { key: "j", scope: "pipelines", handler: () => moveSelection(1) },
    { key: "k", scope: "pipelines", handler: () => moveSelection(-1) },
    {
      key: "enter",
      scope: "pipelines",
      handler: (event) => {
        if (!selectedRow) return;
        event.preventDefault();
        openEditor(selectedRow);
      },
    },
    {
      key: "s",
      scope: "pipelines",
      handler: (event) => {
        if (!selectedRow) return;
        event.preventDefault();
        startRun(selectedRow);
      },
    },
    {
      key: "w",
      scope: "pipelines",
      handler: (event) => {
        if (!selectedRow) return;
        event.preventDefault();
        openWorkshop(selectedRow);
      },
    },
    {
      key: "n",
      scope: "pipelines",
      handler: (event) => {
        event.preventDefault();
        setPanelOpen(true);
      },
    },
    {
      key: "/",
      scope: "pipelines",
      handler: (event) => {
        event.preventDefault();
        searchRef.current?.focus();
      },
    },
    {
      key: "escape",
      scope: "pipelines",
      allowInInput: true,
      handler: (event) => {
        const searchFocused =
          searchRef.current !== null &&
          (event.target === searchRef.current ||
            document.activeElement === searchRef.current);
        if (searchFocused) {
          event.preventDefault();
          setSearch("");
          return;
        }
        event.preventDefault();
        setSelectionPin(null);
      },
    },
  ];

  useHotkeys(
    hotkeys.map((def) => ({ ...def, when: () => !panelOpen })),
    "pipelines",
  );

  async function onPipelineCreated(pipeline: PipelineListing) {
    setPanelOpen(false);
    await load();
    showToast(`Pipeline created · ${pipeline.id}`);
    onNew(
      pipelinePath(pipeline.id, {
        ...(pipeline.project_root
          ? { project_root: pipeline.project_root }
          : {}),
      }),
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b border-b-[#ffffff12] px-5">
        <div className="flex shrink-0 items-baseline gap-2.5">
          <h1 className="text-[18px] font-semibold text-[var(--sf-text-1)]">
            Pipelines
          </h1>
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            {view.filteredCount}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <label className="flex h-9 min-w-[240px] max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-[#ffffff12] bg-[var(--sf-ground)] px-3">
            <LuSearch
              className="size-3.5 shrink-0 text-[var(--sf-text-3)]"
              aria-hidden
            />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search pipelines by id, path, or stage"
              aria-label="Search pipelines"
              className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
            />
            <Keycap>/</Keycap>
          </label>
          <button
            type="button"
            className="sf-btn sf-btn--secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={selectedRow === null}
            onClick={() => openWorkshop(selectedRow)}
          >
            <LuWrench className="size-3.5" aria-hidden />
            Open in Workshop
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--primary shrink-0"
            onClick={() => setPanelOpen(true)}
          >
            <LuPlus className="size-3.5" aria-hidden />
            New pipeline
            <Keycap className="border-[#0c0d0f2e] text-[#5a5d66]">N</Keycap>
          </button>
        </div>
      </header>

      {showTableChrome ? (
        <div className="flex h-10 w-full shrink-0 items-center border-b border-b-[#ffffff12] px-5">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[13px]"
            onClick={() => setSort((current) => nextSort(current))}
          >
            <span className="text-[var(--sf-text-3)]">Sort:</span>
            <span className="text-[var(--sf-text-1)]">{SORT_LABEL[sort]}</span>
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {showTableChrome ? (
            <PipelinesColumnHeader showRoot={view.catalogRootsVisible} />
          ) : null}
          <div
            ref={tableBodyRef}
            className="min-h-0 flex-1 overflow-y-auto"
            aria-busy={!initialLoadDone}
          >
            {!initialLoadDone ? (
              <SkeletonRows showRoot={view.catalogRootsVisible} />
            ) : null}
            {showFirstError ? (
              <div className="px-5 py-8">
                <p className="mb-3 text-[13px] text-[var(--sf-fail)]">
                  {pipelinesError}
                </p>
                <button
                  type="button"
                  className="sf-btn sf-btn--secondary"
                  onClick={() => void load()}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {showEmpty ? (
              <div className="px-5 py-8">
                <p className="mb-3 text-[13px] text-[var(--sf-text-2)]">
                  No pipelines in the manifest yet. Add a{" "}
                  <span className="font-['Geist_Mono',monospace]">
                    stageflow.yaml
                  </span>{" "}
                  catalog entry or run{" "}
                  <span className="font-['Geist_Mono',monospace]">sf init</span>
                  .
                </p>
                <button
                  type="button"
                  className="sf-btn sf-btn--primary"
                  onClick={() => setPanelOpen(true)}
                >
                  New pipeline
                </button>
              </div>
            ) : null}
            {showSearchEmpty ? (
              <p className="px-5 py-4 text-[13px] text-[var(--sf-text-2)]">
                No pipelines match this search.
              </p>
            ) : null}
            {initialLoadDone && view.filteredRows.length > 0
              ? view.filteredRows.map((row) => (
                  <PipelinesTableRow
                    key={row.key}
                    row={row}
                    selected={row.key === selectedKey}
                    showRoot={view.catalogRootsVisible}
                    catalogFailed={catalogFailed}
                    onSelect={() => setSelectionPin(row.key)}
                    onOpen={() => openEditor(row)}
                  />
                ))
              : null}
          </div>
          <footer className="flex h-10 w-full shrink-0 items-center gap-3 border-t border-t-[#ffffff12] px-5 text-[11px] text-[var(--sf-text-3)]">
            <span className="inline-flex shrink-0 items-center gap-1">
              <Keycap>J</Keycap>
              <span>/</span>
              <Keycap>K</Keycap>
              <span>move</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <Keycap>Enter</Keycap>
              <span>open editor</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <Keycap>S</Keycap>
              <span>start run</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <Keycap>N</Keycap>
              <span>new pipeline</span>
            </span>
            <span className="ml-auto flex min-w-0 items-center justify-end gap-2">
              <FooterStatus
                refreshing={refreshing}
                initialLoadDone={initialLoadDone}
                pipelineCount={pipelines.length}
                pipelinesError={pipelinesError}
                catalogError={catalogFailed ? catalogError : null}
                loadedAt={loadedAt}
                onRetry={() => void load()}
              />
            </span>
          </footer>
        </div>
        <aside
          className="flex min-h-0 w-[420px] shrink-0 flex-col overflow-hidden border-l border-[#ffffff12]"
          aria-label="Pipeline inspector"
        >
          <PipelinesInspector
            row={selectedRow}
            initialLoadDone={initialLoadDone}
            catalogFailed={catalogFailed}
            onOpenEditor={() => openEditor(selectedRow)}
            onStartRun={() => startRun(selectedRow)}
            onOpenWorkshop={() => openWorkshop(selectedRow)}
          />
        </aside>
      </div>
      <NewPipelinePanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        onCreated={(pipeline) => void onPipelineCreated(pipeline)}
        pipelines={pipelines}
      />
    </div>
  );
}

function FooterStatus({
  refreshing,
  initialLoadDone,
  pipelineCount,
  pipelinesError,
  catalogError,
  loadedAt,
  onRetry,
}: {
  refreshing: boolean;
  initialLoadDone: boolean;
  pipelineCount: number;
  pipelinesError: string | null;
  catalogError: string | null;
  loadedAt: string | null;
  onRetry: () => void;
}) {
  if (refreshing) return <span>Refreshing…</span>;
  if (initialLoadDone && pipelineCount > 0 && pipelinesError) {
    return (
      <>
        <span className="truncate text-[var(--sf-fail)]">
          {catalogError ? `${pipelinesError} · ${catalogError}` : pipelinesError}
        </span>
        <button
          type="button"
          className="sf-btn sf-btn--secondary shrink-0"
          onClick={onRetry}
        >
          Retry
        </button>
      </>
    );
  }
  if (initialLoadDone && catalogError) {
    return <span className="truncate text-[var(--sf-fail)]">{catalogError}</span>;
  }
  if (initialLoadDone && !pipelinesError && loadedAt) {
    return (
      <span>
        {pipelineCount} pipelines · refreshed {relativeTime(loadedAt)}
      </span>
    );
  }
  return null;
}

function SkeletonRows({ showRoot }: { showRoot: boolean }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex min-h-[44px] w-full items-center gap-2 border-b border-b-[#ffffff12] px-5"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
            <div className="h-2.5 w-48 max-w-full animate-pulse rounded bg-[var(--sf-raised)]" />
          </div>
          <div className="h-1.5 w-14 shrink-0 animate-pulse rounded-full bg-[var(--sf-raised)]" />
          <div className="h-3 w-4 shrink-0 animate-pulse rounded bg-[var(--sf-raised)]" />
          {showRoot ? (
            <div className="h-3 w-[88px] shrink-0 animate-pulse rounded bg-[var(--sf-raised)]" />
          ) : null}
          <div className="h-5 w-16 shrink-0 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-3 w-4 shrink-0 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-6 w-20 shrink-0 animate-pulse rounded-full bg-[var(--sf-raised)]" />
          <div className="h-3 w-12 shrink-0 animate-pulse rounded bg-[var(--sf-raised)]" />
        </div>
      ))}
    </div>
  );
}
