import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rerun } from "../api";
import { useRunCatalog, useRunCatalogHandle } from "../catalog/useRunCatalog";
import {
  bucketViews,
  brokenView,
  finishedView,
  inboxWaitingView,
  inFlightView,
} from "../catalog/views";
import { AgentApprovalFocusPane } from "../redesign/inbox/AgentApprovalFocusPane";
import { mergeNeedsQueue, type AgentApprovalItem } from "../redesign/inbox/needsQueue";
import { DoneFocusPane } from "../redesign/inbox/DoneFocusPane";
import { FailedFocusPane } from "../redesign/inbox/FailedFocusPane";
import {
  GateFocusPane,
  type GateFocusHotkeys,
} from "../redesign/inbox/GateFocusPane";
import { InboxQueue, type InboxTab } from "../redesign/inbox/InboxQueue";
import { InboxZero } from "../redesign/inbox/InboxZero";
import {
  dismissFailedRun,
  filterDismissedFailed,
} from "../redesign/inbox/inboxDismiss";
import {
  flattenFailedQueue,
  partitionFailedRuns,
  sortFailedRuns,
  type FailedSortOrder,
} from "../redesign/inbox/failedViews";
import {
  parseInboxTabFromHash,
  replaceInboxTabInHash,
} from "../redesign/inbox/inboxTab";
import { nextGateIndex } from "../redesign/inbox/inboxViews";
import { useHotkeys } from "../redesign/keys";
import { useStageRetry } from "../stageAction";

const START_FRESH_CONFIRM =
  "Start a new run from the beginning? The failed run stays in history.";

