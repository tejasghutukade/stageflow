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
import { EnvelopeDrawer } from "../../components/EnvelopeDrawer";
import { FeedbackDecidePanel } from "../../components/FeedbackDecidePanel";
import { VerificationHistory } from "../../components/VerificationHistory";
import type { DetailView } from "../../routes";
import { useRunCancel, useRunDelete } from "../../runLifecycle/useRunLifecycle";
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
} from "../../workspace/resolveRunWorkspace";
import { resolveStreamRoute } from "../../workspace/resolveStreamRoute";
import {
  RunDetailCenterTabs,
  type RunDetailCenterTab,
} from "../../redesign/runs/RunDetailCenterTabs";
import { RunArtifactsPanel } from "../../redesign/runs/RunArtifactsPanel";
import { RunDetailGateSection } from "../../redesign/runs/RunDetailGateSection";
import { RunEnvelopePanel } from "../../redesign/runs/RunEnvelopePanel";
import { RunEventsPanel } from "../../redesign/runs/RunEventsPanel";
import {
  RunDetailHeader,
  type RunDetailViewMode,
} from "../../redesign/runs/RunDetailHeader";
import { RunDetailLoadingShell } from "../../redesign/runs/RunDetailLoadingShell";
import { RunStageInspector } from "../../redesign/runs/RunStageInspector";
import { RunDetailGraphBand } from "../../redesign/runs/RunDetailGraphBand";
import { RunDetailListBand } from "../../redesign/runs/RunDetailListBand";
import { RunTimelineGantt } from "../../redesign/runs/RunTimelineGantt";
import { RunDetailTranscriptBody } from "../../redesign/runs/RunDetailTranscriptBody";
import { RunDetailTranscriptTurns } from "../../redesign/runs/RunDetailTranscriptTurns";
import { buildRunTrackView } from "../../runs/buildRunTrackView";
import { RunDetailWorkSplit } from "./RunDetailWorkSplit";
import { useRunDetailWorkSplit } from "./runDetailWorkSplit";

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
  const [centerTab, setCenterTab] = useState<RunDetailCenterTab>("transcript");
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
  const paneRef = useRef<HTMLDivElement>(null);
  const {
    workHeight,
    splitDragging,
    setSplitDragging,
    splitGestureRef,
    applyWorkHeight,
    splitMin,
    splitMax,
  } = useRunDetailWorkSplit(paneRef);
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

  useEffect(() => {
    if (!workspace) return;
    if (workspace.kind === "artifact" && workspace.selectedPath) {
      setCenterTab("artifacts");
    } else if (workspace.kind === "envelope") {
      setCenterTab("envelope");
    }
  }, [workspace?.kind, workspace?.selectedPath]);

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
  const artifactInitialPath =
    workspace?.kind === "artifact" ? workspace.selectedPath : null;
  const hasGraphBand =
    workspace.trackStages.length > 0 || (run.pipeline_track?.nodes?.length ?? 0) > 0;

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
  } else if (viewMode === "graph" && hasGraphBand) {
    mainView = (
      <RunDetailGraphBand
        run={run}
        trackStages={workspace.trackStages}
        spatialLayout={workspace.spatialLayout}
        selectedStageId={workspace.selectedStageId}
        onSelectStage={selectStage}
      />
    );
  } else if (viewMode === "list") {
    const trackView = buildRunTrackView(run, workspace.trackStages, workspace.selectedStageId);
    mainView = (
      <RunDetailListBand
        detailListRows={trackView.detailListRows}
        listHeader={trackView.listHeader}
        selectedStageId={workspace.selectedStageId}
        onSelect={selectStage}
        retryingStageIds={retryingStageIds}
        onRetryStage={retryAndSelect}
        abandoningStageId={abandoningStageId}
        onAbandonStage={abandon}
      />
    );
  } else {
    mainView = (
      <p className="px-6 py-3 text-[13px] text-[var(--sf-text-2)]">
        No stages have started yet.
      </p>
    );
  }

  let center;
  if (workspace.selectedStageId && stage) {
    const streamStageLabel =
      workspace.trackStages.find((s) => s.id === stage.stage_id)?.label ??
      stage.stage_id;
    center = (
      <div className="flex min-h-0 flex-1 flex-col">
        <RunDetailCenterTabs
          tab={centerTab}
          onTabChange={setCenterTab}
          stage={stage}
          stageLabel={streamStageLabel}
          eventCount={stage.events.length}
          artifactCount={stage.artifacts?.length ?? 0}
        />
        {centerTab === "transcript" ? (
          <RunDetailTranscriptBody
            autoScroll={workspace.liveStream}
            scrollKey={stage.events.length}
          >
            <RunDetailTranscriptTurns
              events={stage.events}
              inboundEnvelope={workspace.inboundEnvelope}
            />
            <RunDetailGateSection
              run={run}
              stage={stage}
              health={health}
              onAnswered={() => void onStageActionSuccess()}
            />
            <VerificationHistory
              history={verification}
              error={verificationError}
              recovering={manualRecoveryBusy}
              onRecover={(guidance) => void recoverStage(stage.stage_id, guidance)}
              onStop={() => void stopStageRecovery(stage.stage_id)}
            />
          </RunDetailTranscriptBody>
        ) : null}
        {centerTab === "events" ? (
          <RunEventsPanel
            events={stage.events}
            stageId={stage.stage_id}
            live={workspace.liveStream}
          />
        ) : null}
        {centerTab === "envelope" ? (
          <RunEnvelopePanel
            run={run}
            stage={stage}
            envelope={workspace.inboundEnvelope}
            fromStageId={workspace.inboundFromStageId}
            onArtifactClick={(path) => {
              setCenterTab("artifacts");
              onOpenArtifact(path);
            }}
          />
        ) : null}
        {centerTab === "artifacts" ? (
          <RunArtifactsPanel
            runId={runId}
            run={run}
            stage={stage}
            initialPath={artifactInitialPath}
            readOnly={workspace.artifactReadOnly}
          />
        ) : null}
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
      <div
        ref={paneRef}
        className={`pane flex min-h-0 flex-1 flex-col overflow-hidden${
          splitDragging ? " is-resizing" : ""
        }`}
      >
        <div
          className={`flex min-h-0 flex-1 flex-col overflow-hidden${
            viewMode === "list" || viewMode === "timeline" || viewMode === "graph" ?
              ""
            : " border-b border-b-[#ffffff12] pt-3 pb-2"
          }`}
        >
          {mainView}
        </div>
        <RunDetailWorkSplit
          workHeight={workHeight}
          splitMin={splitMin}
          splitMax={splitMax}
          splitDragging={splitDragging}
          setSplitDragging={setSplitDragging}
          splitGestureRef={splitGestureRef}
          applyWorkHeight={applyWorkHeight}
        />
        <div
          className="flex min-h-0 w-full shrink-0 overflow-hidden"
          style={{ height: workHeight }}
        >
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
            onOpenArtifact={(path) => {
              setCenterTab("artifacts");
              onOpenArtifact(path);
            }}
            onOpenEnvelope={onOpenEnvelope}
            artifactPath={stage?.artifacts?.[0] ?? null}
          />
        </div>
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
