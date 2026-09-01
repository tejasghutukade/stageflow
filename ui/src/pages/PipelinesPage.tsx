import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPipelines,
  fetchTasks,
  type PipelineListing,
  type PipelineStageListing,
  type RunSummary,
  type TaskListing,
  type CreatedStageListing,
} from "../api";
import { useRunCatalog } from "../catalog/useRunCatalog";
import { displayCatalogPath, runTaskLabel } from "../catalog/displayCatalogPath";
import { runsForPipelineView } from "../catalog/views";
import {
  gateCount,
  relativeTime,
} from "../catalogJoin";
import { NewPipelinePanel } from "../components/NewPipelinePanel";
import { NewStagePanel } from "../components/NewStagePanel";
import { PipelineTrack, type TrackStage } from "../components/PipelineTrack";
import { newRunPath, pipelinePath, runStreamPath } from "../routes";
import { StatusDot } from "../StatusLabel";
import { runDisplayStatus } from "../status/runStatus";
import { showToast } from "../toast";

function definitionTrack(stages: PipelineStageListing[]): TrackStage[] {
  return stages.map((stage) => {
    const kinds = stage.gate_kinds ?? [];
    return {
      id: stage.id,
      label: stage.id,
      status: kinds.length > 0 ? "waiting" : "pending",
      meta: kinds.length > 0 ? kinds.join(" · ") : "no gate",
    };
  });
}

function gateLabel(kinds: string[] | undefined): string {
  if (!kinds || kinds.length === 0) return "none";
  return kinds.join(" · ");
}

function stageSourceLabel(stage: PipelineStageListing): string {
  if (stage.inline) return "inline";
  if (stage.uses_path) return stage.uses_path;
  return "—";
}

function pipelineDirectory(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

function defaultTaskForPipeline(
  pipeline: PipelineListing,
  tasks: TaskListing[],
): string | undefined {
  const dir = pipelineDirectory(pipeline.path);
  const inDir = tasks.filter((task) =>
    dir === "."
      ? !task.path.includes("/")
      : task.path.startsWith(`${dir}/`),
  );
  return inDir[0]?.path ?? tasks[0]?.path;
}

function PipelineMiniTrack({ stages }: { stages: PipelineStageListing[] }) {
  return (
    <span>
      <span className="mini" aria-hidden="true">
        {stages.map((stage, i) => (
          <Fragment key={stage.id}>
            {i > 0 ? <i className="mini__w"></i> : null}
            <i
              className="mini__n"
              data-s={(stage.gate_kinds?.length ?? 0) > 0 ? "waiting" : undefined}
            >
              {(stage.gate_kinds?.length ?? 0) > 0 ? "?" : String(i + 1)}
            </i>
          </Fragment>
        ))}
      </span>
      <span className="mini__label" style={{ display: "block" }}>
        {stages.map((s) => s.id).join(" · ")}
      </span>
    </span>
  );
}

export function PipelinesPage({
  pipelineId,
  onNew,
}: {
  pipelineId?: string;
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } = useRunCatalog();
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pipelinesLoading, setPipelinesLoading] = useState(true);
  const [stagePanelOpen, setStagePanelOpen] = useState(false);
  const [pipelinePanelOpen, setPipelinePanelOpen] = useState(false);

  const loadPipelines = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([fetchPipelines(), fetchTasks()]);
      setPipelines(p.pipelines);
      setTasks(t.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPipelinesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPipelines();
  }, [loadPipelines]);

  const loading = pipelinesLoading || catalogLoading;
  const displayError = error ?? catalogError;
  const selected = pipelineId
    ? (pipelines.find((p) => p.id === pipelineId) ?? null)
    : null;
  const history = selected ? runsForPipelineView(snapshot, selected) : [];

  async function onPipelineCreated(pipeline: PipelineListing) {
    setPipelinePanelOpen(false);
    try {
      const p = await fetchPipelines();
      setPipelines(p.pipelines);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    showToast(`Pipeline created · ${pipeline.id}`);
    onNew(pipelinePath(pipeline.id));
  }

  if (pipelineId) {
    return (
      <PipelineDetail
        pipelineId={pipelineId}
        pipeline={selected}
        tasks={tasks}
        runs={history}
        loading={loading}
        error={displayError}
        onNew={onNew}
        onStageCreated={() => void loadPipelines()}
        stagePanelOpen={stagePanelOpen}
        onOpenStagePanel={() => setStagePanelOpen(true)}
        onCloseStagePanel={() => setStagePanelOpen(false)}
      />
    );
  }

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Pipelines</h1>
          <p>
            Manifest-declared pipeline files and their embedded stages. Each row
            shows its chain and which stages will stop for a human.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setPipelinePanelOpen(true)}
        >
          New pipeline
        </button>
      </div>

      {displayError ? (
        <p style={{ color: "var(--color-text-red)" }}>{displayError}</p>
      ) : null}
      {loading ? <p className="muted">Loading pipelines…</p> : null}
      {!loading && pipelines.length === 0 ? (
        <div className="empty-hint">
          <p style={{ margin: "0 0 var(--spacing-3)" }}>
            No pipelines in the manifest yet. Add a <span className="mono">stageflow.yaml</span> catalog entry or run{" "}
            <span className="mono">sf init</span>.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setPipelinePanelOpen(true)}
          >
            New pipeline
          </button>
        </div>
      ) : null}

      {!loading && pipelines.length > 0 ? (
        <>
          {pipelines.map((pipeline) => {
            const pipelineRuns = runsForPipelineView(snapshot, pipeline);
            const gates = gateCount(pipeline.stages);
            return (
              <a
                key={`${pipeline.path}:${pipeline.id}`}
                className="rrow"
                href={`#${pipelinePath(pipeline.id)}`}
              >
                <span className="rrow__id">
                  <span className="rrow__task">{pipeline.id}</span>
                  <span className="rrow__pipe">{pipeline.path}</span>
                </span>
                <span className="rrow__right">
                  {gates === 1 ? "1 gate" : `${gates} gates`}
                  <br />
                  <span className="mono" style={{ fontSize: "var(--font-size-xs)" }}>
                    {pipelineRuns.length} {pipelineRuns.length === 1 ? "run" : "runs"}
                  </span>
                </span>
                <span className="rrow__track">
                  <PipelineMiniTrack stages={pipeline.stages} />
                </span>
              </a>
            );
          })}
        </>
      ) : null}

      <NewPipelinePanel
        isOpen={pipelinePanelOpen}
        onClose={() => setPipelinePanelOpen(false)}
        onCreated={(pipeline) => void onPipelineCreated(pipeline)}
        pipelines={pipelines}
      />
    </div>
  );
}

