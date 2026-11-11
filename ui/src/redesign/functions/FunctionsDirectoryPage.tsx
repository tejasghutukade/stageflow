import { useEffect, useMemo, useState } from "react";
import { LuChevronRight, LuPlus, LuSearch } from "react-icons/lu";
import { functionsApi, type FunctionKind, type FunctionSummary } from "../../api/functions";
import { functionNewPath, functionPath, navigate } from "../../routes";
import { Dialog } from "../agents/editor/Dialogs";
import { MONO, NOWRAP, PAGE_BG } from "../agents/agentsTokens";
import { Button, PageFooter } from "../agents/ui";
import { PageHeader } from "../shell/PageHeader";
import { filterFunctions, kindCounts, searchFunctions, type FunctionDirectoryKind } from "./functionsDirectoryModel";
import { deleteUnreferenced } from "./functionsPageModel";

const GRID = "grid grid-cols-[minmax(0,1.4fr)_140px_90px_160px_72px_14px] items-center gap-4 px-4";

const FILTERS: { id: FunctionDirectoryKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "verification", label: "Verification" },
  { id: "routing", label: "Routing" },
  { id: "tool", label: "Tool" },
];

const KIND_LABEL: Record<FunctionKind, string> = {
  verification: "Verification",
  routing: "Routing",
  tool: "Tool",
};

function displayName(row: FunctionSummary): string {
  return row.name?.trim() || row.id;
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

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    setDeleting(true);
    try {
      const result = await deleteUnreferenced(pendingDeleteId, true);
      if ("functions" in result) setRows(result.functions);
      setPendingDeleteId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={PAGE_BG}>
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
          JavaScript functions in this project. Attach a verification or a tool on a stage body, and a routing function on the pipeline stage that owns the route.
        </p>
        {error ? (
          <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
            {error}
          </p>
        ) : null}
        {loading ? <p className="text-[13px] text-[var(--sf-text-3)]">Loading functions…</p> : null}
        {!loading && rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-[var(--sf-hairline)] px-6 py-10 text-center" data-testid="functions-empty">
            <h3 className="text-[15px] font-semibold text-[var(--sf-text-1)]">No functions yet</h3>
            <p className="max-w-[520px] text-[13px] leading-[1.5] text-[var(--sf-text-2)]">
              Create one to keep a revisioned JavaScript function in the project.
            </p>
          </div>
        ) : null}
        {!loading && rows.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                {FILTERS.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    aria-pressed={kind === chip.id}
                    onClick={() => setKind(chip.id)}
                    className={`rounded-md border px-2 py-0.5 text-xs leading-[1.33333] ${NOWRAP} ${
                      kind === chip.id
                        ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
                        : "border-transparent text-[var(--sf-text-2)]"
                    }`}
                  >
                    {chip.label} {counts[chip.id]}
                  </button>
                ))}
              </div>
              <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3">
                <LuSearch aria-hidden className="size-3.5 shrink-0 text-[var(--sf-text-3)]" />
                <input
                  type="search"
                  value={query}
                  aria-label="Search functions"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name"
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
                {visible.map((row) => (
                  <div key={row.id} className={`${GRID} relative py-3 hover:bg-[var(--sf-panel)]`}>
                    <a href={`#${functionPath(row.id)}`} aria-label={`Open ${displayName(row)}`} className="absolute inset-0" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">{displayName(row)}</span>
                      {row.description ? <span className="text-xs text-[var(--sf-text-3)]">{row.description}</span> : null}
                    </div>
                    <span className="text-xs text-[var(--sf-text-2)]">{row.kind ? KIND_LABEL[row.kind] : "Unknown"}</span>
                    <span className={`${MONO} text-xs text-[var(--sf-text-2)]`}>{row.revision}</span>
                    <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>{row.updatedAt.slice(0, 10)}</span>
                    <button
                      type="button"
                      className="relative z-10 text-xs text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
                      onClick={() => setPendingDeleteId(row.id)}
                    >
                      Delete
                    </button>
                    <LuChevronRight aria-hidden className="size-3.5 text-[var(--sf-text-3)]" />
                  </div>
                ))}
              </div>
              {visible.length === 0 ? <p className="px-4 py-6 text-center text-xs text-[var(--sf-text-3)]">No functions match this filter.</p> : null}
            </div>
          </>
        ) : null}
      </div>
      <PageFooter left={!loading ? `${rows.length} function${rows.length === 1 ? "" : "s"}` : ""} />
      {pending ? (
        <Dialog
          title={`Delete ${displayName(pending)}?`}
          onClose={() => setPendingDeleteId(null)}
          narrow
          footer={
            <Button variant="primary" disabled={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          }
        >
          <p className="px-4 py-4 text-[13px] leading-normal text-[var(--sf-text-2)]">
            This removes the function when nothing in the project references it. A referenced function stays, and the list refreshes after a delete.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
