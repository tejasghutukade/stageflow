import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../../api";
import { useRunCatalog, useRunCatalogHandle } from "../../catalog/useRunCatalog";
import { ArtifactReader } from "../../components/ArtifactReader";
import { EnvelopeDrawer } from "../../components/EnvelopeDrawer";
import { EnvelopeRecord } from "../../components/EnvelopeFields";
import { FeedbackDecidePanel } from "../../components/FeedbackDecidePanel";
import { FeedbackLoopPanel } from "../../components/FeedbackLoopPanel";
import { LogPanel } from "../../components/LogPanel";
import { RunTrack } from "../../components/RunTrack";
import { SpatialRunMap } from "../../components/SpatialRunMap";
import { TranscriptStream } from "../../components/TranscriptStream";
import { TranscriptTurns } from "../../components/TranscriptTurns";
import { VerificationHistory } from "../../components/VerificationHistory";
import type { DetailView } from "../../routes";
import { useRunCancel, useRunDelete } from "../../runLifecycle/useRunLifecycle";
import {
  abandonedDisplayCopy,
  cssStatusToken,
  isAbandonedDisplay,
  statusCopy,
} from "../../status/runStatus";
import {
  canAbandon,
  useStageAbandon,
  useStageResume,
  useStageRetry,
} from "../../stageAction";
import {
  activeWaitKey,
  resolveRunWorkspace,
  runDetailShouldPoll,
  stageCloneLabel,
} from "../../workspace/resolveRunWorkspace";
import { resolveStreamRoute } from "../../workspace/resolveStreamRoute";
import { RunDetailGateSection } from "../../redesign/runs/RunDetailGateSection";
import {
  RunDetailHeader,
  type RunDetailViewMode,
} from "../../redesign/runs/RunDetailHeader";
import { RunDetailLoadingShell } from "../../redesign/runs/RunDetailLoadingShell";
import { RunStageInspector } from "../../redesign/runs/RunStageInspector";
import { RunTimelineGantt } from "../../redesign/runs/RunTimelineGantt";
import { buildRunTrackView } from "../../runs/buildRunTrackView";

