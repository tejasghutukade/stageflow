import { useEffect, useRef, useState } from "react";
import { fetchRun, type PendingPrompt, type RunDetail, type RunSummary } from "../../api";
import { GateAnswerPanel, type GateAnswerActions } from "../gate/GateAnswerPanel";
import { GateDecisionBar } from "./GateDecisionBar";
import { GateFocusHeader } from "./GateFocusHeader";
import { gateRationaleFromEvents } from "./inboxViews";

const detailCache = new Map<string, RunDetail>();

function cacheKey(runId: string, stageId: string): string {
  return `${runId}:${stageId}`;
}

export type GateFocusPaneProps = {
  run: RunSummary | null;
  index: number;
  total: number;
  onOpenRun: (runId: string) => void;
  onRegisterHotkeys?: (actions: GateFocusHotkeys | null) => void;
};

export type GateFocusHotkeys = {
  accept: () => void;
  reject: () => void;
  focusNote: () => void;
  openRun: () => void;
  locked: boolean;
  canReject: boolean;
};

export function GateFocusPane({
  run,
  index,
  total,
  onOpenRun,
  onRegisterHotkeys,
}: GateFocusPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelActions, setPanelActions] = useState<GateAnswerActions | null>(null);

  const stageId = run?.waiting_stage_id ?? "";
  const isFeedback = run?.waiting_kind === "feedback_loop_decision";

  useEffect(() => {
    setNote("");
    setPanelActions(null);
    if (!run || !stageId) {
      setDetail(null);
      return;
    }
    const key = cacheKey(run.run_id, stageId);
    const cached = detailCache.get(key);
    if (cached) {
      setDetail(cached);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchRun(run.run_id)
      .then((d) => {
        if (cancelled) return;
        detailCache.set(key, d);
        setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [run?.run_id, stageId]);

  useEffect(() => {
    if (!run) return;
    paneRef.current?.focus();
  }, [run?.run_id, stageId]);

  const stage = detail?.stages.find((s) => s.stage_id === stageId);
  const pendingPrompt: PendingPrompt | null = stage?.pending_prompt ?? null;
  const rationale = stage?.events
    ? gateRationaleFromEvents(stage.events)
    : null;

  useEffect(() => {
    if (!onRegisterHotkeys || !run) {
      onRegisterHotkeys?.(null);
      return;
    }
    const locked = panelActions?.locked ?? false;
    onRegisterHotkeys({
      accept: () => void panelActions?.accept(),
      reject: () => void panelActions?.reject(),
      focusNote: () => noteRef.current?.focus(),
      openRun: () => onOpenRun(run.run_id),
      locked,
      canReject: panelActions?.canReject ?? false,
    });
  }, [run, panelActions, onRegisterHotkeys, onOpenRun]);

  if (!run || !stageId) {
    return (
      <div className="min-h-0 min-w-0 flex-1 bg-[var(--sf-panel)]" aria-hidden="true" />
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip"
      ref={paneRef}
      tabIndex={-1}
    >
      <GateFocusHeader
        run={run}
        stageId={stageId}
        kindLabel={run.waiting_kind ?? undefined}
        index={index}
        total={total}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">
        {loading ? (
          <p className="text-sm text-[var(--sf-text-3)]">Loading run detail…</p>
        ) : null}
        <GateAnswerPanel
          run={run}
          stageId={stageId}
          pendingPrompt={pendingPrompt}
          showOpenRunOnly={isFeedback}
          onOpenRun={() => onOpenRun(run.run_id)}
          note={note}
          onRegisterActions={setPanelActions}
          rationale={rationale}
        />
      </div>
      {!isFeedback ? (
        <GateDecisionBar
          note={note}
          onNoteChange={setNote}
          noteRef={noteRef}
          onAccept={() => void panelActions?.accept()}
          onReject={() => void panelActions?.reject()}
          disabled={panelActions?.locked}
          canReject={panelActions?.canReject}
        />
      ) : null}
    </div>
  );
}
