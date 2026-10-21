import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuPlus, LuSearch, LuX } from "react-icons/lu";
import {
  EvalApiError,
  fetchEvalEngine,
  fetchEvals,
  installEvalSample,
  type EvalEngineStatus,
  type EvalListResponse,
} from "../../api";
import { datasetsPath, evalNewPath, evalPath, evalsPath, navigate } from "../../routes";
import { showToast } from "../../toast";
import { useHotkeys } from "../keys";
import { PageHeader } from "../shell/PageHeader";
import { EvalRow, COLUMN } from "./EvalRow";
import { openRunDialog } from "./run/runDialogStore";
import { EngineBanner, RegressionBanner } from "./EvalsBanners";
import { EvalsEmptyState } from "./EvalsEmptyState";
import {
  EMPTY_FOOTER,
  EVALS_SUBTITLE,
  EVAL_SAMPLE_ID,
  bannerModel,
  engineBanner,
  evalRowModel,
  evalTabs,
  filterEvals,
  footerText,
  moveSelection,
  saturatedGuidance,
  type EvalFilterTab,
} from "./evalListModel";

const MONO = "font-['Geist_Mono',monospace]";
const HEAD = "text-xs text-[var(--sf-text-3)]";

function Key({ children }: { children: string }) {
  return (
    <span
      className={`rounded-sm border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-[5px] ${MONO} text-[11px] text-[var(--sf-text-2)]`}
    >
      {children}
    </span>
  );
}

