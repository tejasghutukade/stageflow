import { useCallback, useEffect, useMemo, useState } from "react";
import { useRunCatalog } from "../catalog/useRunCatalog";
import {
  bucketViews,
  brokenView,
  finishedView,
  inboxWaitingView,
  inFlightView,
} from "../catalog/views";
import { GateFocusPane, type GateFocusHotkeys } from "../redesign/inbox/GateFocusPane";
import { InboxQueue, type InboxTab } from "../redesign/inbox/InboxQueue";
import { InboxZero } from "../redesign/inbox/InboxZero";
import { nextGateIndex } from "../redesign/inbox/inboxViews";
import { useHotkeys } from "../redesign/keys";

export function InboxPage({
  onOpen,
  onNew,
  onOpenRuns,
}: {
  onOpen: (runId: string) => void;
  onNew: () => void;
  onOpenRuns?: () => void;
}) {
  const { snapshot, error, loading } = useRunCatalog();
  const [tab, setTab] = useState<InboxTab>("needs");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gateHotkeys, setGateHotkeys] = useState<GateFocusHotkeys | null>(null);

  const waiting = useMemo(() => inboxWaitingView(snapshot), [snapshot]);
  const broken = useMemo(() => brokenView(snapshot), [snapshot]);
  const finished = useMemo(() => finishedView(snapshot), [snapshot]);
  const inFlight = useMemo(() => inFlightView(snapshot), [snapshot]);
  const alsoFailed = useMemo(() => bucketViews(snapshot).broken, [snapshot]);

  const selectedRun =
    waiting.find((r) => r.run_id === selectedId) ??
    broken.find((r) => r.run_id === selectedId) ??
    finished.find((r) => r.run_id === selectedId) ??
    null;

  const selectedIndex = selectedRun
    ? waiting.findIndex((r) => r.run_id === selectedRun.run_id)
    : -1;

  useEffect(() => {
    if (tab !== "needs") return;
    if (waiting.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !waiting.some((r) => r.run_id === selectedId)) {
      setSelectedId(waiting[0].run_id);
    }
  }, [waiting, selectedId, tab]);

  const moveSelection = useCallback(
    (delta: 1 | -1) => {
      if (tab !== "needs" || waiting.length === 0) return;
      const current = selectedIndex >= 0 ? selectedIndex : 0;
      const next = nextGateIndex(current, waiting.length, delta);
      setSelectedId(waiting[next].run_id);
    },
    [tab, waiting, selectedIndex],
  );

  useHotkeys(
    [
      {
        key: "j",
        scope: "inbox",
        when: () => tab === "needs" && waiting.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(1);
        },
      },
      {
        key: "k",
        scope: "inbox",
        when: () => tab === "needs" && waiting.length > 0,
        handler: (e) => {
          e.preventDefault();
          moveSelection(-1);
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
        when: () => Boolean(selectedRun),
        handler: (e) => {
          e.preventDefault();
          if (selectedRun) onOpen(selectedRun.run_id);
        },
      },
    ],
    "inbox-gate",
  );

  const showZero = tab === "needs" && waiting.length === 0 && !loading;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-[var(--sf-ground)]">
      {error ? (
        <div className="absolute inset-x-0 top-0 z-10 bg-[var(--sf-fail)] px-4 py-2 text-sm text-white" role="alert">
          {error}
        </div>
      ) : null}
      {showZero ? (
        <InboxZero
          tab={tab}
          onTabChange={setTab}
          waitingCount={waiting.length}
          brokenCount={broken.length}
          doneCount={finished.length}
          inFlight={inFlight}
          recentlyAnswered={finished}
          onStartRun={onNew}
          onOpenRuns={onOpenRuns ?? (() => {})}
          onOpenRun={onOpen}
        />
      ) : (
        <>
          <InboxQueue
            tab={tab}
            onTabChange={setTab}
            waiting={waiting}
            broken={broken}
            finished={finished}
            alsoRunning={inFlight}
            alsoFailed={alsoFailed}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={loading}
          />
          <GateFocusPane
            run={tab === "needs" ? selectedRun : null}
            index={selectedIndex >= 0 ? selectedIndex : 0}
            total={waiting.length}
            onOpenRun={onOpen}
            onRegisterHotkeys={setGateHotkeys}
          />
        </>
      )}
    </div>
  );
}
