import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchPipelines } from "../../api";
import { displayCatalogPath } from "../../catalog/displayCatalogPath";
import { workshopPath } from "../../routes";
import {
  stagesFromPipelines,
  stageRootLabel,
  type StageRowFromPipelines,
} from "./stagesFromPipelines";

function GateChips({ kinds }: { kinds?: string[] }) {
  if (!kinds || kinds.length === 0) {
    return (
      <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
        —
      </span>
    );
  }
  const [first, ...rest] = kinds;
  return (
    <div className="flex w-[120px] shrink-0 items-center gap-1">
      <span className="h-5 content-center rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
        {first}
      </span>
      {rest.length > 0 ? (
        <span className="h-5 content-center rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
          +{rest.length}
        </span>
      ) : null}
    </div>
  );
}

export function CatalogStagesTab() {
  const [rows, setRows] = useState<StageRowFromPipelines[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { pipelines } = await fetchPipelines();
      setRows(stagesFromPipelines(pipelines));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => rows.find((r) => r.rowKey === selectedKey) ?? null,
    [rows, selectedKey],
  );

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !rows.some((r) => r.rowKey === selectedKey)) {
      setSelectedKey(rows[0]!.rowKey);
    }
  }, [rows, selectedKey]);

  const showRootLabels = useMemo(() => {
    const roots = new Set(rows.map((r) => r.project_root ?? ""));
    return roots.size > 1;
  }, [rows]);

  const stagePath = selected?.uses_path;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <p className="shrink-0 border-b border-b-[#ffffff12] px-4 py-2.5 text-xs text-[var(--sf-text-2)]">
          Stages are YAML on disk. Pipelines reference them by id. Validate in
          Workshop or with{" "}
          <span className="font-['Geist_Mono',monospace]">sf validate</span>.
        </p>
        {error ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-fail)]">{error}</p>
        ) : null}
        {loading ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
            Loading stages…
          </p>
        ) : null}
        {!loading && rows.length === 0 ? (
          <p className="px-4 py-3 text-xs text-[var(--sf-text-3)]">
            No stages referenced by pipelines yet.
          </p>
        ) : null}
        <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 py-0">
          <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Stage id
          </div>
          <div className="w-[120px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Gates
          </div>
          <div className="w-[100px] shrink-0 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Used by
          </div>
        </div>
        {rows.map((row) => {
          const selectedRow = selectedKey === row.rowKey;
          const firstPipeline = row.used_by_pipeline_ids[0];
          return (
            <button
              key={row.rowKey}
              type="button"
              onClick={() => setSelectedKey(row.rowKey)}
              className={`flex h-10 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] py-0 pl-3.5 pr-4 text-left${
                selectedRow
                  ? " border-l-2 border-l-[var(--sf-text-1)] bg-[var(--sf-panel)]"
                  : " border-l-2 border-l-transparent bg-transparent hover:bg-[var(--sf-raised)]"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <span
                  className="truncate font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]"
                  title={row.id}
                >
                  {row.id}
                </span>
                {showRootLabels && row.project_root ? (
                  <span
                    className="shrink-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]"
                    title={row.project_root}
                  >
                    {stageRootLabel(row)}
                  </span>
                ) : null}
              </div>
              <GateChips kinds={row.gate_kinds} />
              <div className="flex w-[100px] min-w-0 shrink-0 items-baseline gap-1.5">
                <span className="shrink-0 font-['Geist_Mono',monospace] text-xs font-medium text-[var(--sf-text-1)]">
                  {row.used_by_pipeline_ids.length}
                </span>
                {firstPipeline ? (
                  <span
                    className="min-w-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]"
                    title={firstPipeline}
                  >
                    {firstPipeline}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      {selected ? (
        <aside className="flex w-96 shrink-0 flex-col border-l border-l-[#ffffff12] bg-[var(--sf-panel)]">
          <div className="shrink-0 border-b border-b-[#ffffff12] px-4 py-3 text-sm font-semibold text-[var(--sf-text-1)]">
            {selected.id}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
            <dl className="grid gap-2">
              <dt className="text-[var(--sf-text-3)]">Stage id</dt>
              <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
                {selected.id}
              </dd>
              {selected.project_root ? (
                <>
                  <dt className="text-[var(--sf-text-3)]">Project</dt>
                  <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                    {selected.project_root}
                  </dd>
                </>
              ) : null}
              {stagePath ? (
                <>
                  <dt className="text-[var(--sf-text-3)]">Path</dt>
                  <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                    {displayCatalogPath(stagePath)}
                  </dd>
                </>
              ) : null}
              {selected.gate_kinds && selected.gate_kinds.length > 0 ? (
                <>
                  <dt className="text-[var(--sf-text-3)]">Gates</dt>
                  <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                    {selected.gate_kinds.join(", ")}
                  </dd>
                </>
              ) : null}
              <dt className="text-[var(--sf-text-3)]">Used by</dt>
              <dd>
                <ul className="list-inside list-disc font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                  {selected.used_by_pipeline_ids.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                </ul>
              </dd>
            </dl>
            {stagePath ? (
              <a
                className="mt-4 inline-flex rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-1.5 text-xs font-medium text-[var(--sf-text-2)]"
                href={`#${workshopPath({ pipeline: stagePath })}`}
              >
                Open in Workshop
              </a>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
