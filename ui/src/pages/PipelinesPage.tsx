import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPipelines,
  fetchStages,
  isValidStageListing,
  type PipelineListing,
  type PipelineStageListing,
  type RunSummary,
  type StageListing,
  type ValidStageListing,
} from "../api";
import { useRunCatalog } from "../catalog/useRunCatalog";
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
  const [stages, setStages] = useState<StageListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pipelinesLoading, setPipelinesLoading] = useState(true);
  const [stagesLoading, setStagesLoading] = useState(true);
  const [stagePanelOpen, setStagePanelOpen] = useState(false);
  const [pipelinePanelOpen, setPipelinePanelOpen] = useState(false);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [createdStageId, setCreatedStageId] = useState<string | null>(null);
  const [pipelineDraftStageId, setPipelineDraftStageId] = useState<string | null>(
    null,
  );
  const stageRowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const loadPipelines = useCallback(async () => {
    try {
      const p = await fetchPipelines();
      setPipelines(p.pipelines);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPipelinesLoading(false);
    }
  }, []);

  const loadStages = useCallback(async () => {
    try {
      const { stages: listed } = await fetchStages();
      setStages(listed);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStagesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadPipelines(), loadStages()]);
  }, [loadPipelines, loadStages]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedStageId) return;
    const row = stageRowRefs.current.get(selectedStageId);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedStageId, stages]);

  const loading = pipelinesLoading || stagesLoading || catalogLoading;
  const displayError = error ?? catalogError;
  const selected = pipelineId
    ? (pipelines.find((p) => p.id === pipelineId) ?? null)
    : null;
  const history = selected ? runsForPipelineView(snapshot, selected.id) : [];

  function openPipelinePanel(initialStageId?: string) {
    if (initialStageId) setPipelineDraftStageId(initialStageId);
    setPipelinePanelOpen(true);
  }

  function closePipelinePanel() {
    setPipelinePanelOpen(false);
    setPipelineDraftStageId(null);
  }

  function onStageCreated(stage: ValidStageListing) {
    setStagePanelOpen(false);
    setSelectedStageId(stage.id);
    setCreatedStageId(stage.id);
    void loadStages();
  }

  async function onPipelineCreated(pipeline: PipelineListing) {
    closePipelinePanel();
    setCreatedStageId(null);
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
        runs={history}
        loading={loading}
        error={displayError}
        onNew={onNew}
      />
    );
  }

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Pipelines</h1>
          <p>
            A pipeline is an ordered list of stages. Each row shows its chain
            and which stages will stop for a human.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => openPipelinePanel()}
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
          <p style={{ margin: "0 0 var(--spacing-3)" }}>No pipelines yet.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => openPipelinePanel()}
          >
            New pipeline
          </button>
        </div>
      ) : null}

      {!loading && pipelines.length > 0 ? (
        <>
          {pipelines.map((pipeline) => {
            const pipelineRuns = runsForPipelineView(snapshot, pipeline.id);
            const gates = gateCount(pipeline.stages);
            return (
              <a
                key={pipeline.id}
                className="rrow"
                href={`#${pipelinePath(pipeline.id)}`}
              >
                <span>
                  <span className="rrow__task">{pipeline.id}</span>
                  <span className="rrow__pipe" style={{ display: "block" }}>
                    {pipeline.path}
                  </span>
                </span>
                <PipelineMiniTrack stages={pipeline.stages} />
                <span className="rrow__right">
                  {gates === 1 ? "1 gate" : `${gates} gates`}
                  <br />
                  <span className="mono" style={{ fontSize: "var(--font-size-xs)" }}>
                    {pipelineRuns.length} {pipelineRuns.length === 1 ? "run" : "runs"}
                  </span>
                </span>
              </a>
            );
          })}
        </>
      ) : null}

      {!loading ? (
        <section
          className="card"
          style={{ marginTop: "var(--spacing-6)" }}
        >
          <div className="card__head">
            <h2>Stage library</h2>
            <button
              type="button"
              className="btn btn--primary"
              style={{ marginLeft: "auto" }}
              onClick={() => setStagePanelOpen(true)}
            >
              New stage
            </button>
          </div>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: 0, marginBottom: "var(--spacing-4)" }}>
            Stages are defined once and reused across pipelines. A gate
            belongs to the stage, which is why the same stage always stops
            for you wherever it appears.
          </p>
          {createdStageId ? (
            <div
              className="gate"
              style={{
                padding: "var(--spacing-4)",
                marginBottom: "var(--spacing-4)",
                borderColor: "var(--color-border-emphasized)",
              }}
            >
              <div className="gate__label">Stage created</div>
              <p className="gate__question">
                <span className="mono">{createdStageId}</span> is in the Stage library.
              </p>
              <div className="form-actions" style={{ paddingTop: "var(--spacing-3)" }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => {
                    setCreatedStageId(null);
                    openPipelinePanel(createdStageId);
                  }}
                >
                  Create a pipeline with this stage
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setCreatedStageId(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {stages.length === 0 ? (
            <div className="empty-hint">
              <p style={{ margin: "0 0 var(--spacing-3)" }}>No stages yet.</p>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setStagePanelOpen(true)}
              >
                New stage
              </button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Gate</th>
                  <th>Used by</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => {
                  const rowId = isValidStageListing(stage) ? stage.id : (stage.id ?? stage.path);
                  const selected = selectedStageId === rowId;
                  return (
                    <tr
                      key={stage.path}
                      ref={(node) => {
                        if (node) stageRowRefs.current.set(rowId, node);
                        else stageRowRefs.current.delete(rowId);
                      }}
                      className={selected ? "is-selected" : undefined}
                      aria-selected={selected || undefined}
                    >
                      <td className="mono">
                        {isValidStageListing(stage) ? (
                          stage.id
                        ) : (
                          <>
                            {stage.id ?? stage.path}
                            <span className="field-error" style={{ display: "block", marginTop: "var(--spacing-1)" }}>
                              {stage.error}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="muted">
                        {isValidStageListing(stage)
                          ? stage.gate_kinds && stage.gate_kinds.length > 0
                            ? stage.gate_kinds.join(" · ")
                            : "none"
                          : stage.gate_kinds && stage.gate_kinds.length > 0
                            ? stage.gate_kinds.join(" · ")
                            : "—"}
                      </td>
                      <td>
                        {isValidStageListing(stage)
                          ? stage.used_by_pipeline_ids.length === 1
                            ? "1 pipeline"
                            : `${stage.used_by_pipeline_ids.length} pipelines`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      <NewStagePanel
        isOpen={stagePanelOpen}
        onClose={() => setStagePanelOpen(false)}
        onCreated={onStageCreated}
      />
      <NewPipelinePanel
        isOpen={pipelinePanelOpen}
        onClose={closePipelinePanel}
        onCreated={(pipeline) => void onPipelineCreated(pipeline)}
        stages={stages}
        initialStageIds={pipelineDraftStageId ? [pipelineDraftStageId] : undefined}
      />
    </div>
  );
}

function PipelineDetail({
  pipelineId,
  pipeline,
  runs,
  loading,
  error,
  onNew,
}: {
  pipelineId: string;
  pipeline: PipelineListing | null;
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  onNew: (path: string) => void;
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
            onClick={() => onNew(newRunPath({ pipeline: pipeline.id }))}
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
            {pipelineId} is not in this project's pipelines/ catalog.
          </p>
        ) : null}

        {pipeline ? (
          <>
            <PipelineTrack stages={track} mode="definition" />

            <h3 style={{ marginTop: "var(--spacing-6)" }}>Stages</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Gate</th>
                </tr>
              </thead>
              <tbody>
                {pipeline.stages.map((stage) => (
                  <tr key={stage.id}>
                    <td className="mono">{stage.id}</td>
                    <td className="muted">{gateLabel(stage.gate_kinds)}</td>
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
                          {run.task_id ?? "unknown task"}
                        </a>
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
    </div>
  );
}
