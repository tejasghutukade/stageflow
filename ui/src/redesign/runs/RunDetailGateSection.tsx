import { useEffect, useRef, useState } from "react";
import { LuHand } from "react-icons/lu";
import type {
  CapacityHealth,
  PendingPrompt,
  RunDetail,
  RunSummary,
  StageSnapshot,
} from "../../api";
import { relativeTime } from "../../catalogJoin";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import { GateAnswerPanel, type GateAnswerActions } from "../gate/GateAnswerPanel";
import { GateDecisionBar } from "../inbox/GateDecisionBar";
import { useHotkeys } from "../keys";

function gatePromptAge(stage: StageSnapshot): string | undefined {
  for (let i = stage.events.length - 1; i >= 0; i -= 1) {
    const ev = stage.events[i];
    if (ev.event === "waiting_for_input" || ev.event === "operator_prompt") {
      if (ev.at) return relativeTime(ev.at);
    }
  }
  return undefined;
}

export function RunDetailGateSection({
  run,
  stage,
  health,
  onAnswered,
}: {
  run: RunDetail;
  stage: StageSnapshot;
  health: CapacityHealth | null;
  onAnswered?: () => void;
}) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [panelActions, setPanelActions] = useState<GateAnswerActions | null>(null);
  const pendingPrompt: PendingPrompt | null = stage.pending_prompt ?? null;
  const showGate =
    stage.status === "waiting_for_input" &&
    pendingPrompt &&
    run.waiting_kind !== "feedback_loop_decision";
  const holdingSlot = health?.activeRunIds?.includes(run.run_id) ?? false;
  const stageLabel = stageCloneLabel(run, stage.stage_id);
  const gateAge = gatePromptAge(stage);
  const kindChip = pendingPrompt?.kind?.replace(/_/g, " ") ?? "gate";

  useEffect(() => {
    setNote("");
    setPanelActions(null);
  }, [stage.stage_id, pendingPrompt?.id]);

  useHotkeys(
    [
      {
        key: "1",
        scope: "run-detail-gate",
        when: () => Boolean(showGate && panelActions && !panelActions.locked),
        handler: (e) => {
          e.preventDefault();
          void panelActions?.accept();
        },
      },
      {
        key: "3",
        scope: "run-detail-gate",
        when: () =>
          Boolean(
            showGate &&
              panelActions &&
              !panelActions.locked &&
              panelActions.canReject,
          ),
        handler: (e) => {
          e.preventDefault();
          void panelActions?.reject();
        },
      },
      {
        key: "n",
        scope: "run-detail-gate",
        when: () => Boolean(showGate),
        handler: (e) => {
          e.preventDefault();
          noteRef.current?.focus();
        },
      },
    ],
    "run-detail-gate",
  );

  if (!showGate) return null;

  return (
    <section className="flex flex-col rounded-xl border border-[#f5b54473] bg-[#f5b5440a] shadow-[0px_0px_0px_1px_rgba(245,181,68,0.08),0px_0px_24px_rgba(245,181,68,0.14)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-b-[#f5b5442e] px-3.5">
        <LuHand className="size-3.5 shrink-0 text-[#f5b544]" aria-hidden="true" />
        <h3 className="text-[13px] font-medium text-[#f5b544]">
          {stageLabel.trim().toLowerCase()} is asking you
        </h3>
        <span className="text-xs text-[#8b8f98]" aria-hidden="true">
          ·
        </span>
        <span className="rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-1.5 py-0 font-['Geist_Mono',monospace] text-[11px] text-[#a7aab2]">
          {kindChip}
        </span>
        {gateAge ? (
          <>
            <span className="text-xs text-[#8b8f98]" aria-hidden="true">
              ·
            </span>
            <span className="flex-1 font-['Geist_Mono',monospace] text-xs text-[#a7aab2]">
              {gateAge}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {holdingSlot ? (
          <span className="text-xs text-[#8b8f98]">holding 1 agent slot</span>
        ) : null}
      </header>
      <div className="flex flex-col gap-2.5 p-3.5">
        <GateAnswerPanel
          run={run as unknown as RunSummary}
          stageId={stage.stage_id}
          pendingPrompt={pendingPrompt}
          note={note}
          onAnswered={onAnswered}
          onRegisterActions={setPanelActions}
          presentation="run-detail-inline"
        />
        <GateDecisionBar
          layout="run-detail-inline"
          note={note}
          onNoteChange={setNote}
          noteRef={noteRef}
          onAccept={() => void panelActions?.accept()}
          onReject={() => void panelActions?.reject()}
          disabled={panelActions?.locked}
          canReject={panelActions?.canReject ?? false}
        />
      </div>
    </section>
  );
}
