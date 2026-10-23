import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuCircleAlert, LuHistory, LuPlus, LuSearch, LuUpload } from "react-icons/lu";
import {
  EvalApiError,
  convertEvalDataset,
  createEvalDataset,
  fetchEval,
  fetchEvalDataset,
  fetchEvalDatasets,
  fetchEvals,
  patchEvalDatasetCases,
} from "../../../api/evalsClient";
import type {
  EvalCaseOp,
  EvalCreateDatasetInput,
  EvalDatasetCase,
  EvalDatasetDetail,
  EvalDatasetListItem,
  EvalDatasetTarget,
  EvalListItem,
} from "../../../api/evalTypes";
import { datasetPath, evalsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { PageHeader } from "../../shell/PageHeader";
import { CandidatesDialog } from "./CandidatesDialog";
import { SessionCandidatesDialog } from "./SessionCandidatesDialog";
import { DatasetTable } from "./DatasetTable";
import { ScenarioEditor } from "./ScenarioEditor";
import { ScenarioTable } from "./ScenarioTable";
import { MIXED_USE_BANNER, invalidScenarioBanner, isMixedUse } from "./scenarioModel";
import { BTN, BTN_PRIMARY, MONO } from "./DialogShell";
import { AddCaseDialog, ConfirmDialog, NewDatasetDialog } from "./SmallDialogs";
import { UploadDialog } from "./UploadDialog";
import {
  INITIAL_SAVE,
  buildCellEditOp,
  buildDeleteOp,
  datasetColumns,
  datasetQuery,
  datasetSubtitle,
  datasetTabs,
  firstInvalidReason,
  footerNote,
  invalidBanner,
  isJsonValue,
  pageInfo,
  projectRootOf,
  railMeta,
  readOnlyBanner,
  saveLabel,
  saveReducer,
  serializeJsonl,
  type CellKey,
  type DatasetTab,
  type DatasetView,
} from "./datasetModel";
import { toCreateDatasetInput, type UploadConfirm } from "./uploadModel";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function targetOf(item: EvalListItem | undefined): EvalDatasetTarget | undefined {
  if (!item) return undefined;
  if (item.target.kind === "agent") return { agent_id: item.target.agent_id };
  const { pipeline_path, stage_id, file } = item.target;
  const target: EvalDatasetTarget = {
    ...(pipeline_path ? { pipeline_path } : {}),
    ...(stage_id ? { stage_id } : {}),
    ...(file ? { file } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

export function DatasetsPage({ datasetId, evalId }: { datasetId?: string; evalId?: string }) {
  const [list, setList] = useState<EvalDatasetListItem[] | null>(null);
  const [evals, setEvals] = useState<EvalListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"name" | { name: string } | null>(null);

  const loadList = useCallback(async () => {
    try {
      setList((await fetchEvalDatasets()).items);
      setListError(null);
    } catch (err) {
      setListError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void loadList();
    fetchEvals().then(
      (res) => setEvals(res.items),
      () => {},
    );
  }, [loadList]);

  useEffect(() => {
    if (!datasetId && list && list.length > 0 && list[0]) window.location.replace(`#${datasetPath(list[0].id)}`);
  }, [datasetId, list]);

  const selected = list?.find((d) => d.id === datasetId);
  const names = (list ?? []).map((d) => d.id);

  async function createNew(name: string, req: UploadConfirm) {
    await createEvalDataset(toCreateDatasetInput(req, { name }) as EvalCreateDatasetInput);
    setCreating(null);
    await loadList();
    navigate(datasetPath(name));
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[248px] shrink-0 flex-col gap-3 border-r border-r-[var(--sf-hairline)] bg-[var(--sf-ground)] px-3 py-5">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">Datasets</h2>
            <button
              type="button"
              onClick={() => setCreating("name")}
              className="flex items-center gap-1 text-[13px] text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            >
              <LuPlus className="size-3.5" aria-hidden />
              New
            </button>
          </div>
          {listError ? (
            <p role="alert" className="px-1 text-xs text-[var(--sf-fail)]">{listError}</p>
          ) : null}
          <nav className="flex flex-col gap-1 overflow-y-auto" aria-label="Datasets">
            {(list ?? []).map((item) => {
              const meta = railMeta(item);
              const active = item.id === datasetId;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => navigate(datasetPath(item.id))}
                  className={`flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left ${active ? "bg-[var(--sf-raised)]" : "hover:bg-[var(--sf-active)]"}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={`${MONO} truncate text-[13px] text-[var(--sf-text-1)]`}>{item.id}</span>
                    {meta.sample ? (
                      <span className="shrink-0 rounded-sm bg-[var(--sf-active)] px-1.5 text-[11px] text-[var(--sf-text-3)]">sample</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--sf-text-3)]">
                    {meta.meta}
                    {meta.note ? ` · ${meta.note}` : ""}
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {datasetId ? (
            <DatasetDetailView
              key={datasetId}
              datasetId={datasetId}
              evalId={evalId}
              projectRoot={projectRootOf(selected)}
              listLoaded={list !== null}
              evals={evals}
              onChanged={() => void loadList()}
            />
          ) : list !== null && list.length === 0 ? (
            <>
              <PageHeader title="Datasets" />
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5">
                <p className="text-[13px] text-[var(--sf-text-2)]">No datasets yet. Add one when you create an eval.</p>
                <button type="button" className={BTN} onClick={() => navigate(evalsPath())}>Back to Evals</button>
              </div>
            </>
          ) : (
            <PageHeader title="Datasets" />
          )}
        </div>
      </div>

      {creating === "name" ? (
        <NewDatasetDialog existingNames={names} onClose={() => setCreating(null)} onContinue={(name) => setCreating({ name })} />
      ) : null}
      {creating !== null && creating !== "name" ? (
        <UploadDialog
          open
          title="Upload cases"
          subtitle={`New dataset ${creating.name} · Pick fields to import`}
          onClose={() => setCreating(null)}
          onConfirm={(req) => createNew(creating.name, req)}
        />
      ) : null}
    </div>
  );
}

function DatasetDetailView({
  datasetId,
  evalId,
  projectRoot,
  listLoaded,
  evals,
  onChanged,
}: {
  datasetId: string;
  evalId: string | undefined;
  projectRoot: string | undefined;
  listLoaded: boolean;
  evals: EvalListItem[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<EvalDatasetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DatasetTab>("all");
  const [view, setView] = useState<DatasetView>("table");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [jsonl, setJsonl] = useState<string | null>(null);
  const [save, dispatchSave] = useReducer(saveReducer, INITIAL_SAVE);
  const [dialog, setDialog] = useState<"upload" | "runs" | "sessions" | "add" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<EvalDatasetCase | null>(null);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [expectedFields, setExpectedFields] = useState<string[]>([]);
  const [allIds, setAllIds] = useState<string[] | null>(null);
  const hashRef = useRef("");
  const queue = useRef<Promise<void>>(Promise.resolve());

  const effectiveEvalId = evalId ?? detail?.used_by[0];
  const evalItem = evals.find((e) => e.id === effectiveEvalId);
  const target = targetOf(evalItem);
  const root = projectRoot ?? projectRootOf(evalItem);
  const agentEval = evalItem?.target.kind === "agent";
  const defaultMode = evalItem?.conversation?.mode ?? "script";
  const kinds = useMemo(() => new Map(evals.map((e) => [e.id, e.target.kind] as const)), [evals]);
  const mixedUse = detail ? isMixedUse(detail.used_by, kinds) : false;
  const stageLabel = evalItem ? ((evalItem.target.kind === "stage" ? evalItem.target.stage_id : undefined) ?? evalItem.target.label) : null;

  useEffect(() => {
    const t = window.setTimeout(() => {
      setQ(search);
      setPage(0);
    }, 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const query = useMemo(() => datasetQuery({ tab, q, page, evalId, projectRoot: root }), [tab, q, page, evalId, root]);

  const load = useCallback(
    async (silent = false) => {
      try {
        const res = await fetchEvalDataset(datasetId, query);
        hashRef.current = res.hash;
        setDetail(res);
        setError(null);
      } catch (err) {
        if (!silent || err instanceof EvalApiError) setError(messageOf(err));
      }
    },
    [datasetId, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!effectiveEvalId) return;
    let cancelled = false;
    fetchEval(effectiveEvalId, root).then(
      (res) => {
        if (cancelled) return;
        const names = (res.definition?.graders ?? [])
          .filter((g) => g.type === "reference" && typeof g.expected === "string")
          .map((g) => String(g.expected).replace(/^expected\./, "").split(".")[0] ?? "")
          .filter((n) => n !== "");
        setExpectedFields([...new Set(names)]);
        setToolIds((res.agent?.tools ?? []).map((t) => t.id));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveEvalId, root]);

  useEffect(() => {
    if (view !== "jsonl" || !detail) return;
    let cancelled = false;
    (async () => {
      const lines: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const res = await fetchEvalDataset(datasetId, {
          offset,
          limit: 200,
          filter: "all",
          ...(root ? { project_root: root } : {}),
        });
        lines.push(serializeJsonl(res.cases));
        if (offset + 200 >= res.cases_total) break;
      }
      if (!cancelled) setJsonl(lines.filter((l) => l !== "").join("\n"));
    })().catch((err: unknown) => {
      if (!cancelled) setJsonl(`# ${messageOf(err)}`);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, detail?.hash]);

  useEffect(() => {
    if (dialog !== "upload" && dialog !== "add") {
      setAllIds(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const ids: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const res = await fetchEvalDataset(datasetId, {
          offset,
          limit: 200,
          filter: "all",
          ...(root ? { project_root: root } : {}),
        });
        ids.push(...res.cases.map((c) => c.id));
        if (offset + 200 >= res.cases_total) break;
      }
      if (!cancelled) setAllIds(ids);
    })().catch((err: unknown) => {
      if (!cancelled) {
        showToast(messageOf(err));
        setDialog(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dialog, datasetId, root]);

  const patch = useCallback(
    (ops: EvalCaseOp[]) => {
      const run = async () => {
        dispatchSave({ type: "start" });
        try {
          const res = await patchEvalDatasetCases(datasetId, {
            ...(root ? { project_root: root } : {}),
            base_hash: hashRef.current,
            ops,
          });
          hashRef.current = res.hash;
          dispatchSave({ type: "success" });
          await load(true);
          onChanged();
        } catch (err) {
          if (err instanceof EvalApiError && err.code === "FILE_CHANGED") dispatchSave({ type: "conflict" });
          else {
            dispatchSave({ type: "fail", message: messageOf(err) });
            showToast(messageOf(err));
          }
          throw err;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next.catch(() => {});
      return next;
    },
    [datasetId, root, load, onChanged],
  );

  function reload() {
    dispatchSave({ type: "reset" });
    setJsonl(null);
    void load();
  }

  const editable = detail?.editable === true;
  const columnInfo = useMemo(() => (detail ? datasetColumns(detail) : null), [detail]);
  const scenarioBanner = detail && agentEval ? invalidScenarioBanner(detail.invalid_total, detail.cases_total) : null;
  const banner = detail
    ? agentEval
      ? scenarioBanner
        ? { ...scenarioBanner, reason: firstInvalidReason(detail) }
        : null
      : invalidBanner(detail)
    : null;
  const readOnlyFormat = detail && !detail.editable ? readOnlyBanner(detail.format) : null;
  const paging = pageInfo(page, detail?.matched_total ?? 0);
  const requiredNames = useMemo(
    () => new Set((detail?.input_fields ?? []).filter((f) => f.required).map((f) => f.name)),
    [detail],
  );
  const jsonFields = useMemo(() => {
    const names = new Set<string>();
    for (const c of detail?.cases ?? []) {
      for (const [k, v] of Object.entries(c.input ?? {})) if (isJsonValue(v)) names.add(k);
    }
    return [...names];
  }, [detail]);
  const inputFields = detail?.input_fields ?? [];

  function commit(c: NonNullable<typeof detail>["cases"][number], cell: CellKey, text: string) {
    const result = buildCellEditOp(c, cell, text, cell.kind === "input" && requiredNames.has(cell.name));
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    if (result.op) void patch([result.op]).catch(() => {});
  }

  async function convert() {
    if (!detail) return;
    try {
      const res = await convertEvalDataset(datasetId, { ...(root ? { project_root: root } : {}), base_hash: detail.hash });
      onChanged();
      navigate(datasetPath(res.id, evalId ? { eval: evalId } : undefined));
    } catch (err) {
      showToast(messageOf(err));
    }
  }

  async function confirmUpload(req: UploadConfirm) {
    if (!detail) return;
    await createEvalDataset(
      toCreateDatasetInput(req, { datasetId, baseHash: hashRef.current, ...(root ? { projectRoot: root } : {}) }),
    );
    setDialog(null);
    setPage(0);
    await load(true);
    onChanged();
  }

  async function confirmRuns(runIds: string[]) {
    if (!target) return;
    // The server only accepts `source: "runs"` when creating a dataset; appending to an existing one is a pending server change.
    const body = {
      ...(root ? { project_root: root } : {}),
      dataset_id: datasetId,
      mode: "append",
      source: "runs",
      target,
      run_ids: runIds,
      base_hash: hashRef.current,
    };
    await createEvalDataset(body as unknown as EvalCreateDatasetInput);
    setDialog(null);
    await load(true);
    onChanged();
  }

  async function confirmSessions(sessionIds: string[]) {
    if (!evalItem || evalItem.target.kind !== "agent") return;
    const body = {
      ...(root ? { project_root: root } : {}),
      dataset_id: datasetId,
      mode: "append",
      source: "sessions",
      target: { agent_id: evalItem.target.agent_id },
      session_ids: sessionIds,
      base_hash: hashRef.current,
    };
    await createEvalDataset(body as unknown as EvalCreateDatasetInput);
    setDialog(null);
    await load(true);
    onChanged();
  }

  const subtitle = detail
    ? datasetSubtitle({ cases: detail.cases_total, stage: stageLabel, usedBy: detail.used_by, path: detail.path, agent: agentEval })
    : undefined;
  const noEval = !target;

  return (
    <>
      <PageHeader
        title={datasetId}
        {...(subtitle ? { subtitle } : {})}
        titleAddon={
          detail?.format ? (
            <span className={`${MONO} rounded-sm border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]`}>
              {detail.format}
            </span>
          ) : null
        }
        actions={
          <>
            <button type="button" className={BTN} disabled={!editable} onClick={() => setDialog("upload")}>
              <LuUpload className="size-3.5" aria-hidden />
              Upload cases
            </button>
            {agentEval ? (
              <button type="button" className={BTN} disabled={!editable} onClick={() => setDialog("sessions")}>
                <LuHistory className="size-3.5" aria-hidden />
                Add from sessions
              </button>
            ) : (
              <button
                type="button"
                className={BTN}
                disabled={!editable || noEval}
                title={noEval ? "No eval uses this dataset, so there is no stage to read runs from" : undefined}
                onClick={() => setDialog("runs")}
              >
                <LuHistory className="size-3.5" aria-hidden />
                Add from runs
              </button>
            )}
            <button type="button" className={BTN_PRIMARY} disabled={!editable} onClick={() => setDialog("add")}>
              <LuPlus className="size-3.5" aria-hidden />
              {agentEval ? "Add scenario" : "Add case"}
            </button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {error ? (
          <div role="alert" className="flex items-center gap-3 text-xs text-[var(--sf-fail)]">
            <span>{error}</span>
            <button type="button" className={`${BTN} !h-7`} onClick={() => void load()}>Retry</button>
          </div>
        ) : null}
        {!detail && !error ? (
          <p className="text-xs text-[var(--sf-text-3)]">{listLoaded ? "Loading dataset…" : "Loading datasets…"}</p>
        ) : null}

        {readOnlyFormat ? (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-4 py-3">
            <span className="text-[13px] text-[var(--sf-text-1)]">
              This {readOnlyFormat.toUpperCase()} dataset is read-only here.
            </span>
            <span className="min-w-0 flex-1 text-[13px] text-[var(--sf-text-2)]">
              Convert it to a JSONL file next to it to edit cases. The original stays.
            </span>
            <button type="button" className={BTN} onClick={() => void convert()}>Convert to JSONL</button>
          </div>
        ) : null}

        {mixedUse ? (
          <div role="status" className="flex items-center gap-3 rounded-lg border border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)] px-4 py-3">
            <LuCircleAlert className="size-4 shrink-0 text-[var(--sf-needs)]" aria-hidden />
            <span className="text-[13px] text-[var(--sf-text-1)]">{MIXED_USE_BANNER}</span>
          </div>
        ) : null}

        {banner ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)] px-4 py-3"
          >
            <LuCircleAlert className="size-4 shrink-0 text-[var(--sf-needs)]" aria-hidden />
            <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{banner.title}</span>
            <span className="min-w-0 flex-1 text-[13px] text-[var(--sf-text-2)]">
              {banner.reason ? `${banner.reason}. ` : ""}
              {banner.tail}
            </span>
            <button
              type="button"
              className="shrink-0 text-[13px] font-medium text-[var(--sf-text-1)] hover:underline"
              onClick={() => {
                setTab("invalid");
                setPage(0);
                setView("table");
              }}
            >
              Show invalid
            </button>
          </div>
        ) : null}

        {detail ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1" role="tablist" aria-label="Case filters">
                {datasetTabs(detail).map((t) => {
                  const active = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setTab(t.id);
                        setPage(0);
                      }}
                      className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] ${
                        active
                          ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
                          : "border-transparent text-[var(--sf-text-2)]"
                      }`}
                      style={t.id === "invalid" && t.count > 0 && !active ? { color: "var(--sf-needs)" } : undefined}
                    >
                      {t.label}
                      <span className={`${MONO} text-xs`}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-[var(--sf-hairline-strong)] p-0.5" role="group" aria-label="View">
                  {(["table", "jsonl"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={`h-7 rounded-md px-3 text-[13px] ${view === v ? "bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]" : "text-[var(--sf-text-2)]"}`}
                    >
                      {v === "table" ? "Table" : "JSONL"}
                    </button>
                  ))}
                </div>
                <label className="flex h-8 w-[240px] items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2.5">
                  <LuSearch className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search cases"
                    className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                  />
                </label>
              </div>
            </div>

            {view === "jsonl" ? (
              <pre
                aria-label="JSONL file"
                className={`${MONO} max-h-full overflow-auto whitespace-pre rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4 text-xs leading-[1.6] text-[var(--sf-text-1)]`}
              >
                {jsonl ?? "Loading…"}
              </pre>
            ) : columnInfo && detail.cases.length > 0 ? (
              <div className="shrink-0 overflow-hidden rounded-lg border border-[var(--sf-hairline)]">
                {agentEval ? (
                  <ScenarioTable cases={detail.cases} offset={page * 25} defaultMode={defaultMode} editable={editable} onEdit={setEditing} onDelete={(c) => setDeleting(c.id)} />
                ) : (
                  <DatasetTable
                    columns={columnInfo.columns}
                    moreExpected={columnInfo.moreExpected}
                    cases={detail.cases}
                    offset={page * 25}
                    editable={editable}
                    requiredNames={requiredNames}
                    onCommit={commit}
                    onDelete={(c) => setDeleting(c.id)}
                  />
                )}
                <div className="flex items-center justify-between border-t border-t-[var(--sf-hairline)] px-4 py-2.5 text-xs text-[var(--sf-text-3)]">
                  <span>{paging.label}</span>
                  <span className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label="Previous page"
                      disabled={!paging.hasPrev}
                      onClick={() => setPage(paging.page - 1)}
                      className="flex size-7 items-center justify-center rounded-md border border-[var(--sf-hairline-strong)] disabled:opacity-40"
                    >
                      <LuChevronLeft className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label="Next page"
                      disabled={!paging.hasNext}
                      onClick={() => setPage(paging.page + 1)}
                      className="flex size-7 items-center justify-center rounded-md border border-[var(--sf-hairline-strong)] disabled:opacity-40"
                    >
                      <LuChevronRight className="size-3.5" aria-hidden />
                    </button>
                  </span>
                </div>
              </div>
            ) : (
              <p className="py-8 text-center text-[13px] text-[var(--sf-text-2)]">
                {detail.cases_total === 0
                  ? agentEval
                    ? "No scenarios yet. Upload a file or add one."
                    : "No cases yet. Upload a file or add one."
                  : agentEval
                    ? "No scenarios match this filter."
                    : "No cases match this filter."}
              </p>
            )}
          </>
        ) : null}
      </div>

      <footer className="flex h-8 w-full shrink-0 items-center justify-between gap-4 border-t border-t-[var(--sf-hairline)] bg-[var(--sf-rail)] px-5 text-xs text-[var(--sf-text-3)]">
        <span className="truncate">{detail ? footerNote(detail.path, editable) : ""}</span>
        <span
          className="flex shrink-0 items-center gap-2"
          style={save.status === "conflict" || save.status === "error" ? { color: "var(--sf-fail)" } : undefined}
          role="status"
        >
          {saveLabel(save)}
          {save.status === "conflict" ? (
            <button type="button" className="rounded-md border border-[var(--sf-hairline-strong)] px-2 py-0.5 text-[var(--sf-text-1)]" onClick={reload}>
              Reload
            </button>
          ) : null}
        </span>
      </footer>

      {dialog === "upload" && detail && allIds ? (
        <UploadDialog
          open
          subtitle={`Adding to ${datasetId}${stageLabel ? ` · for the ${stageLabel} stage` : ""}`}
          {...(target ? { target } : {})}
          inputFields={inputFields}
          expectedFields={expectedFields}
          existingCases={allIds.map((id) => ({ id }))}
          {...(root ? { projectRoot: root } : {})}
          {...(agentEval ? { conversationMode: defaultMode, ...(effectiveEvalId ? { evalId: effectiveEvalId } : {}) } : {})}
          onClose={() => setDialog(null)}
          onConfirm={confirmUpload}
        />
      ) : null}
      {dialog === "runs" && target ? (
        <CandidatesDialog
          open
          subtitle={`Completed runs of the ${stageLabel ?? "stage"} stage`}
          target={target}
          {...(root ? { projectRoot: root } : {})}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => confirmRuns(ids)}
        />
      ) : null}
      {dialog === "sessions" && evalItem?.target.kind === "agent" ? (
        <SessionCandidatesDialog
          agentId={evalItem.target.agent_id}
          {...(root ? { projectRoot: root } : {})}
          onClose={() => setDialog(null)}
          onConfirm={(ids) => confirmSessions(ids)}
        />
      ) : null}
      {dialog === "add" && detail && allIds && agentEval ? (
        <ScenarioEditor
          defaultMode={defaultMode}
          existingIds={allIds}
          toolIds={toolIds}
          onClose={() => setDialog(null)}
          onSave={async (c) => {
            await patch([{ op: "add", case: c }]);
            setDialog(null);
          }}
        />
      ) : null}
      {editing ? (
        <ScenarioEditor
          initial={editing}
          defaultMode={defaultMode}
          existingIds={[]}
          toolIds={toolIds}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            await patch([{ op: "update", id: editing.id, case: c }]);
            setEditing(null);
          }}
        />
      ) : null}
      {dialog === "add" && detail && allIds && !agentEval ? (
        <AddCaseDialog
          inputFields={inputFields}
          jsonFields={jsonFields}
          existingIds={allIds}
          onClose={() => setDialog(null)}
          onConfirm={async (c) => {
            await patch([{ op: "add", case: c }]);
            setDialog(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={`Delete case ${deleting}?`}
          body="The case is removed from the dataset file. Past runs keep their results."
          confirmText="Delete case"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const id = deleting;
            try {
              await patch([buildDeleteOp(id)]);
            } catch {
              /* shown in the footer */
            }
            setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}
