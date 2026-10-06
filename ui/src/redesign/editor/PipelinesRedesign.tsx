import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPipelines,
  type PipelineListing,
  type PipelineStageListing,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import {
  displayCatalogPath,
  matchPipelineRun,
} from "../../catalog/displayCatalogPath";
import { stageMayAsk } from "../../catalogJoin";
import { navigate, pipelinePath } from "../../routes";
import { runDisplayStatus } from "../../status/runStatus";
import { NewPipelinePanel } from "../../components/NewPipelinePanel";
import { MiniTrack } from "../../components/MiniTrack";
import type { MiniStage } from "../../components/MiniTrack";
import { PageHeader } from "../shell/PageHeader";
import { DataTable, DataTableRow } from "../shell/DataTable";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import { showToast } from "../../toast";

function catalogRootLabel(projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined;
  const parts = projectRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function definitionMiniStages(stages: PipelineStageListing[]): MiniStage[] {
  return stages.map((stage) => ({
    id: stage.id,
    status: stageMayAsk(stage.gate_kinds)
      ? "waiting_for_input"
      : "pending",
  }));
}

function pipelineRowKey(pipeline: PipelineListing): string {
  return `${pipeline.path}:${pipeline.project_root ?? ""}:${pipeline.id}`;
}

export function PipelinesRedesign({
  onNew,
}: {
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } =
    useRunCatalog();
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await fetchPipelines();
      setPipelines(p.pipelines);
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

  const displayError = error ?? catalogError;
  const busy = loading || catalogLoading;

  const showRoot = useMemo(
    () => pipelines.some((p) => Boolean(p.project_root)),
    [pipelines],
  );

  async function onPipelineCreated(pipeline: PipelineListing) {
    setPanelOpen(false);
    await load();
    showToast(`Pipeline created · ${pipeline.id}`);
    onNew(
      pipelinePath(pipeline.id, {
        ...(pipeline.project_root ? { project_root: pipeline.project_root } : {}),
      }),
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Pipelines"
        subtitle="Manifest-declared pipeline files and their embedded stages"
        actions={
          <button
            type="button"
            className="sf-btn sf-btn--primary"
            onClick={() => setPanelOpen(true)}
          >
            New pipeline
          </button>
        }
      />
      {displayError ? (
        <p className="px-5 pt-3 text-[13px] text-[var(--sf-fail)]">
          {displayError}
        </p>
      ) : null}
      {busy ? (
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">
          Loading pipelines…
        </p>
      ) : null}
      {!busy && pipelines.length === 0 ? (
        <div className="px-5 py-8">
          <p className="mb-3 text-[13px] text-[var(--sf-text-2)]">
            No pipelines in the manifest yet. Add a{" "}
            <span className="font-['Geist_Mono',monospace]">stageflow.yaml</span>{" "}
            catalog entry or run{" "}
            <span className="font-['Geist_Mono',monospace]">sf init</span>.
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
      {!busy && pipelines.length > 0 ? (
        <DataTable>
          {pipelines.map((pipeline) => {
            const runs = snapshot.runs
              .filter((run) => matchPipelineRun(run, pipeline))
              .sort(
                (a, b) =>
                  Date.parse(b.created_at) - Date.parse(a.created_at),
              );
            const last = runs[0];
            const root = catalogRootLabel(pipeline.project_root);
            const pathLabel = displayCatalogPath(
              pipeline.path,
              pipeline.project_root,
            );
            const trackLabel = pipeline.stages.map((s) => s.id).join(" · ");
            return (
              <DataTableRow
                key={pipelineRowKey(pipeline)}
                onClick={() =>
                  navigate(
                    pipelinePath(pipeline.id, {
                      ...(pipeline.project_root
                        ? { project_root: pipeline.project_root }
                        : {}),
                    }),
                  )
                }
              >
                <div className="grid min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto_auto] items-center gap-4">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">
                      {pipeline.id}
                    </div>
                    <div
                      className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]"
                      title={pathLabel}
                    >
                      {pathLabel}
                    </div>
                    {showRoot && root ? (
                      <div className="truncate text-[11px] text-[var(--sf-text-3)]">
                        root · {root}
                      </div>
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <MiniTrack
                      stages={definitionMiniStages(pipeline.stages)}
                      label={trackLabel}
                      variant="rings"
                    />
                  </div>
                  <div className="shrink-0 text-right font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
                    {pipeline.stages.length}{" "}
                    {pipeline.stages.length === 1 ? "stage" : "stages"}
                  </div>
                  <div className="flex shrink-0 justify-end">
                    {last ? (
                      <StatusPill
                        signal={statusSignalFromRun(last)}
                        label={runStatusPillLabel(runDisplayStatus(last))}
                      />
                    ) : (
                      <span className="text-xs text-[var(--sf-text-3)]">
                        no runs
                      </span>
                    )}
                  </div>
                </div>
              </DataTableRow>
            );
          })}
        </DataTable>
      ) : null}
      <NewPipelinePanel
        isOpen={panelOpen}
        onClose={() => setPanelOpen(false)}
        onCreated={(pipeline) => void onPipelineCreated(pipeline)}
        pipelines={pipelines}
      />
    </div>
  );
}
