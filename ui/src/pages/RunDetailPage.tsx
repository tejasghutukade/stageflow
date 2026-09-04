import { useCallback, useEffect, useRef, useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import {
  fetchPipelines,
  fetchRun,
  fetchStageVerification,
  recoverManualStage,
  rerun,
  stopManualRecovery,
  type PipelineListing,
  type RunDetail,
  type StageVerificationHistory,
} from "../api";
import { useRunCatalogHandle } from "../catalog/useRunCatalog";
import { runLocatorSubtitle, runTaskLabel } from "../catalog/displayCatalogPath";
import { ReplyZone } from "../ReplyZone";
import { AttemptCountBadge } from "../components/AttemptCountBadge";
import { ArtifactAside } from "../components/ArtifactAside";
import { ArtifactReader } from "../components/ArtifactReader";
import { ArtifactDecideColumn } from "../components/DecidePanel";
import { EnvelopeDrawer } from "../components/EnvelopeDrawer";
import { EnvelopeRecord } from "../components/EnvelopeFields";
import { SpatialRunMap } from "../components/SpatialRunMap";
import { TranscriptStream } from "../components/TranscriptStream";
import { TranscriptTurns } from "../components/TranscriptTurns";
import { VerificationHistory } from "../components/VerificationHistory";
import type { DetailView } from "../routes";
import {
  abandonedDisplayCopy,
  cssStatusToken,
  isAbandonedDisplay,
  statusCopy,
} from "../status/runStatus";
import {
  canAbandon,
  canRetry,
  isStageActionBusy,
  useStageAbandon,
  useStageRetry,
} from "../stageAction";
import {
  activeWaitKey,
  parseEnvelopeAsidePath,
  resolveRunWorkspace,
  runDetailShouldPoll,
  stageCloneLabel,
  type RunWorkspace,
  type SessionChipKind,
} from "../workspace/resolveRunWorkspace";
import { resolveStreamRoute } from "../workspace/resolveStreamRoute";

const WORK_DEFAULT_H = 300;
const WORK_MIN_H = 200;
const MAP_MIN_H = 140;
const WORK_ARROW_STEP = 24;

export function clampWorkHeight(requested: number, paneHeight: number): number {
  const maxByMap = paneHeight - MAP_MIN_H;
  if (paneHeight < 340) return Math.max(0, maxByMap);
  return Math.max(WORK_MIN_H, Math.min(requested, maxByMap));
}

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
  onOpenStream: (stageId?: string) => void;
  onOpenArtifact: (path: string) => void;
  onOpenEnvelope: (stageId: string) => void;
}) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<StageVerificationHistory | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [manualRecoveryBusy, setManualRecoveryBusy] = useState(false);
  const [manualRecoveryError, setManualRecoveryError] = useState<string | null>(null);
  const [userPickedStageId, setUserPickedStageId] = useState<string | null>(
    () => (view.kind === "stream" && view.stageId ? view.stageId : null),
  );
  const previousStageIdRef = useRef<string | null>(null);
  const [drawerStageId, setDrawerStageId] = useState<string | null>(null);
  const [dismissedWaitKey, setDismissedWaitKey] = useState<string | null>(null);
  const [workHeight, setWorkHeight] = useState(WORK_DEFAULT_H);
  const [paneHeight, setPaneHeight] = useState(0);
  const [splitDragging, setSplitDragging] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const splitGestureRef = useRef<{ id: number; y: number; h: number } | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const wasWaitingArtifact = useRef(false);
  const onOpenStreamRef = useRef(onOpenStream);
  onOpenStreamRef.current = onOpenStream;
  const catalog = useRunCatalogHandle();
  const streamViewStageId = view.kind === "stream" ? view.stageId : undefined;

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

  const recoverStage = useCallback(
    async (stageId: string, guidance: string) => {
      setManualRecoveryBusy(true);
      setManualRecoveryError(null);
      try {
        await recoverManualStage(runId, stageId, guidance);
        await onStageActionSuccess();
      } catch (err) {
        setManualRecoveryError(err instanceof Error ? err.message : String(err));
      } finally {
        setManualRecoveryBusy(false);
      }
    },
    [onStageActionSuccess, runId],
  );

  const stopStageRecovery = useCallback(
    async (stageId: string) => {
      if (!window.confirm("Stop manual recovery? This stage will remain failed in this run.")) {
        return;
      }
      setManualRecoveryBusy(true);
      setManualRecoveryError(null);
      try {
        await stopManualRecovery(runId, stageId);
        await onStageActionSuccess();
      } catch (err) {
        setManualRecoveryError(err instanceof Error ? err.message : String(err));
      } finally {
        setManualRecoveryBusy(false);
      }
    },
    [onStageActionSuccess, runId],
  );

  const {
    retryingStageIds,
    error: retryError,
    retry,
    clearError: clearRetryError,
  } = useStageRetry(runId, onStageActionSuccess);

  const retryAndSelect = useCallback(
    (stageId: string) => {
      setUserPickedStageId(stageId);
      onOpenStream(stageId);
      retry(stageId);
    },
    [onOpenStream, retry],
  );

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
    setUserPickedStageId(streamViewStageId ?? null);
    previousStageIdRef.current = null;
    setDrawerStageId(null);
    setDismissedWaitKey(null);
    setWorkHeight(WORK_DEFAULT_H);
    setRun(null);
    setError(null);
    setVerification(null);
    setVerificationError(null);
    setManualRecoveryBusy(false);
    setManualRecoveryError(null);
    wasWaitingArtifact.current = false;
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view.kind !== "stream") return;
    setUserPickedStageId(streamViewStageId ?? null);
  }, [view.kind, streamViewStageId]);

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

  const live = runDetailShouldPoll(run, {
    retrying: retryingStageIds.size > 0,
    abandoning: abandoningStageId !== null,
  });

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(id);
  }, [load, live]);

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
          dismissedWaitKey,
          wasWaitingArtifact: wasWaitingArtifact.current,
        },
        plannedStageIds,
      )
    : null;

  const verificationStageId = workspace?.selectedStageId;
  const verificationAttemptCount = workspace?.selectedStage?.attempt_count;
  useEffect(() => {
    if (!verificationStageId) {
      setVerification(null);
      setVerificationError(null);
      return;
    }
    let cancelled = false;
    setVerification(null);
    setVerificationError(null);
    void fetchStageVerification(runId, verificationStageId)
      .then((history) => {
        if (!cancelled) setVerification(history);
      })
      .catch((err) => {
        if (!cancelled) {
          setVerificationError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runId, verificationStageId, verificationAttemptCount]);

  if (workspace) previousStageIdRef.current = workspace.selectedStageId;

  if (workspace?.waitingArtifact) {
    wasWaitingArtifact.current = true;
  } else if (view.kind !== "artifact") {
    wasWaitingArtifact.current = false;
  }

  useEffect(() => {
    const command = resolveStreamRoute({
      view,
      streamViewStageId,
      run,
      plannedStageIds,
      selectedStageId: workspace?.selectedStageId ?? null,
      syncStreamRoute: workspace?.syncStreamRoute ?? false,
      userPickedStageId,
      dismissedWaitKey,
    });
    if (command.action === "openStream") {
      onOpenStreamRef.current(command.stageId);
    }
  }, [
    view,
    streamViewStageId,
    run,
    plannedStageIds,
    workspace?.selectedStageId,
    workspace?.syncStreamRoute,
    userPickedStageId,
    dismissedWaitKey,
  ]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPaneHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const applyWorkHeight = useCallback(
    (requested: number) => {
      const height = paneRef.current?.getBoundingClientRect().height ?? paneHeight;
      setWorkHeight(clampWorkHeight(requested, height));
    },
    [paneHeight],
  );

  const hideWorkspace = useCallback(() => {
    if (run) setDismissedWaitKey(activeWaitKey(run));
    setUserPickedStageId(null);
    previousStageIdRef.current = null;
    setDrawerStageId(null);
    onOpenStream();
  }, [onOpenStream, run]);

  const openSelectedStream = useCallback(() => {
    const stageId =
      workspace?.selectedStageId ??
      (view.kind === "envelope" ? view.stageId : undefined) ??
      userPickedStageId;
    if (stageId) {
      setUserPickedStageId(stageId);
      onOpenStream(stageId);
      return;
    }
    onOpenStream();
  }, [onOpenStream, userPickedStageId, view, workspace?.selectedStageId]);

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
  const manualRecovery =
    verification !== null && verification.stage_id === stage?.stage_id
      ? verification.manual_recovery
      : undefined;
  const selectedPath = workspace?.selectedPath;
  const runToken = run ? cssStatusToken(run.status) : undefined;
  const composer = workspace
    ? composerEl(runId, workspace, onOpenArtifact)
    : undefined;
  const hasMapNodes = Boolean(workspace && workspace.spatialLayout.nodes.length > 0);
  const showWorkspace = Boolean(
    workspace &&
      (workspace.selectedStageId ||
        workspace.kind === "artifact" ||
        workspace.kind === "envelope"),
  );

  const abandoned = stage ? isAbandonedDisplay(stage.events) : false;
  const hideButton = (
    <button type="button" className="btn btn--sm" onClick={hideWorkspace}>
      Hide workspace
    </button>
  );

  let center;
  if (error) {
    center = (
      <div style={{ padding: "var(--spacing-4)" }}>
        <div className="banner banner--error">{error}</div>
      </div>
    );
  } else if (!run || !workspace) {
    center = (
      <div style={{ padding: "var(--spacing-4)" }}>
        <p>Loading…</p>
      </div>
    );
  } else if (workspace.kind === "artifact" && selectedPath) {
    center = (
      <ArtifactReader
        runId={runId}
        path={selectedPath}
        readOnly={workspace.artifactReadOnly}
        onBackToTranscript={openSelectedStream}
        onHide={hideWorkspace}
      />
    );
  } else if (workspace.kind === "envelope" && workspace.envelope) {
    center = workspace.envelope.envelope ? (
      <EnvelopeRecord
        fromStageId={workspace.envelope.fromStageId}
        toStageId={workspace.envelope.toStageId}
        envelope={workspace.envelope.envelope}
        onBackToTranscript={openSelectedStream}
        onHide={hideWorkspace}
        onArtifactClick={onOpenArtifact}
        stageLabel={(id) => stageCloneLabel(run, id)}
      />
    ) : (
      <div className="stream" style={{ height: "100%" }}>
        <header className="stream__head">
          <h3 className="stream__name">Handoff envelope</h3>
          <span className="topbar__spacer"></span>
          <div className="stream__head-trail">
            <button type="button" className="btn btn--sm" onClick={openSelectedStream}>
              ← Transcript
            </button>
            {hideButton}
          </div>
        </header>
        <div style={{ padding: "var(--spacing-4)" }}>
          <div className="banner banner--warning">{workspace.envelope.fromStageId} has not emitted a handoff envelope.</div>
        </div>
      </div>
    );
  } else if (workspace.selectedStageId) {
    const streamStageId = workspace.selectedStageId;
    const stageToken = stage ? cssStatusToken(stage.status) : undefined;
    center = (
      <TranscriptStream
        stageName={
          workspace.trackStages.find((s) => s.id === streamStageId)?.label ??
          streamStageId
        }
        status={
          <>
            {abandoned ? (
              <span className="status status--failed">
                <span className="dot dot--failed"></span>
                {" "}{abandonedDisplayCopy()}
              </span>
            ) : (
              <span className={`status${stageToken && stageToken !== "running" ? ` status--${stageToken}` : ""}`}>
                <span className={`dot${stageToken ? ` dot--${stageToken}` : ""}`}></span>
                {" "}{stage ? statusCopy(stage.status) : "pending"}
              </span>
            )}
            {stage ? <AttemptCountBadge count={stage.attempt_count} /> : null}
            {sessionChipEl(workspace.sessionChip)}
            {stage && canRetry(stage.status) && manualRecovery === undefined ? (
              <button
                type="button"
                className="btn btn--sm"
                disabled={isStageActionBusy(actionBusy, stage.stage_id)}
                onClick={() => retryAndSelect(stage.stage_id)}
              >
                {retryingStageIds.has(stage.stage_id)
                  ? "Retrying…"
                  : "Retry stage"}
              </button>
            ) : null}
            {stage && canAbandon(stage.status) ? (
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
        trailing={hideButton}
        autoScroll={workspace.liveStream}
        scrollKey={stage?.events.length}
        composer={composer}
      >
        <TranscriptTurns
          events={stage?.events ?? []}
          inboundEnvelope={workspace.inboundEnvelope}
        />
        <VerificationHistory
          history={verification}
          error={verificationError}
          recovering={manualRecoveryBusy}
          onRecover={stage ? (guidance) => void recoverStage(stage.stage_id, guidance) : undefined}
          onStop={stage ? () => void stopStageRecovery(stage.stage_id) : undefined}
        />
      </TranscriptStream>
    );
  }

  const splitMax = Math.max(0, paneHeight - MAP_MIN_H);
  const splitMin = paneHeight < 340 ? splitMax : WORK_MIN_H;

  return (
    <>
      <div
        ref={paneRef}
        className={`pane run-detail${showWorkspace ? " has-stage" : ""}${splitDragging ? " is-resizing" : ""}`}
        style={{ height: "100%", ["--work-h" as string]: `${workHeight}px` }}
      >
        <div>
          <div className="topbar">
            <a className="topbar__back" href="#/runs" onClick={e => { e.preventDefault(); onBack(); }}>← Runs</a>
            <h2 className="topbar__title">{run ? runTaskLabel(run) : "Loading…"}</h2>
            {run ? (
              <span className="topbar__sub" title={runLocatorSubtitle(run)}>
                {runLocatorSubtitle(run)}
              </span>
            ) : null}
            {run ? (
              <span className={`status${runToken && runToken !== "running" ? ` status--${runToken}` : ""}`}>
                <span className={`dot${runToken ? ` dot--${runToken}` : ""}`}></span>
                {" "}{statusCopy(run.status)}
              </span>
            ) : null}
            <span className="topbar__spacer"></span>
            <button className="btn btn--primary" disabled={rerunning} onClick={() => void onRerunClick()}>
              {rerunning
                ? run?.status === "created"
                  ? "Starting…"
                  : "Starting fresh…"
                : run?.status === "created"
                  ? "Start run"
                  : "Start fresh"}
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

          {manualRecoveryError ? (
            <div className="banner banner--error" style={{ padding: "var(--spacing-3) var(--spacing-5)" }}>
              {manualRecoveryError}
            </div>
          ) : null}
        </div>

        {error && !run ? (
          <div style={{ padding: "var(--spacing-4)" }}>
            <div className="banner banner--error">{error}</div>
          </div>
        ) : !run || !workspace ? (
          <div style={{ padding: "var(--spacing-4)" }}>
            <p>Loading…</p>
          </div>
        ) : hasMapNodes ? (
          <div className="workspace">
            <SpatialRunMap
              layout={workspace.spatialLayout}
              stages={run.stages}
              nodeChrome={workspace.nodeChrome}
              selectedStageId={workspace.selectedStageId}
              onSelectStage={(id) => {
                setUserPickedStageId(id);
                onOpenStream(id);
              }}
              onDeselect={hideWorkspace}
              retryingStageIds={retryingStageIds}
              onRetryStage={retryAndSelect}
              abandoningStageId={abandoningStageId}
              onAbandonStage={abandon}
              runId={runId}
              showHint={!showWorkspace}
            />
          </div>
        ) : (
          <div style={{ padding: "var(--spacing-4)" }}>
            <p>No stages have started yet.</p>
          </div>
        )}

        {showWorkspace && run && workspace ? (
          <div className="work">
            <div
              className={`work-split${splitDragging ? " is-dragging" : ""}`}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize workspace"
              aria-valuemin={splitMin}
              aria-valuemax={splitMax}
              aria-valuenow={Math.round(workHeight)}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button != null && event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setSplitDragging(true);
                splitGestureRef.current = {
                  id: event.pointerId,
                  y: event.clientY,
                  h: workHeight,
                };
              }}
              onPointerMove={(event) => {
                const gesture = splitGestureRef.current;
                if (!gesture || gesture.id !== event.pointerId) return;
                applyWorkHeight(gesture.h + (gesture.y - event.clientY));
              }}
              onPointerUp={(event) => {
                if (splitGestureRef.current?.id !== event.pointerId) return;
                splitGestureRef.current = null;
                setSplitDragging(false);
              }}
              onPointerCancel={(event) => {
                if (splitGestureRef.current?.id !== event.pointerId) return;
                splitGestureRef.current = null;
                setSplitDragging(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  applyWorkHeight(workHeight + WORK_ARROW_STEP);
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  applyWorkHeight(workHeight - WORK_ARROW_STEP);
                }
                if (event.key === "Home") {
                  event.preventDefault();
                  applyWorkHeight(splitMax);
                }
                if (event.key === "End") {
                  event.preventDefault();
                  applyWorkHeight(splitMin);
                }
              }}
            >
              <span className="work-split__grip" aria-hidden="true"></span>
            </div>
            <div className="work-row">
              <div className="aside" style={{ width: 240, flexShrink: 0, overflow: "auto" }}>
                <ArtifactAside
                  files={workspace.artifactFiles}
                  selectedPath={selectedPath}
                  onSelect={(path) => {
                    const envelopeStageId = parseEnvelopeAsidePath(path);
                    if (envelopeStageId) {
                      setUserPickedStageId(envelopeStageId);
                      onOpenEnvelope(envelopeStageId);
                      return;
                    }
                    onOpenArtifact(path);
                  }}
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

              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {center}
              </div>

              {workspace.showDecide && workspace.decidePrompt && stage ? (
                <div className="decide" style={{ width: 320, flexShrink: 0 }}>
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
        ) : null}
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
