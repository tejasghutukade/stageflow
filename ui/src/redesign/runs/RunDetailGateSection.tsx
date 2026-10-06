import { useEffect, useRef, useState } from "react";
import type {
  CapacityHealth,
  PendingPrompt,
  RunDetail,
  RunSummary,
  StageSnapshot,
} from "../../api";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import { GateAnswerPanel, type GateAnswerActions } from "../gate/GateAnswerPanel";
import { GateDecisionBar } from "../inbox/GateDecisionBar";
import { useHotkeys } from "../keys";

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
    <section className="mx-3 mb-4 mt-2 rounded-xl border border-[#f5b54433] bg-[#f5b5440a]">
      <header className="flex flex-wrap items-center gap-2 border-b border-b-[#ffffff0f] px-4 py-3">
        <h3 className="text-[13px] font-semibold text-[var(--sf-text-1)]">
          {stageLabel} is asking you
        </h3>
        {run.waiting_kind ? (
          <span className="rounded-full border border-[#f5b5444d] bg-[#f5b5441f] px-2 py-0.5 text-[11px] font-medium text-[var(--sf-needs)]">
            {run.waiting_kind.replace(/_/g, " ")}
          </span>
        ) : null}
        {holdingSlot ? (
          <span className="ml-auto text-[11px] text-[var(--sf-text-3)]">
            Holding 1 agent slot
          </span>
        ) : null}
      </header>
      <div className="px-4 py-3">
        <GateAnswerPanel
          run={run as unknown as RunSummary}
          stageId={stage.stage_id}
          pendingPrompt={pendingPrompt}
          note={note}
          onAnswered={onAnswered}
          onRegisterActions={setPanelActions}
        />
      </div>
      <GateDecisionBar
        note={note}
        onNoteChange={setNote}
        noteRef={noteRef}
        onAccept={() => void panelActions?.accept()}
        onReject={() => void panelActions?.reject()}
        disabled={panelActions?.locked}
        canReject={panelActions?.canReject ?? false}
      />
    </section>
  );
}