export function InboxPage({
  onOpen,
  onNew,
  onOpenRuns,
  agentApprovals = [],
  onAgentApprovalDecided,
  onOpenAgentSession,
}: {
  onOpen: (runId: string) => void;
  onNew: () => void;
  onOpenRuns?: () => void;
  agentApprovals?: AgentApprovalItem[];
  onAgentApprovalDecided?: () => void;
  onOpenAgentSession?: (agentId: string, sessionId: string) => void;
}) {
  const catalog = useRunCatalogHandle();
  const { snapshot, error, loading } = useRunCatalog();
  const [tab, setTab] = useState<InboxTab>(() => parseInboxTabFromHash());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gateHotkeys, setGateHotkeys] = useState<GateFocusHotkeys | null>(null);
  const [failedSortOrder, setFailedSortOrder] = useState<FailedSortOrder>("newest");
  const [dismissRevision, setDismissRevision] = useState(0);
  const [rerunning, setRerunning] = useState(false);
  const selectionIndexRef = useRef(0);

  useEffect(() => {
    const syncTab = () => setTab(parseInboxTabFromHash());
    window.addEventListener("hashchange", syncTab);
    return () => window.removeEventListener("hashchange", syncTab);
  }, []);

  const onTabChange = useCallback((next: InboxTab) => {
    replaceInboxTabInHash(next);
    setTab(next);
  }, []);

  const waiting = useMemo(() => inboxWaitingView(snapshot), [snapshot]);
  const needs = useMemo(() => mergeNeedsQueue(waiting, agentApprovals), [waiting, agentApprovals]);
  const brokenRaw = useMemo(() => brokenView(snapshot), [snapshot]);
  const broken = useMemo(
    () => filterDismissedFailed(brokenRaw),
    [brokenRaw, dismissRevision],
  );
  const finished = useMemo(() => finishedView(snapshot), [snapshot]);
  const inFlight = useMemo(() => inFlightView(snapshot), [snapshot]);
  const alsoFailed = useMemo(() => bucketViews(snapshot).broken, [snapshot]);

  const failedQueue = useMemo(() => {
    const sorted = sortFailedRuns(broken, failedSortOrder);
    return flattenFailedQueue(partitionFailedRuns(sorted));
  }, [broken, failedSortOrder]);

  const activeKeys = useMemo(
    () =>
      tab === "needs"
        ? needs.map((item) => item.key)
        : (tab === "failed" ? failedQueue : finished).map((r) => r.run_id),
    [tab, needs, failedQueue, finished],
  );

  const selectedRun = useMemo(() => {
    if (!selectedId) return null;
    const runs = tab === "needs" ? waiting : tab === "failed" ? failedQueue : finished;
    return runs.find((r) => r.run_id === selectedId) ?? null;
  }, [tab, waiting, failedQueue, finished, selectedId]);

  const selectedApproval = useMemo(() => {
    if (tab !== "needs" || !selectedId) return null;
    const item = needs.find((entry) => entry.key === selectedId);
    return item?.kind === "agent" ? item.approval : null;
  }, [tab, needs, selectedId]);

  const selectedIndex = selectedId ? activeKeys.indexOf(selectedId) : -1;

  useEffect(() => {
    if (selectedIndex >= 0) selectionIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    if (activeKeys.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !activeKeys.includes(selectedId)) {
      const idx = Math.min(
        Math.max(selectionIndexRef.current, 0),
        activeKeys.length - 1,
      );
      setSelectedId(activeKeys[idx]);
    }
  }, [activeKeys, selectedId, tab]);

  const retryRunId =
    tab === "failed" && selectedRun?.failed_stage_id ? selectedRun.run_id : "";

  const { retry, retryingStageIds, error: retryError } = useStageRetry(
    retryRunId,
    () => void catalog.refresh(),
  );

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (activeKeys.length === 0) return;
      const current = selectedIndex >= 0 ? selectedIndex : 0;
      const next = nextGateIndex(current, activeKeys.length, delta);
      setSelectedId(activeKeys[next]);
    },
    [activeKeys, selectedIndex],
  );

  const onDismissFailed = useCallback(() => {
    if (!selectedRun) return;
    dismissFailedRun(selectedRun.run_id);
    setDismissRevision((n) => n + 1);
    setSelectedId(null);
  }, [selectedRun]);

  const onStartFresh = useCallback(() => {
    if (!selectedRun) return;
    if (!window.confirm(START_FRESH_CONFIRM)) return;
    setRerunning(true);
    void rerun(selectedRun.run_id)
      .then(({ runId }) => {
        onOpen(runId);
      })
      .finally(() => {
        setRerunning(false);
      });
  }, [selectedRun, onOpen]);

  const openRuns = onOpenRuns ?? (() => {});

  useHotkeys(
    [
      {
        key: "j",
        scope: "inbox",
        when: () => activeKeys.length > 0 && tab !== "needs",
        handler: (e) => {
          e.preventDefault();
          moveSelection(1);
        },
      },
      {
        key: "k",
        scope: "inbox",
        when: () => activeKeys.length > 0 && tab !== "needs",
        handler: (e) => {
          e.preventDefault();
          moveSelection(-1);
        },
      },
      {
        key: "j",
        scope: "inbox",
        when: () => tab === "needs" && needs.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(1);
        },
      },
      {
        key: "k",
        scope: "inbox",
        when: () => tab === "needs" && needs.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(-1);
        },
      },
      {
        key: "o",
        scope: "inbox",
        when: () => Boolean(selectedRun) && tab !== "needs",
        handler: (e) => {
          e.preventDefault();
          if (selectedRun) onOpen(selectedRun.run_id);
        },
      },
      {
        key: "r",
        scope: "inbox",
        when: () =>
          tab === "failed" &&
          Boolean(selectedRun?.failed_stage_id) &&
          !retryingStageIds.has(selectedRun!.failed_stage_id!),
        handler: (e) => {
          e.preventDefault();
          const stageId = selectedRun?.failed_stage_id;
          if (stageId) void retry(stageId);
        },
      },
      {
        key: "g",
        scope: "inbox",
        when: () => tab === "needs" && needs.length === 0 && !loading,
        handler: (e) => {
          e.preventDefault();
          openRuns();
        },
      },
    ],
    "inbox",
  );

  useHotkeys(
    [
      {
        key: "1",
        scope: "inbox-gate",
        when: () => Boolean(gateHotkeys && !gateHotkeys.locked),
        handler: (e) => {
          e.preventDefault();
          gateHotkeys?.accept();
        },
      },
      {
        key: "3",
        scope: "inbox-gate",
        when: () =>
          Boolean(gateHotkeys && !gateHotkeys.locked && gateHotkeys.canReject),
        handler: (e) => {
          e.preventDefault();
          gateHotkeys?.reject();
        },
      },
      {
        key: "n",
        scope: "inbox-gate",
        handler: (e) => {
          e.preventDefault();
          gateHotkeys?.focusNote();
        },
      },
      {
        key: "o",
        scope: "inbox-gate",
        when: () => Boolean(selectedRun || selectedApproval),
        handler: (e) => {
          e.preventDefault();
          if (selectedRun) onOpen(selectedRun.run_id);
          else if (selectedApproval) onOpenAgentSession?.(selectedApproval.agentId, selectedApproval.sessionId);
        },
      },
    ],
    "inbox-gate",
  );

  const showZero = tab === "needs" && needs.length === 0 && !loading;

  const retrying =
    Boolean(selectedRun?.failed_stage_id) &&
    retryingStageIds.has(selectedRun!.failed_stage_id!);

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-[var(--sf-ground)]">
      {error ? (
        <div
          className="absolute inset-x-0 top-0 z-10 bg-[var(--sf-fail)] px-4 py-2 text-sm text-white"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {retryError ? (
        <div
          className="absolute inset-x-0 top-0 z-10 bg-[var(--sf-fail)] px-4 py-2 text-sm text-white"
          role="alert"
        >
          {retryError}
        </div>
      ) : null}
      {showZero ? (
        <InboxZero
          tab={tab}
          onTabChange={onTabChange}
          waitingCount={needs.length}
          brokenCount={broken.length}
          doneCount={finished.length}
          inFlight={inFlight}
          onStartRun={onNew}
          onOpenRuns={openRuns}
          onOpenRun={onOpen}
          onGoToDoneToday={() => onTabChange("done_today")}
        />
      ) : (
        <>
          <InboxQueue
            tab={tab}
            onTabChange={onTabChange}
            needs={needs}
            broken={broken}
            finished={finished}
            alsoRunning={inFlight}
            alsoFailed={alsoFailed}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAlsoHappeningOpen={onOpen}
            failedSortOrder={failedSortOrder}
            onFailedSortToggle={() =>
              setFailedSortOrder((o) => (o === "newest" ? "oldest" : "newest"))
            }
            loading={loading}
          />
          {tab === "needs" && selectedApproval ? (
            <AgentApprovalFocusPane
              approval={selectedApproval}
              index={selectedIndex >= 0 ? selectedIndex : 0}
              total={needs.length}
              onDecided={() => {
                selectionIndexRef.current = selectedIndex >= 0 ? selectedIndex : 0;
                onAgentApprovalDecided?.();
              }}
              onOpenSession={(agentId, sessionId) => onOpenAgentSession?.(agentId, sessionId)}
              onRegisterHotkeys={setGateHotkeys}
            />
          ) : null}
          {tab === "needs" && !selectedApproval ? (
            <GateFocusPane
              run={selectedRun}
              index={selectedIndex >= 0 ? selectedIndex : 0}
              total={needs.length}
              onOpenRun={onOpen}
              onRegisterHotkeys={setGateHotkeys}
              onAnswered={() => {
                selectionIndexRef.current = selectedIndex >= 0 ? selectedIndex : 0;
              }}
            />
          ) : null}
          {tab === "failed" ? (
            <FailedFocusPane
              run={selectedRun}
              onOpenRun={onOpen}
              onRetry={(stageId) => void retry(stageId)}
              onStartFresh={onStartFresh}
              onDismiss={onDismissFailed}
              retrying={retrying}
              rerunning={rerunning}
            />
          ) : null}
          {tab === "done_today" ? <DoneFocusPane run={selectedRun} /> : null}
        </>
      )}
    </div>
  );
}
