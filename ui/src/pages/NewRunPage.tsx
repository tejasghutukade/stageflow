import { Fragment, useEffect, useMemo, useState } from "react";
import {
  fetchPipelines,
  fetchTasks,
  startRunWithDetails,
  type PipelineListing,
  type StageGateKind,
  type StartRunResult,
  type TaskListing,
} from "../api";
import { stageMayAsk } from "../catalogJoin";

export function previewGateMeta(gateKinds?: StageGateKind[]): string {
  if (gateKinds === undefined) return "all kinds";
  if (gateKinds.length === 0) return "no gate";
  return "will ask you";
}
import { useRunCatalog } from "../catalog/useRunCatalog";
import { waitingRunsAmongView } from "../catalog/views";
import { PipelineTrack, type TrackStage } from "../components/PipelineTrack";
import { loadProviderAuthReadiness } from "../providers/readiness";

export function NewRunPage({
  onStarted,
  initialPipelinePath,
  initialTaskPath,
}: {
  onStarted: (runId: string) => void;
  initialPipelinePath?: string;
  initialTaskPath?: string;
}) {
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [pipelines, setPipelines] = useState<PipelineListing[]>([]);
  const [task, setTask] = useState<string>("");
  const [pipeline, setPipeline] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<Extract<
    StartRunResult,
    { ok: false }
  > | null>(null);
  const [authGateMessage, setAuthGateMessage] = useState<string | null>(null);
  const { snapshot, error: catalogError } = useRunCatalog();
  const health = snapshot.health;

  useEffect(() => {
    void (async () => {
      try {
        const [t, p] = await Promise.all([fetchTasks(), fetchPipelines()]);
        setTasks(t.tasks);
        setPipelines(p.pipelines);
        const preferredTask =
          initialTaskPath && t.tasks.some((item) => item.path === initialTaskPath)
            ? initialTaskPath
            : (t.tasks[0]?.path ?? "");
        const preferredPipeline =
          initialPipelinePath &&
          p.pipelines.some((item) => item.path === initialPipelinePath)
            ? initialPipelinePath
            : (p.pipelines[0]?.path ?? "");
        setTask(preferredTask);
        setPipeline(preferredPipeline);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [initialPipelinePath, initialTaskPath]);

  const selectedPipeline = pipelines.find((p) => p.path === pipeline) ?? null;
  const previewStages: TrackStage[] = useMemo(() => {
    if (!selectedPipeline) return [];
    return selectedPipeline.stages.map((s) => ({
      id: s.id,
      label: s.id,
      status: (stageMayAsk(s.gate_kinds) ? "waiting" : "pending") as TrackStage["status"],
      meta: previewGateMeta(s.gate_kinds),
    }));
  }, [selectedPipeline]);

  const slotsFull = health != null && health.slotsAvailable === 0;
  const heldWaiting =
    health != null
      ? waitingRunsAmongView(snapshot, health.activeRunIds).length
      : 0;
  const displayError =
    error ?? (health == null && catalogError ? catalogError : null);

  async function onSubmit() {
    if (!task || !pipeline) {
      setError("Pick a task and a pipeline.");
      return;
    }
    setStarting(true);
    setError(null);
    setStartFailure(null);
    setAuthGateMessage(null);
    try {
      const readiness = await loadProviderAuthReadiness();
      if (!readiness.ready) {
        setAuthGateMessage(
          readiness.message ??
            "Connect providers before starting a run.",
        );
        setStarting(false);
        return;
      }
    } catch (err) {
      setAuthGateMessage(
        err instanceof Error ? err.message : String(err),
      );
      setStarting(false);
      return;
    }
    const result = await startRunWithDetails(task, pipeline);
    setStarting(false);
    if (result.ok) {
      onStarted(result.runId);
      return;
    }
    setStartFailure(result);
  }

  return (
    <div className="main__inner">
      <p className="crumbs"><a href="#/today">Today</a> / start a run</p>
      <div className="page-head">
        <div>
          <h1>Start a run</h1>
          <p>A run is a task path plus a pipeline path. Nothing else is decided here.</p>
        </div>
      </div>

      {slotsFull && health ? (
        <div className="gate" style={{ padding: "var(--spacing-4)", marginBottom: "var(--spacing-5)" }}>
          <div className="gate__label"><span className="dot dot--waiting"></span> No free session slots</div>
          <p className="gate__question">All {health.maxConcurrent} slots are in use{heldWaiting > 0 ? ` — ${heldWaiting === 1 ? "one is" : `${heldWaiting} are`} held by stages waiting on you` : ""}</p>
          {health.activeRunIds.length > 0 ? (
            <p style={{ margin: "var(--spacing-2) 0 0", color: "var(--color-text-yellow)", fontSize: "var(--font-size-sm)" }}>
              Blocking runs: {health.activeRunIds.map((id, i) => (
                <Fragment key={id}>{i > 0 ? ", " : ""}<a href={`#/runs/${id}`}>{id.slice(0, 8)}</a></Fragment>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}

      
      {authGateMessage ? (
        <div className="gate" style={{ padding: "var(--spacing-4)", marginBottom: "var(--spacing-5)" }}>
          <div className="gate__label"><span className="dot dot--waiting"></span> Providers not ready</div>
          <p className="gate__question">{authGateMessage}</p>
          <p style={{ margin: "var(--spacing-2) 0 0", fontSize: "var(--font-size-sm)" }}>
            <a href="#/connect">Connect providers</a>
            {" · "}
            <a href="#/settings">Open Settings</a>
          </p>
        </div>
      ) : null}

      {startFailure ? (
        <div className="gate" style={{ padding: "var(--spacing-4)", marginBottom: "var(--spacing-5)", borderColor: "var(--color-border-red)", borderLeftColor: "var(--color-error)", background: "var(--color-background-red)", color: "var(--color-text-red)" }}>
          <div className="gate__label" style={{ color: "var(--color-text-red)" }}>Could not start run</div>
          <p className="gate__question" style={{ color: "var(--color-text-primary)" }}>{startFailure.error}</p>
        </div>
      ) : null}
      {displayError ? <p style={{ color: "var(--color-text-red)", marginBottom: "var(--spacing-4)" }}>Could not start run: {displayError}</p> : null}

      <div className="grid-2">
        <div>
          <section className="card">
            <div className="card__head"><h2>Task</h2></div>
            <div className="pick">
              {tasks.map(t => (
                <label key={t.path} className="pick__opt">
                  <input type="radio" name="task" checked={task === t.path} onChange={() => setTask(t.path)} />
                  <span>
                    <strong>{t.id}</strong>
                    <span>{t.goal}</span>
                    <span className="mono muted" style={{ display: "block", fontSize: "var(--font-size-xs)" }}>{t.path}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        </div>
        <div>
          <section className="card">
            <div className="card__head"><h2>Pipeline</h2></div>
            <div className="pick">
              {pipelines.map(p => (
                <label key={p.path} className="pick__opt">
                  <input type="radio" name="pipeline" checked={pipeline === p.path} onChange={() => setPipeline(p.path)} />
                  <span>
                    <strong>{p.id}</strong>
                    <span>{p.stages.length} stages</span>
                    <span className="mono muted" style={{ display: "block", fontSize: "var(--font-size-xs)" }}>{p.path}</span>
                  </span>
                </label>
              ))}
            </div>
            {previewStages.length > 0 ? (
              <>
                <div className="eyebrow" style={{ marginTop: "var(--spacing-4)", marginBottom: "var(--spacing-3)" }}>What will run</div>
                <div className="track track--inline">
                  <PipelineTrack stages={previewStages} mode="definition" />
                </div>
                <p className="muted" style={{ fontSize: "var(--font-size-sm)", marginTop: "var(--spacing-3)" }}>
                  {previewStages.filter((s) => s.status === "waiting").length === 0
                    ? "No stage in this pipeline is declared to stop for a human."
                    : `${previewStages.filter((s) => s.status === "waiting").length} ${previewStages.filter((s) => s.status === "waiting").length === 1 ? "stage" : "stages"} will hold and wait for you.`}
                </p>
              </>
            ) : null}
          </section>
        </div>
      </div>

      <div className="form-actions" style={{ paddingBottom: "var(--spacing-8)" }}>
        <button className="btn btn--primary" disabled={!task || !pipeline || slotsFull || starting} onClick={() => void onSubmit()}>
          {starting ? "Starting…" : "Start run"}
        </button>
        <a className="btn btn--ghost" href="#/today">Cancel</a>
      </div>
    </div>
  );
}