export function RunDetailPageRedesign({
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
  const { snapshot } = useRunCatalog();
  const health = snapshot.health;
  const catalog = useRunCatalogHandle();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [pipelines, setPipelines] = useState<PipelineListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<RunDetailViewMode>("timeline");
  const [centerTab, setCenterTab] = useState<"transcript" | "logs">("transcript");
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
  const [rerunning, setRerunning] = useState(false);
  const wasWaitingArtifact = useRef(false);
  const onOpenStreamRef = useRef(onOpenStream);
  onOpenStreamRef.current = onOpenStream;
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
    resumingStageIds,
    error: resumeError,
    resume,
    clearError: clearResumeError,
  } = useStageResume(runId, onStageActionSuccess);

  const resumeAndSelect = useCallback(
    (stageId: string) => {
      setUserPickedStageId(stageId);
      onOpenStream(stageId);
      resume(stageId);
    },
    [onOpenStream, resume],
  );

  const {
    abandoningStageId,
    error: abandonError,
    abandon,
    clearError: clearAbandonError,
  } = useStageAbandon(runId, onStageActionSuccess);

  const onDeleted = useCallback(async () => {
    catalog.refresh();
    onBack();
  }, [catalog, onBack]);

  const {
    cancelling,
    error: cancelError,
    cancel,
    clearError: clearCancelError,
  } = useRunCancel(runId, onStageActionSuccess);

  const {
    deleting,
    error: deleteError,
    deleteRun: removeRun,
    clearError: clearDeleteError,
  } = useRunDelete(runId, run?.status, onDeleted);

  const actionBusy = {
    retryingStageIds,
    abandoningStageId,
    resumingStageIds,
  };

  useEffect(() => {
    setUserPickedStageId(streamViewStageId ?? null);
    previousStageIdRef.current = null;
    setDrawerStageId(null);
    setDismissedWaitKey(null);
    setRun(null);
    setError(null);
    setVerification(null);
    setVerificationError(null);
    setManualRecoveryBusy(false);
    setManualRecoveryError(null);
    wasWaitingArtifact.current = false;
    setViewMode("timeline");
    setCenterTab("transcript");
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

  if (workspace) previousStageIdRef.current = workspace.selectedStageId;

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

  const stage = workspace?.selectedStage ?? null;
  const now = Date.now();
  const timelineStages = run?.stages ?? [];

  const selectStage = useCallback(
    (stageId: string) => {
      setUserPickedStageId(stageId);
      onOpenStream(stageId);
    },
    [onOpenStream],
  );

  const hideWorkspace = useCallback(() => {
    if (run) setDismissedWaitKey(activeWaitKey(run));
    setUserPickedStageId(null);
    previousStageIdRef.current = null;
    setDrawerStageId(null);
    onOpenStream();
  }, [onOpenStream, run]);

  async function onRerunClick() {
    setRerunning(true);
    setError(null);
    clearRetryError();
    clearAbandonError();
    clearResumeError();
    clearCancelError();
    clearDeleteError();
    try {
      const result = await rerun(runId);
      onReran(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  }

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

  const inboundSummary = workspace?.inboundEnvelope?.summary ?? null;
  const selectedPath = workspace?.selectedPath;
  const hasMapNodes = Boolean(workspace && workspace.spatialLayout.nodes.length > 0);

  const banner =
    retryError ??
    resumeError ??
    abandonError ??
    cancelError ??
    deleteError ??
    manualRecoveryError;

  if (error && !run) {
    return (
      <div className="flex min-h-full min-w-0 flex-1 flex-col px-6 py-4">
        <div className="banner banner--error">{error}</div>
      </div>
    );
  }

  if (!run || !workspace) {
    return <RunDetailLoadingShell runId={runId} onBack={onBack} />;
  }

  let mainView;
  if (viewMode === "timeline") {
    mainView = (
      <RunTimelineGantt
        run={run}
        stages={timelineStages}
        selectedStageId={workspace.selectedStageId}
        onSelectStage={selectStage}
        now={now}
      />
    );
  } else if (viewMode === "graph" && hasMapNodes) {
    mainView = (
      <div className="min-h-[200px] p-2">
        {(run.active_feedback_loop || (run.feedback_loops?.length ?? 0) > 0) ? (
          <FeedbackLoopPanel
            active={run.active_feedback_loop}
            history={run.feedback_loops ?? []}
          />
        ) : null}
        <SpatialRunMap
          layout={workspace.spatialLayout}
          stages={run.stages}
          nodeChrome={workspace.nodeChrome}
          selectedStageId={workspace.selectedStageId}
          onSelectStage={selectStage}
          onDeselect={hideWorkspace}
          retryingStageIds={retryingStageIds}
          onRetryStage={retryAndSelect}
          resumingStageIds={resumingStageIds}
          onResumeStage={resumeAndSelect}
          abandoningStageId={abandoningStageId}
          onAbandonStage={abandon}
          runId={runId}
          showHint={!workspace.selectedStageId}
          feedbackOverlays={workspace.feedbackOverlays}
        />
      </div>
    );
  } else if (viewMode === "list") {
    const trackView = buildRunTrackView(run, workspace.trackStages, workspace.selectedStageId);
    mainView = (
      <div className="px-3 py-2">
        <RunTrack
          trackLayout={trackView.trackLayout}
          detailListRows={trackView.detailListRows}
          selectedStageId={workspace.selectedStageId}
          onSelect={selectStage}
          retryingStageIds={retryingStageIds}
          onRetryStage={retryAndSelect}
          abandoningStageId={abandoningStageId}
          onAbandonStage={abandon}
        />
      </div>
    );
  } else {
    mainView = (
      <p className="px-6 py-3 text-[13px] text-[var(--sf-text-2)]">
        No stages have started yet.
      </p>
    );
  }

  let center;
  if (workspace.kind === "artifact" && selectedPath) {
    center = (
      <ArtifactReader
        runId={runId}
        path={selectedPath}
        readOnly={workspace.artifactReadOnly}
        onBackToTranscript={() => selectStage(workspace.selectedStageId ?? "")}
        onHide={hideWorkspace}
      />
    );
  } else if (workspace.kind === "envelope" && workspace.envelope) {
    center = workspace.envelope.envelope ? (
      <EnvelopeRecord
        fromStageId={workspace.envelope.fromStageId}
        toStageId={workspace.envelope.toStageId}
        envelope={workspace.envelope.envelope}
        onBackToTranscript={() =>
          selectStage(workspace.selectedStageId ?? "")
        }
        onHide={hideWorkspace}
        onArtifactClick={onOpenArtifact}
        stageLabel={(id) => stageCloneLabel(run, id)}
      />
    ) : (
      <p className="sf-run-detail__empty">No handoff envelope yet.</p>
    );
  } else if (workspace.selectedStageId && stage) {
    const stageToken = cssStatusToken(stage.status);
    const abandoned = isAbandonedDisplay(stage.events);
    center = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 gap-1.5 border-b border-b-[#ffffff12] px-3 py-2">
          <button
            type="button"
            className={`sf-btn sf-btn--sm${centerTab === "transcript" ? " sf-btn--selected" : ""}`}
            onClick={() => setCenterTab("transcript")}
          >
            Transcript
          </button>
          <button
            type="button"
            className={`sf-btn sf-btn--sm${centerTab === "logs" ? " sf-btn--selected" : ""}`}
            onClick={() => setCenterTab("logs")}
          >
            Logs
          </button>
        </div>
        {centerTab === "transcript" ? (
          <TranscriptStream
            stageName={
              workspace.trackStages.find((s) => s.id === stage.stage_id)?.label ??
              stage.stage_id
            }
            status={
              abandoned ? (
                <span className="status status--failed">
                  {abandonedDisplayCopy()}
                </span>
              ) : (
                <span className={`status${stageToken && stageToken !== "running" ? ` status--${stageToken}` : ""}`}>
                  {statusCopy(stage.status)}
                </span>
              )
            }
            trailing={null}
            autoScroll={workspace.liveStream}
            scrollKey={stage.events.length}
            composer={undefined}
          >
            <TranscriptTurns
              events={stage.events}
              inboundEnvelope={workspace.inboundEnvelope}
            />
            <RunDetailGateSection
              run={run}
              stage={stage}
              onAnswered={() => void onStageActionSuccess()}
            />
            <VerificationHistory
              history={verification}
              error={verificationError}
              recovering={manualRecoveryBusy}
              onRecover={(guidance) => void recoverStage(stage.stage_id, guidance)}
              onStop={() => void stopStageRecovery(stage.stage_id)}
            />
          </TranscriptStream>
        ) : (
          <LogPanel events={stage.events} headerAction={null} />
        )}
        {workspace.showFeedbackDecide && workspace.feedbackDecide ? (
          <FeedbackDecidePanel
            runId={runId}
            decide={workspace.feedbackDecide}
            onSuccess={onStageActionSuccess}
          />
        ) : null}
      </div>
    );
  } else {
    center = (
      <p className="px-6 py-4 text-[13px] text-[var(--sf-text-2)]">
        Select a stage to view the transcript.
      </p>
    );
  }

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <RunDetailHeader
        run={run}
        onBack={onBack}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        selectedStageStatus={stage?.status}
        onCancel={() => {
          clearCancelError();
          cancel();
        }}
        onDelete={() => {
          clearDeleteError();
          removeRun();
        }}
        onRerun={() => void onRerunClick()}
        onAbandonStage={
          stage && canAbandon(stage.status)
            ? () => abandon(stage.stage_id)
            : undefined
        }
        cancelling={cancelling}
        deleting={deleting}
        rerunning={rerunning}
        abandoning={abandoningStageId === stage?.stage_id}
        now={now}
      />
      {banner ? <div className="banner banner--error">{banner}</div> : null}
      <div className="flex w-full shrink-0 flex-col border-b border-b-[#ffffff12] pt-3 pb-2">
        {mainView}
      </div>
      <div className="flex min-h-0 w-full flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-r-[#ffffff12]">
          {center}
        </div>
        <RunStageInspector
          run={run}
          stage={stage}
          health={health}
          inboundSummary={inboundSummary}
          actionBusy={actionBusy}
          onRetry={retryAndSelect}
          onResume={resumeAndSelect}
          onAbandon={abandon}
          onOpenArtifact={onOpenArtifact}
          artifactPath={stage?.artifacts?.[0] ?? null}
        />
      </div>
      {workspace.drawer ? (
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
    </div>
  );
}
