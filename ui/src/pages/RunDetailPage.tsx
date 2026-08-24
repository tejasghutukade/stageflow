import { useCallback, useEffect, useRef, useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import {
  fetchPipelines,
  fetchRun,
  rerun,
  type PipelineListing,
  type RunDetail,
} from "../api";
import { useRunCatalogHandle } from "../catalog/useRunCatalog";
import { ReplyZone } from "../ReplyZone";
import { StatusLabel } from "../StatusLabel";
import { AttemptCountBadge } from "../components/AttemptCountBadge";
import { ArtifactAside } from "../components/ArtifactAside";
import { ArtifactReader } from "../components/ArtifactReader";
import { ArtifactDecideColumn } from "../components/DecidePanel";
import { EnvelopeDrawer } from "../components/EnvelopeDrawer";
import { EnvelopeRecord } from "../components/EnvelopeFields";
import { RunTrack } from "../components/RunTrack";
import { TranscriptStream } from "../components/TranscriptStream";
import { TranscriptTurns } from "../components/TranscriptTurns";
import type { DetailView } from "../routes";
import { cssStatusToken, statusCopy } from "../status/runStatus";
import {
  canAbandon,
  canRetry,
  isStageActionBusy,
  useStageAbandon,
  useStageRetry,
} from "../stageAction";
import {
  resolveRunWorkspace,
  type RunWorkspace,
  type SessionChipKind,
} from "../workspace/resolveRunWorkspace";

function sessionChipEl(kind: SessionChipKind) {
  if (kind === "alive") return <span className="chip">session alive</span>;
  if (kind === "closed") return <span className="chip">session closed</span>;
  return null;
}

function composerEl(
  runId: string,
  workspace: RunWorkspace,
  onOpenArtifact: (path: string) => void,
) {
  const stage = workspace.selectedStage;
  if (workspace.composer.kind === "reply" && stage) {
    return (
      <div className="composer">
        <div className="composer__inner">
          <ReplyZone
            runId={runId}
            stageId={stage.stage_id}
            prompt={workspace.composer.prompt}
            onReviewSideBySide={onOpenArtifact}
          />
        </div>
      </div>
    );
  }
  if (workspace.composer.kind === "idle") {
    return (
      <div className="composer composer--idle">
        <div className="composer__inner">
          <p className="muted">{workspace.composer.label}</p>
        </div>
      </div>
    );
  }
  return undefined;
}

export function RunDetailPage({
  runId,
  view,
  onBack,
  onReran,
  onOpenStream,
  onOpenArtifact,
  onOpenEnvelope,
}: {
  runId: string;
  view: DetailView;
  onBack: () => void;
  onReran: (runId: string) => void;
  onOpenStream: () => void;
  onOpenArtifact: (path: string) => void;
  onOpenEnvelope: (stageId: string) => void;
}) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userPickedStageId, setUserPickedStageId] = useState<string | null>(null);
  const previousStageIdRef = useRef<string | null>(null);
  const [drawerStageId, setDrawerStageId] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const wasWaitingArtifact = useRef(false);
  const onOpenStreamRef = useRef(onOpenStream);
  onOpenStreamRef.current = onOpenStream;
  const catalog = useRunCatalogHandle();

  const load = useCallback(async () => {
    try {
      const data = await fetchRun(runId);
      setRun(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  const onStageActionSuccess = useCallback(async () => {
    await load();
    catalog.refresh();
  }, [load, catalog]);

  const {
    retryingStageIds,
    error: retryError,
    retry,
    clearError: clearRetryError,
  } = useStageRetry(runId, onStageActionSuccess);

  const {
    abandoningStageId,
    error: abandonError,
    abandon,
    clearError: clearAbandonError,
  } = useStageAbandon(runId, onStageActionSuccess);

  const actionBusy = {
    retryingStageIds,
    abandoningStageId,
  };

  useEffect(() => {
    setUserPickedStageId(null);
    previousStageIdRef.current = null;
    setDrawerStageId(null);
    setRun(null);
    setError(null);
    wasWaitingArtifact.current = false;
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void fetchPipelines()
      .then((data) => {
        if (!cancelled) setPipelines(data.pipelines);
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const live =
      run?.status === "created" ||
      run?.status === "running" ||
      retryingStageIds.size > 0 ||
      abandoningStageId !== null;
    if (!live) return;
    const id = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(id);
  }, [load, run?.status, retryingStageIds, abandoningStageId]);

  const plannedStageIds =
    pipelines?.find((p) => p.id === run?.pipeline_id)?.stages.map((s) => s.id) ??
    [];

  const workspace = run
    ? resolveRunWorkspace(
        view,
        run,
        {
          previousStageId: userPickedStageId ?? previousStageIdRef.current,
          userPicked: userPickedStageId !== null,
          drawerStageId,
          wasWaitingArtifact: wasWaitingArtifact.current,
        },
        plannedStageIds,
      )
    : null;

  if (workspace) previousStageIdRef.current = workspace.selectedStageId;

  if (workspace?.waitingArtifact) {
    wasWaitingArtifact.current = true;
  } else if (view.kind !== "artifact") {
    wasWaitingArtifact.current = false;
  }

  useEffect(() => {
    if (workspace?.syncStreamRoute) {
      onOpenStreamRef.current();
    }
  }, [workspace?.syncStreamRoute]);

  async function onRerunClick() {
    setRerunning(true);
    setError(null);
    clearRetryError();
    clearAbandonError();
    try {
      const result = await rerun(runId);
      onReran(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  }

  const stage = workspace?.selectedStage ?? null;
  const selectedPath = workspace?.selectedPath;
  const runToken = run ? cssStatusToken(run.status) : undefined;
  const composer = workspace
    ? composerEl(runId, workspace, onOpenArtifact)
    : undefined;

  let body;
  if (error) {
    body = (
      <div style={{ padding: "var(--spacing-4)" }}>
        <div className="banner banner--error">{error}</div>
      </div>
    );
  } else if (!run || !workspace) {
    body = (
      <div style={{ padding: "var(--spacing-4)" }}>
        <p>Loading…</p>
      </div>
    );
  } else if (workspace.kind === "empty") {
    body = (
      <div style={{ padding: "var(--spacing-4)" }}>
        <p>
          {run.stages.length === 0
            ? "No stages have started yet."
            : "Select a stage to inspect."}
        </p>
      </div>
    );
  } else if (workspace.kind === "artifact" && selectedPath) {
    body = (
      <ArtifactReader
        runId={runId}
        path={selectedPath}
        readOnly={workspace.artifactReadOnly}
        onBackToTranscript={onOpenStream}
      />
    );
  } else if (workspace.kind === "envelope" && workspace.envelope) {
    body = workspace.envelope.envelope ? (
      <EnvelopeRecord
        fromStageId={workspace.envelope.fromStageId}
        toStageId={workspace.envelope.toStageId}
        envelope={workspace.envelope.envelope}
        onBackToTranscript={onOpenStream}
        onArtifactClick={onOpenArtifact}
      />
    ) : (
      <div style={{ padding: "var(--spacing-4)" }}>
        <div className="banner banner--warning">{workspace.envelope.fromStageId} has not emitted a handoff envelope.</div>
      </div>
    );
  } else if (stage) {
    body = (
      <TranscriptStream
        stageName={stage.stage_id}
        status={
          <>
            <StatusLabel status={stage.status} />
            <AttemptCountBadge count={stage.attempt_count} />
            {sessionChipEl(workspace.sessionChip)}
            {canRetry(stage.status) ? (
              <button
                type="button"
                className="btn btn--sm"
                disabled={isStageActionBusy(actionBusy, stage.stage_id)}
                onClick={() => retry(stage.stage_id)}
              >
                {retryingStageIds.has(stage.stage_id)
                  ? "Retrying…"
                  : "Retry stage"}
              </button>
            ) : null}
            {canAbandon(stage.status) ? (
              <button
                type="button"
                className="btn btn--sm btn--reject"
                disabled={isStageActionBusy(actionBusy, stage.stage_id)}
                onClick={() => abandon(stage.stage_id)}
              >
                {abandoningStageId === stage.stage_id ? "Abandoning…" : "Abandon"}
              </button>
            ) : null}
          </>
        }
        autoScroll={workspace.liveStream}
        scrollKey={stage.events.length}
        composer={composer}
      >
        <TranscriptTurns
          events={stage.events}
          inboundEnvelope={workspace.inboundEnvelope}
        />
      </TranscriptStream>
    );
  }

  return (
    <>
      <div className="pane" style={{ height: "100%" }}>
        <div className="topbar">
          <a className="topbar__back" href="#/runs" onClick={e => { e.preventDefault(); onBack(); }}>← Runs</a>
          <h2 className="topbar__title">{run?.pipeline_id ?? runId}</h2>
          {run?.task_id ? <span className="topbar__sub">{run.task_id}</span> : null}
          {run ? (
            <span className={`status${runToken && runToken !== "running" ? ` status--${runToken}` : ""}`}>
              <span className={`dot${runToken ? ` dot--${runToken}` : ""}`}></span>
              {" "}{statusCopy(run.status)}
            </span>
          ) : null}
          <span className="topbar__spacer"></span>
          <button className="btn btn--primary" disabled={rerunning} onClick={() => void onRerunClick()}>
            {rerunning ? "Starting fresh…" : "Start fresh"}
          </button>
        </div>

        {retryError ? (
          <div className="banner banner--error" style={{ padding: "var(--spacing-3) var(--spacing-5)" }}>
            {retryError}
          </div>
        ) : null}

        {abandonError ? (
          <div className="banner banner--error" style={{ padding: "var(--spacing-3) var(--spacing-5)" }}>
            {abandonError}
          </div>
        ) : null}

        {run && workspace && (workspace.trackLayout.mode === "linear"
          ? workspace.trackLayout.linearStages.length > 0
          : workspace.trackLayout.dagLayers.some((l) => l.length > 0) ||
            workspace.detailListRows.length > 0) ? (
          <RunTrack
            trackLayout={workspace.trackLayout}
            detailListRows={workspace.detailListRows}
            selectedStageId={workspace.selectedStageId}
            onSelect={(id) => {
              setUserPickedStageId(id);
              onOpenStream();
            }}
            onEnvelopeClick={(fromStageId) => setDrawerStageId(fromStageId)}
            activeEnvelopeId={workspace.activeEnvelopeId}
            retryingStageIds={retryingStageIds}
            onRetryStage={retry}
            abandoningStageId={abandoningStageId}
            onAbandonStage={abandon}
          />
        ) : null}

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {run && run.stages.length > 0 && workspace ? (
            <div style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--color-border)", overflow: "auto" }}>
              <ArtifactAside
                files={workspace.artifactFiles}
                selectedPath={selectedPath}
                onSelect={onOpenArtifact}
                footer={
                  <Collapsible
                    trigger={<span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>Input</span>}
                    defaultIsOpen={false}
                  >
                    <CodeBlock
                      code={run.task_yaml}
                      language="yaml"
                      container="section"
                      maxHeight={200}
                      width="100%"
                    />
                  </Collapsible>
                }
              />
            </div>
          ) : null}

          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {body}
          </div>

          {workspace?.showDecide && workspace.decidePrompt && stage ? (
            <div style={{ width: 320, flexShrink: 0, borderLeft: "1px solid var(--color-border)" }}>
              <ArtifactDecideColumn
                runId={runId}
                stageId={stage.stage_id}
                prompt={workspace.decidePrompt}
                events={stage.events}
                inboundEnvelope={workspace.inboundEnvelope}
                inboundFromStageId={workspace.inboundFromStageId}
                inboundToStageId={workspace.inboundToStageId}
                selectedPath={selectedPath}
                onSelectArtifact={onOpenArtifact}
                onOpenInboundEnvelope={
                  workspace.inboundFromStageId
                    ? () => {
                        const fromId = workspace.inboundFromStageId;
                        if (fromId) setDrawerStageId(fromId);
                      }
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
      </div>

      {workspace?.drawer ? (
        <EnvelopeDrawer
          isOpen
          onClose={() => setDrawerStageId(null)}
          fromStageId={workspace.drawer.fromStageId}
          toStageId={workspace.drawer.toStageId}
          envelope={workspace.drawer.envelope}
          onOpenFullRecord={() => {
            const fromStageId = workspace.drawer?.fromStageId;
            setDrawerStageId(null);
            if (fromStageId) onOpenEnvelope(fromStageId);
          }}
          onArtifactClick={(path) => {
            setDrawerStageId(null);
            onOpenArtifact(path);
          }}
        />
      ) : null}
    </>
  );
}
