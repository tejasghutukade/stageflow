import { useEffect, useState } from "react";
import { LuCode, LuFile, LuFileText, LuImage, LuTable } from "react-icons/lu";
import type { IconType } from "react-icons";
import { fetchCatalogRoots, fetchRuns } from "../../api/client";
import { fetchArtifacts } from "../../api/artifacts";
import { navigate } from "../../routes";
import { DataTable, DataTableRow } from "../shell/DataTable";
import { PageHeader } from "../shell/PageHeader";
import {
  ALL_PROJECTS_SCOPE,
  ARTIFACTS_EMPTY_BODY,
  ARTIFACTS_EMPTY_TITLE,
  activeArtifactProjectWireId,
  applyArtifactPage,
  artifactListRows,
  artifactProjectScopeOptions,
  artifactScopeQuery,
  initialArtifactCursorState,
  unregisteredProjectLabel,
  type ArtifactCursorState,
  type ArtifactListRow,
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
};

function KindIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICONS[kind] ?? LuFile;
  return <Icon aria-hidden className="size-4 shrink-0 text-[var(--sf-text-2)]" />;
}

function EmptyState() {
  return (
    <div className="mx-5 mt-6 flex max-w-[640px] flex-col gap-1.5 rounded-lg border border-[var(--sf-hairline)] px-6 py-8" data-testid="artifacts-empty">
      <h2 className="text-[15px] font-semibold text-[var(--sf-text-1)]">{ARTIFACTS_EMPTY_TITLE}</h2>
      <p className="text-[13px] leading-[1.5] text-[var(--sf-text-2)]">{ARTIFACTS_EMPTY_BODY}</p>
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
        {row.expired ? (
          <span className="sf-pill sf-pill--fail shrink-0" title={row.expiredReason ?? "Expired"}>
            <span className="sf-pill__label">Expired</span>
          </span>
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
  showLoadMore,
  onLoadMore,
}: {
  rows: ArtifactListRow[] | null;
  error: string | null;
  loading: boolean;
  scopeOptions: ArtifactScopeOption[];
  scopeId: string;
  onScope?: (id: string) => void;
  showLoadMore: boolean;
  onLoadMore?: () => void;
}) {
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
      {error ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{error}</p>
      ) : loading || rows === null ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">Loading artifacts…</p>
      ) : rows.length === 0 ? (
        <EmptyState />
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
  const [cursor, setCursor] = useState<ArtifactCursorState>(initialArtifactCursorState());
  const [runsById, setRunsById] = useState<ReadonlyMap<string, ArtifactRunRef>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const catalog = await fetchCatalogRoots().catch(() => ({ roots: [] as ArtifactProjectRoot[] }));
      const listed = await fetchRuns().catch(() => ({ runs: [] as ArtifactRunRef[] }));
      if (cancelled) return;
      const nextRoots = catalog.roots;
      setRoots(nextRoots);
      setRunsById(new Map(listed.runs.map((run) => [run.run_id, run])));
      setScope(activeArtifactProjectWireId(nextRoots));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (scope === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchArtifacts(artifactScopeQuery(scope))
      .then((page) => {
        if (cancelled) return;
        setCursor(applyArtifactPage(initialArtifactCursorState(), page, "replace"));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setCursor(initialArtifactCursorState());
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const scopeId = scope ?? activeArtifactProjectWireId(roots);
  const options = artifactProjectScopeOptions(roots, scopeId);
  const rows = loading
    ? null
    : artifactListRows(cursor.records, Date.now(), {
        runs: runsById,
        showProject: scopeId === ALL_PROJECTS_SCOPE,
      });

  return (
    <ArtifactsPageView
      rows={rows}
      error={error}
      loading={scope === null || loading}
      scopeOptions={options}
      scopeId={scopeId}
      onScope={setScope}
      showLoadMore={!loading && cursor.nextCursor !== null}
      onLoadMore={() => {
        const next = cursor.nextCursor;
        const current = scope;
        if (!next || current === null) return;
        void fetchArtifacts(artifactScopeQuery(current), { cursor: next })
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