function PipelineDetail({
  pipelineId,
  pipeline,
  tasks,
  runs,
  loading,
  error,
  onNew,
  onStageCreated,
  stagePanelOpen,
  onOpenStagePanel,
  onCloseStagePanel,
}: {
  pipelineId: string;
  pipeline: PipelineListing | null;
  tasks: TaskListing[];
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  onNew: (path: string) => void;
  onStageCreated: () => void;
  stagePanelOpen: boolean;
  onOpenStagePanel: () => void;
  onCloseStagePanel: () => void;
}) {
  const track = useMemo(
    () => (pipeline ? definitionTrack(pipeline.stages) : []),
    [pipeline],
  );

  const gates = pipeline ? gateCount(pipeline.stages) : 0;
  const subtitle = pipeline
    ? `${pipeline.path} · ${pipeline.stages.length} stages · ${
        gates === 1 ? "1 gate" : `${gates} gates`
      } · ${runs.length} ${runs.length === 1 ? "run" : "runs"}`
    : pipelineId;

  const defaultTask = pipeline ? defaultTaskForPipeline(pipeline, tasks) : undefined;

  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/pipelines">Pipelines</a> / {pipelineId}
      </p>

      <div className="page-head">
        <div>
          <h1>{pipelineId}</h1>
          <p className="mono">{subtitle}</p>
        </div>
        {pipeline ? (
          <button
            className="btn btn--primary"
            onClick={() =>
              onNew(
                newRunPath({
                  pipeline: pipeline.path,
                  ...(defaultTask ? { task: defaultTask } : {}),
                }),
              )
            }
          >
            Start a run with this
          </button>
        ) : null}
      </div>

        {error ? (
          <p style={{ color: "var(--color-text-red)" }}>{error}</p>
        ) : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && !pipeline ? (
          <p className="muted">
            {pipelineId} is not in the current manifest catalog.
          </p>
        ) : null}

        {pipeline ? (
          <>
            <PipelineTrack stages={track} mode="definition" />

            <div className="page-head" style={{ marginTop: "var(--spacing-6)" }}>
              <h3 style={{ margin: 0 }}>Stages</h3>
              <button type="button" className="btn btn--sm" onClick={onOpenStagePanel}>
                Add stage file
              </button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Gate</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.stages.map((stage) => (
                  <tr key={stage.id}>
                    <td className="mono">{stage.id}</td>
                    <td className="muted">{gateLabel(stage.gate_kinds)}</td>
                    <td className="mono muted">{stageSourceLabel(stage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-3)" }}>
              {gates === 1
                ? "Only one stage stops for a human. That is worth knowing before you start a run, not after."
                : gates === 0
                  ? "No stage in this pipeline is declared to stop for a human."
                  : `${gates} stages stop for a human.`}
            </p>

            <h3 style={{ marginTop: "var(--spacing-6)" }}>Recent runs</h3>
            {runs.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No runs of this pipeline yet.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.run_id}>
                      <td>
                        <a href={`#${runStreamPath(run.run_id)}`}>
                          {runTaskLabel(run)}
                        </a>
                        {run.task_path ? (
                          <span className="muted mono" style={{ display: "block", fontSize: "var(--font-size-xs)" }}>
                            {displayCatalogPath(run.task_path, run.project_root)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <StatusDot status={runDisplayStatus(run)} />
                      </td>
                      <td className="muted">{relativeTime(run.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}

      <NewStagePanel
        isOpen={stagePanelOpen}
        onClose={onCloseStagePanel}
        pipelineDirectory={pipeline ? pipelineDirectory(pipeline.path) : "pipelines"}
        onCreated={(_stage: CreatedStageListing) => {
          onCloseStagePanel();
          onStageCreated();
        }}
      />
    </div>
  );
}
