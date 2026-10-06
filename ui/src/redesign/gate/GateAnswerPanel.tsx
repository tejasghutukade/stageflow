import { useCallback, useEffect, useState } from "react";
import type { PendingPrompt, RunSummary } from "../../api";
import { fetchRunArtifact } from "../../api";
import {
  emptyMultiDraft,
  isAcceptEligible,
  type MultiDraft,
} from "../../stageAnswer/answerRules";
import { useOperatorAnswer } from "../../stageAnswer/useOperatorAnswer";
import {
  buildAcceptIntent,
  buildRejectIntent,
} from "./gateAnswerIntents";

export type GateAnswerPanelProps = {
  run: RunSummary;
  stageId: string;
  pendingPrompt: PendingPrompt | null;
  showOpenRunOnly?: boolean;
  onOpenRun?: () => void;
  onAnswered?: () => void;
  note: string;
  rationale?: string | null;
  onRegisterActions?: (actions: GateAnswerActions | null) => void;
};

export type GateAnswerActions = {
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  locked: boolean;
  canReject: boolean;
};

export function GateAnswerPanel({
  run,
  stageId,
  pendingPrompt,
  showOpenRunOnly,
  onOpenRun,
  onAnswered,
  note,
  rationale,
  onRegisterActions,
}: GateAnswerPanelProps) {
  const pending =
    pendingPrompt && !showOpenRunOnly
      ? { promptId: pendingPrompt.id, kind: pendingPrompt.kind }
      : null;
  const { locked, error, submitIntent } = useOperatorAnswer(
    run.run_id,
    stageId,
    pending,
  );

  const [freeText, setFreeText] = useState("");
  const [multiDraft, setMultiDraft] = useState<MultiDraft>(() =>
    pendingPrompt?.kind === "multi_question"
      ? emptyMultiDraft(pendingPrompt.questions)
      : emptyMultiDraft([]),
  );
  const [artifactPreview, setArtifactPreview] = useState<string | null>(null);

  useEffect(() => {
    setFreeText("");
    setMultiDraft(
      pendingPrompt?.kind === "multi_question"
        ? emptyMultiDraft(pendingPrompt.questions)
        : emptyMultiDraft([]),
    );
  }, [pendingPrompt?.id, pendingPrompt?.kind]);

  useEffect(() => {
    if (pendingPrompt?.kind !== "artifact_backed") {
      setArtifactPreview(null);
      return;
    }
    const path = pendingPrompt.artifacts[0] ?? run.waiting_artifacts?.[0];
    if (!path) {
      setArtifactPreview(null);
      return;
    }
    let cancelled = false;
    void fetchRunArtifact(run.run_id, path)
      .then((text) => {
        if (!cancelled) setArtifactPreview(text.slice(0, 1200));
      })
      .catch(() => {
        if (!cancelled) setArtifactPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [run.run_id, pendingPrompt, run.waiting_artifacts]);

  const canReject = pending ? isAcceptEligible(pending) : false;

  const accept = useCallback(async () => {
    if (!pending || !pendingPrompt) return;
    const intent = buildAcceptIntent(
      pending,
      pendingPrompt,
      freeText,
      multiDraft,
      note,
    );
    if (!intent) return;
    const ok = await submitIntent(
      intent,
      pendingPrompt.kind === "multi_question" ? pendingPrompt : undefined,
    );
    if (ok) onAnswered?.();
  }, [
    pending,
    pendingPrompt,
    freeText,
    multiDraft,
    note,
    submitIntent,
    onAnswered,
  ]);

  const reject = useCallback(async () => {
    if (!pending) return;
    const intent = buildRejectIntent(pending, note);
    if (!intent) return;
    const ok = await submitIntent(intent);
    if (ok) onAnswered?.();
  }, [pending, note, submitIntent, onAnswered]);

  useEffect(() => {
    if (!onRegisterActions) return;
    if (showOpenRunOnly || !pending) {
      onRegisterActions(null);
      return;
    }
    onRegisterActions({ accept, reject, locked, canReject });
  }, [
    onRegisterActions,
    showOpenRunOnly,
    pending,
    accept,
    reject,
    locked,
    canReject,
  ]);

  const inputClass =
    "w-full max-w-[680px] rounded-lg border border-[#ffffff1a] bg-[var(--sf-panel)] px-3 py-2 text-[13px] text-[var(--sf-text-1)] outline-none";

  if (showOpenRunOnly) {
    return (
      <div className="flex max-w-[680px] flex-col gap-3">
        <p className="text-sm text-[var(--sf-text-2)]">
          This gate needs a decision on the run stream.
        </p>
        <button
          type="button"
          className="flex h-8 w-fit items-center rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
          onClick={onOpenRun}
        >
          Open run to decide
        </button>
      </div>
    );
  }

  if (!pendingPrompt) {
    return (
      <p className="text-sm text-[var(--sf-text-3)]">Loading gate details…</p>
    );
  }

  const question =
    pendingPrompt.kind === "multi_question"
      ? run.waiting_summary ?? "Answer each question"
      : pendingPrompt.message;

  const askerLine = [
    stageId,
    pendingPrompt.kind.replace(/_/g, " "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="flex max-w-[680px] flex-col gap-2.5">
        <div className="text-xs font-medium uppercase tracking-[0.96px] text-[var(--sf-needs)]">
          {askerLine}
        </div>
        <div className="text-xl font-medium leading-[1.4] tracking-[-0.2px] text-[var(--sf-text-1)]">
          {question}
        </div>
      </div>
      {error ? (
        <p className="max-w-[680px] text-sm text-[var(--sf-fail)]">{error}</p>
      ) : null}
      {rationale ? (
        <div className="flex max-w-[680px] flex-col gap-2 border-l-2 border-l-[#ffffff1a] pl-3.5">
          <div className="text-xs text-[var(--sf-text-3)]">Why the agent is asking</div>
          <p className="text-sm leading-[1.55] text-[var(--sf-text-2)]">{rationale}</p>
        </div>
      ) : null}

      {pendingPrompt.kind === "free_text" ? (
        <textarea
          className={inputClass}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          rows={5}
          disabled={locked}
          placeholder="Your answer"
        />
      ) : null}

      {pendingPrompt.kind === "multi_question" ? (
        <div className="flex max-w-[680px] flex-col gap-4">
          {pendingPrompt.questions.map((q) =>
            q.kind === "free_text" ? (
              <label key={q.id} className="flex flex-col gap-2 text-sm text-[var(--sf-text-2)]">
                <span>{q.message}</span>
                <textarea
                  className={inputClass}
                  value={multiDraft.freeText[q.id] ?? ""}
                  onChange={(e) =>
                    setMultiDraft((prev) => ({
                      ...prev,
                      freeText: { ...prev.freeText, [q.id]: e.target.value },
                    }))
                  }
                  rows={3}
                  disabled={locked}
                />
              </label>
            ) : (
              <div key={q.id} className="flex flex-col gap-2">
                <p className="text-sm text-[var(--sf-text-2)]">{q.message}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`rounded-lg border px-3 py-1.5 text-[13px]${
                      multiDraft.confirm[q.id]?.decision === "accept"
                        ? " border-[#ffffff2e] bg-[var(--sf-raised)]"
                        : " border-[#ffffff1a] bg-transparent"
                    }`}
                    disabled={locked}
                    aria-pressed={multiDraft.confirm[q.id]?.decision === "accept"}
                    onClick={() =>
                      setMultiDraft((prev) => ({
                        ...prev,
                        confirm: {
                          ...prev.confirm,
                          [q.id]: {
                            decision: "accept",
                            text: prev.confirm[q.id]?.text ?? "",
                          },
                        },
                      }))
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={`rounded-lg border px-3 py-1.5 text-[13px]${
                      multiDraft.confirm[q.id]?.decision === "reject"
                        ? " border-[#ffffff2e] bg-[var(--sf-raised)]"
                        : " border-[#ffffff1a] bg-transparent"
                    }`}
                    disabled={locked}
                    aria-pressed={multiDraft.confirm[q.id]?.decision === "reject"}
                    onClick={() =>
                      setMultiDraft((prev) => ({
                        ...prev,
                        confirm: {
                          ...prev.confirm,
                          [q.id]: {
                            decision: "reject",
                            text: prev.confirm[q.id]?.text ?? "",
                          },
                        },
                      }))
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      ) : null}

      {pendingPrompt.kind === "artifact_backed" ? (
        <div className="flex max-w-[680px] flex-col gap-2.5">
          <div className="text-xs font-medium uppercase tracking-[0.96px] text-[var(--sf-text-3)]">
            Evidence
          </div>
          <div className="flex flex-wrap gap-2">
            {pendingPrompt.artifacts.map((path) => (
              <span
                key={path}
                className="rounded-md border border-[#ffffff12] bg-[var(--sf-panel)] px-2 py-0.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
              >
                {path}
              </span>
            ))}
          </div>
          {artifactPreview ? (
            <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-[#ffffff12] bg-[var(--sf-panel)] p-3 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
              {artifactPreview}
            </pre>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
