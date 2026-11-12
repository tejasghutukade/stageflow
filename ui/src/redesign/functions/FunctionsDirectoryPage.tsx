import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LuChevronRight, LuPlus, LuSearch, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import { FunctionApiError, functionsApi, type FunctionSummary, type FunctionUsage } from "../../api/functions";
import { functionNewPath, functionPath, navigate } from "../../routes";
import { showToast } from "../../toast";
import { Dialog } from "../agents/editor/Dialogs";
import { clampCursor, isCursorKey, moveCursor, shouldHandleCursorKey } from "../agents/listCursor";
import { MONO, NOWRAP, PAGE_BG } from "../agents/agentsTokens";
import { Button, ListGroup, PageFooter } from "../agents/ui";
import { PageHeader } from "../shell/PageHeader";
import { Callout, IconButton } from "./FunctionFields";
import { filterFunctions, kindCounts, searchFunctions, type FunctionDirectoryKind } from "./functionsDirectoryModel";
import { FUNCTION_KINDS, KIND_META, KindPill, relativeTime } from "./functionKinds";
import { deleteUnreferenced } from "./functionsPageModel";

const GRID = "grid grid-cols-[minmax(0,1fr)_150px_90px_110px_28px_14px] items-center gap-4 px-4 min-w-[720px]";

const FILTERS: { id: FunctionDirectoryKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "verification", label: "Verification" },
  { id: "routing", label: "Routing" },
  { id: "tool", label: "Tool" },
];

function displayName(row: FunctionSummary): string {
  return row.name?.trim() || row.id;
}

function FilterChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-2 py-0.5 text-xs leading-[1.33333] ${NOWRAP} ${
        active
          ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
          : "border-transparent text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
      }`}
    >
      {label} {count}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col gap-5 rounded-lg border border-[var(--sf-hairline)] px-6 py-8" data-testid="functions-empty">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-[15px] font-semibold leading-normal text-[var(--sf-text-1)]">No functions yet</h3>
        <p className="max-w-[560px] text-[13px] leading-[1.5] text-[var(--sf-text-2)]">
          A function is a small, revisioned JavaScript module that runs sealed, with only the files, environment values and APIs you grant it. Pick what it
          should do:
        </p>
      </div>
      <ListGroup>
        {FUNCTION_KINDS.map((kind) => {
          const meta = KIND_META[kind];
          return (
            <a
              key={kind}
              href={`#${functionNewPath(kind)}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--sf-panel)]"
            >
              <span className={`flex shrink-0 [&>svg]:size-4 ${meta.accent}`}>{meta.icon}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{meta.label}</span>
                <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                  {meta.summary} {meta.where}
                </span>
              </span>
              <LuChevronRight aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
            </a>
          );
        })}
      </ListGroup>
    </div>
  );
}

function DirectoryRow({
  row,
  highlighted,
  rowRef,
  onFocusRow,
  onDelete,
}: {
  row: FunctionSummary;
  highlighted: boolean;
  rowRef: (node: HTMLAnchorElement | null) => void;
  onFocusRow: () => void;
  onDelete: () => void;
}) {
  const name = displayName(row);
  const problem = row.issues[0];
  return (
    <div
      className={`${GRID} group relative py-3 hover:bg-[var(--sf-panel)] focus-within:bg-[var(--sf-panel)] ${highlighted ? "bg-[var(--sf-panel)]" : ""}`}
    >
      <a
        ref={rowRef}
        href={`#${functionPath(row.id)}`}
        data-list-row=""
        aria-label={`Open ${name}`}
        className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--sf-hairline-strong)]"
        onFocus={onFocusRow}
        onKeyDown={(event) => {
          if (event.key === " ") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">{name}</span>
          {row.name?.trim() && row.name.trim() !== row.id ? (
            <span className={`${MONO} truncate text-[11px] leading-normal text-[var(--sf-text-3)]`}>{row.id}</span>
          ) : null}
        </span>
        {row.description ? <span className="truncate text-xs leading-[1.33333] text-[var(--sf-text-3)]">{row.description}</span> : null}
        {problem ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-[1.33333] text-[var(--sf-needs)]" title={problem.message}>
            <LuTriangleAlert aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {row.issues.length > 1 ? `${row.issues.length} problems: ` : ""}
              {problem.message}
            </span>
          </span>
        ) : null}
      </div>
      <div>
        <KindPill kind={row.kind} />
      </div>
      <span className={`${MONO} text-xs leading-[1.33333] text-[var(--sf-text-2)]`}>{row.revision}</span>
      <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]" title={row.updatedAt}>
        {relativeTime(row.updatedAt)}
      </span>
      <IconButton
        label={`Delete ${name}`}
        onClick={onDelete}
        className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <LuTrash2 aria-hidden />
      </IconButton>
      <LuChevronRight aria-hidden className="size-3.5 text-[var(--sf-text-3)]" />
    </div>
  );
}