export function EvalsRedesign({ stage }: { stage?: string }) {
  const [data, setData] = useState<EvalListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [engine, setEngine] = useState<EvalEngineStatus | null>(null);
  const [tab, setTab] = useState<EvalFilterTab>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchEvals(stage ? { target_stage: stage } : {}));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [stage]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchEvalEngine().then(
      (status) => {
        if (!cancelled) setEngine(status);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const items = data?.items ?? [];
  const tabs = useMemo(() => evalTabs(items), [items]);
  const visible = useMemo(() => filterEvals(items, { tab, query, stage }), [items, tab, query, stage]);
  const rows = useMemo(() => visible.map(evalRowModel), [visible]);
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const banner = bannerModel(data?.banner ?? null);
  const engineNotice = engineBanner(engine);
  const guidance = saturatedGuidance(items);

  useEffect(() => {
    if (selectedId !== null && !ids.includes(selectedId)) setSelectedId(null);
  }, [ids, selectedId]);

  function open(id: string) {
    const row = rows.find((r) => r.id === id);
    if (row) navigate(row.href);
  }

  async function trySample() {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const result = await installEvalSample();
      navigate(evalPath(result.eval_id, { openRun: true }));
    } catch (err) {
      if (err instanceof EvalApiError && err.code === "SAMPLE_EXISTS") {
        navigate(evalPath(EVAL_SAMPLE_ID, { openRun: true }));
      } else {
        showToast(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSampleBusy(false);
    }
  }

  useHotkeys(
    [
      {
        key: "ArrowDown",
        scope: "evals",
        handler: (e) => {
          e.preventDefault();
          setSelectedId((current) => moveSelection(ids, current, 1));
        },
      },
      {
        key: "ArrowUp",
        scope: "evals",
        handler: (e) => {
          e.preventDefault();
          setSelectedId((current) => moveSelection(ids, current, -1));
        },
      },
      {
        key: "Enter",
        scope: "evals",
        when: () => selectedId !== null && !(document.activeElement instanceof HTMLButtonElement),
        handler: (e) => {
          e.preventDefault();
          if (selectedId !== null) open(selectedId);
        },
      },
      {
        key: "/",
        scope: "evals",
        handler: (e) => {
          e.preventDefault();
          searchRef.current?.focus();
        },
      },
    ],
    "evals",
  );

  const isEmpty = !loading && !error && items.length === 0 && !stage;
  const noMatches = !loading && !error && rows.length === 0;
  const showTable = !loading && !error && rows.length > 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title="Evals"
        subtitle={EVALS_SUBTITLE}
        actions={
          <>
            <button
              type="button"
              onClick={() => navigate(datasetsPath())}
              className="flex h-8 items-center rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] font-medium text-[var(--sf-text-1)]"
            >
              Datasets
            </button>
            <button
              type="button"
              onClick={() => navigate(evalNewPath())}
              className="flex h-8 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
            >
              <LuPlus className="size-3.5" aria-hidden />
              New eval
            </button>
          </>
        }
      />

      {isEmpty ? (
        <>
          {engineNotice ? (
            <div className="px-5 pt-4">
              <EngineBanner banner={engineNotice} />
            </div>
          ) : null}
          <EvalsEmptyState busy={sampleBusy} onTrySample={() => void trySample()} onCreate={() => navigate(evalNewPath())} />
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {engineNotice ? <EngineBanner banner={engineNotice} /> : null}
          {banner ? <RegressionBanner banner={banner} onCompare={() => navigate(banner.compareHref)} /> : null}

          {!error && !loading ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1" role="tablist" aria-label="Eval filters">
                {tabs.map((t) => {
                  const active = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      disabled={t.soon}
                      onClick={() => setTab(t.id)}
                      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] ${
                        active
                          ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
                          : "border-transparent text-[var(--sf-text-2)]"
                      } ${t.soon ? "cursor-default opacity-70" : ""}`}
                      style={
                        t.id === "regressed" && !active && (t.count ?? 0) > 0 ? { color: "var(--sf-fail)" } : undefined
                      }
                    >
                      {t.label}
                      {t.count !== undefined ? (
                        <span className={`${MONO} text-xs ${active ? "text-[var(--sf-text-2)]" : ""}`}>{t.count}</span>
                      ) : null}
                      {t.soon ? (
                        <span className="rounded-sm bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-3)]">
                          soon
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <label className="flex h-8 w-[300px] items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2.5">
                <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                  placeholder="Search evals, stages or datasets"
                  className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                />
              </label>
            </div>
          ) : null}

          {stage ? (
            <div className="flex">
              <span className="flex h-6 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] pl-2 pr-1 text-xs text-[var(--sf-text-2)]">
                Showing evals for stage <span className={`${MONO} text-[var(--sf-text-1)]`}>{stage}</span>
                <button
                  type="button"
                  aria-label="Show all evals"
                  onClick={() => navigate(evalsPath())}
                  className="flex size-4 items-center justify-center rounded-sm text-[var(--sf-text-3)] hover:text-[var(--sf-text-1)]"
                >
                  <LuX className="size-3" aria-hidden />
                </button>
              </span>
            </div>
          ) : null}

          {loading ? <p className="text-xs text-[var(--sf-text-3)]">Loading evals…</p> : null}
          {error ? (
            <div className="flex items-center gap-3 text-xs text-[var(--sf-fail)]" role="alert">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-1 text-[var(--sf-text-1)]"
              >
                Retry
              </button>
            </div>
          ) : null}
          {noMatches ? <p className="py-8 text-center text-[13px] text-[var(--sf-text-2)]">No evals match this filter.</p> : null}

          {showTable ? (
            <div
              role="grid"
              aria-label="Evals"
              className="overflow-hidden rounded-lg border border-[var(--sf-hairline)]"
            >
              <div
                role="row"
                className="flex w-full items-center gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-2.5"
              >
                <span role="columnheader" className={`${HEAD} min-w-0 flex-1`}>Eval</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.target} shrink-0`}>Target</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.dataset} shrink-0`}>Dataset</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.lastRun} shrink-0`}>Last run</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.trend} shrink-0`}>Trend</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.cost} shrink-0`}>Cost / run</span>
                <span role="columnheader" className={`${HEAD} ${COLUMN.status} shrink-0`}>Status</span>
                <span className="block w-[52px] shrink-0" />
                <span className="block w-3.5 shrink-0" />
              </div>
              {rows.map((row) => (
                <EvalRow
                  key={row.id}
                  row={row}
                  selected={selectedId === row.id}
                  onSelect={() => setSelectedId(row.id)}
                  onOpen={() => navigate(row.href)}
                  onRun={() => openRunDialog(row.id)}
                />
              ))}
            </div>
          ) : null}

          {showTable && guidance ? (
            <p className="text-xs leading-[1.5] text-[var(--sf-text-3)]">{guidance}</p>
          ) : null}
        </div>
      )}

      <footer className="flex h-8 w-full shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-rail)] px-5 text-xs text-[var(--sf-text-3)]">
        <span>{isEmpty ? EMPTY_FOOTER : data ? footerText(data.footer) : ""}</span>
        {isEmpty ? (
          <span>No evals yet</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Key>↑</Key>
            <Key>↓</Key>
            <span>to move</span>
            <span>·</span>
            <Key>↵</Key>
            <span>to open</span>
          </span>
        )}
      </footer>
    </div>
  );
}