function DeleteDialog({
  row,
  deleting,
  error,
  usages,
  onConfirm,
  onClose,
}: {
  row: FunctionSummary;
  deleting: boolean;
  error: string | null;
  usages: FunctionUsage[] | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const blocked = usages !== null && usages.length > 0;
  return (
    <Dialog
      title={`Delete ${displayName(row)}?`}
      onClose={onClose}
      narrow
      footer={
        <>
          <Button onClick={onClose}>{blocked ? "Close" : "Cancel"}</Button>
          {blocked ? null : (
            <Button variant="danger" disabled={deleting} onClick={onConfirm}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-4">
        {blocked ? (
          <>
            <Callout tone="needs" role="alert">
              <span className="font-medium">Still in use</span>
              <span className="text-[var(--sf-text-2)]">Detach it from these first, then delete it.</span>
            </Callout>
            <ListGroup>
              {usages.map((usage) => (
                <div key={`${usage.kind}:${usage.path}`} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className={`${MONO} min-w-0 truncate text-xs text-[var(--sf-text-1)]`}>{usage.path}</span>
                  <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">{usage.kind}</span>
                </div>
              ))}
            </ListGroup>
          </>
        ) : (
          <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">
            This removes the function and its definition file. It can only be deleted when no stage, pipeline or agent references it.
          </p>
        )}
        {error && !blocked ? (
          <p role="alert" className="text-xs leading-[1.33333] text-[var(--sf-fail)]">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function FunctionsDirectoryPage({
  loaded,
  query: queryProp = "",
  kind: kindProp = "all",
  pendingDeleteId: pendingProp = null,
}: {
  loaded?: FunctionSummary[];
  query?: string;
  kind?: FunctionDirectoryKind;
  pendingDeleteId?: string | null;
}) {
  const seeded = loaded !== undefined;
  const [rows, setRows] = useState<FunctionSummary[]>(loaded ?? []);
  const [loading, setLoading] = useState(!seeded);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(queryProp);
  const [kind, setKind] = useState<FunctionDirectoryKind>(kindProp);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(pendingProp);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [usages, setUsages] = useState<FunctionUsage[] | null>(null);
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => {
    if (seeded) return;
    let live = true;
    void functionsApi.list().then(
      (list) => {
        if (!live) return;
        setRows(list);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [seeded]);

  const counts = useMemo(() => kindCounts(rows), [rows]);
  const visible = useMemo(() => searchFunctions(filterFunctions(rows, kind), query), [rows, kind, query]);
  const pending = rows.find((row) => row.id === pendingDeleteId) ?? null;
  const filtering = kind !== "all" || query.trim() !== "";

  useEffect(() => {
    setCursor(-1);
  }, [kind, query]);
  useEffect(() => {
    setCursor((current) => clampCursor(current, visible.length));
  }, [visible.length]);

  function closeDelete() {
    setPendingDeleteId(null);
    setDeleteError(null);
    setUsages(null);
  }

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteUnreferenced(pending.id, true);
      if ("functions" in result) setRows(result.functions);
      showToast(`Deleted ${displayName(pending)}`);
      closeDelete();
    } catch (err) {
      if (err instanceof FunctionApiError && err.code === "function.in_use") setUsages(err.usages ?? []);
      else setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isCursorKey(event.key) || !shouldHandleCursorKey(event.target as HTMLElement)) return;
    if (visible.length === 0) return;
    event.preventDefault();
    const next = moveCursor(cursor, event.key, visible.length);
    setCursor(next);
    rowRefs.current[next]?.focus();
  }

  return (
    <div className={PAGE_BG} onKeyDown={onKeyDown}>
      <PageHeader
        title="Functions"
        titleAddon={<span className={`${MONO} text-[13px] text-[var(--sf-text-2)]`}>{rows.length}</span>}
        actions={
          <Button variant="primary" icon={<LuPlus aria-hidden />} onClick={() => navigate(functionNewPath())}>
            New function
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        <p className="text-[13px] leading-normal text-[var(--sf-text-2)]">
          JavaScript functions in this project. Each one runs sealed, with only the files, environment values and APIs you grant it. Attach a verification
          or a tool on a stage, and a routing function on the pipeline stage that owns the route.
        </p>
        {error ? (
          <Callout tone="needs" role="alert">
            <span className="font-medium">Could not load functions</span>
            <span className="text-[var(--sf-text-2)]">{error}</span>
          </Callout>
        ) : null}
        {loading ? <p className="text-[13px] text-[var(--sf-text-3)]">Loading functions…</p> : null}
        {!loading && !error && rows.length === 0 ? <EmptyState /> : null}
        {!loading && rows.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                {FILTERS.map((chip) => (
                  <FilterChip key={chip.id} active={kind === chip.id} label={chip.label} count={counts[chip.id]} onClick={() => setKind(chip.id)} />
                ))}
              </div>
              <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3">
                <LuSearch aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
                <input
                  type="search"
                  value={query}
                  aria-label="Search functions"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name, id or description"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
                />
              </label>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--sf-hairline)]" data-testid="functions-directory-table">
              <div className={`${GRID} h-9 border-b border-b-[var(--sf-hairline)]`}>
                {["Function", "Kind", "Revision", "Updated"].map((label) => (
                  <span key={label} className="text-[11px] leading-normal text-[var(--sf-text-3)]">
                    {label}
                  </span>
                ))}
                <span aria-hidden />
                <span aria-hidden />
              </div>
              <div className="[&>*+*]:border-t [&>*+*]:border-t-[var(--sf-hairline)]">
                {visible.map((row, index) => (
                  <DirectoryRow
                    key={row.id}
                    row={row}
                    highlighted={index === cursor}
                    onFocusRow={() => setCursor(index)}
                    onDelete={() => setPendingDeleteId(row.id)}
                    rowRef={(node) => {
                      rowRefs.current[index] = node;
                    }}
                  />
                ))}
              </div>
              {visible.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <p className="text-xs text-[var(--sf-text-3)]">No functions match{filtering ? " these filters" : ""}.</p>
                  {filtering ? (
                    <Button
                      size="sm"
                      onClick={() => {
                        setKind("all");
                        setQuery("");
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <PageFooter
        left={!loading ? `${rows.length} function${rows.length === 1 ? "" : "s"}` : ""}
        right={rows.length > 0 ? "↑ ↓ to move · ↵ to open" : undefined}
      />
      {pending ? (
        <DeleteDialog row={pending} deleting={deleting} error={deleteError} usages={usages} onConfirm={() => void confirmDelete()} onClose={closeDelete} />
      ) : null}
    </div>
  );
}
