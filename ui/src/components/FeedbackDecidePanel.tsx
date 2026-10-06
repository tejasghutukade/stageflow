import { useState } from "react";
import type { FeedbackLoopDecisionKind } from "../api";
import { useFeedbackLoopDecision } from "../stageAction/useFeedbackLoopDecision";
import { waitingOnYouTitle } from "../status/runStatus";
import type { FeedbackDecideState } from "../workspace/resolveRunWorkspace";

export type FeedbackDecidePanelProps = {
  runId: string;
  decide: FeedbackDecideState;
  onSuccess: () => void | Promise<void>;
};

export function FeedbackDecidePanel({
  runId,
  decide: decideState,
  onSuccess,
}: FeedbackDecidePanelProps) {
  const [reason, setReason] = useState("");
  const { submitting, error, decide } = useFeedbackLoopDecision(runId, onSuccess);
  const locked = submitting;

  const budget =
    decideState.replayNumber !== undefined && decideState.maxReplays !== undefined
      ? `Replay ${decideState.replayNumber} of ${decideState.maxReplays}`
      : decideState.maxReplays !== undefined
        ? `Max ${decideState.maxReplays} replays`
        : null;

  function onDecision(decision: FeedbackLoopDecisionKind) {
    const trimmed = reason.trim();
    decide(decideState.sourceStageId, {
      decision,
      loopId: decideState.loopId,
      ...(trimmed ? { reason: trimmed } : {}),
    });
  }

  return (
    <div className="decide feedback-decide" style={{ height: "100%" }}>
      <div className="decide__gate">
        <div className="decide__label">
          <span className="dot dot--waiting"></span>
          {waitingOnYouTitle()} · feedback_loop_decision
        </div>
        <p className="decide__q">
          {decideState.summary ??
            "Feedback loop limit reached — extend, continue, or abandon"}
        </p>
        <div className="decide__refs">
          <span>
            Source <strong>{decideState.sourceStageId}</strong>
          </span>
          {decideState.deferredTarget ? (
            <span>
              Target <strong>{decideState.deferredTarget}</strong>
            </span>
          ) : null}
          {budget ? <span>{budget}</span> : null}
        </div>

        {error ? (
          <div
            className="gate"
            style={{
              padding: "var(--spacing-3)",
              marginBottom: "var(--spacing-3)",
              borderColor: "var(--color-border-red)",
              borderLeftColor: "var(--color-error)",
              background: "var(--color-background-red)",
              color: "var(--color-text-red)",
            }}
          >
            <p style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>
              Could not submit decision: {error}
            </p>
          </div>
        ) : null}

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={locked}
          placeholder="Optional reason"
          rows={3}
        ></textarea>
        <div className="decide__buttons">
          <button
            className="btn btn--accept"
            disabled={locked}
            onClick={() => onDecision("extend")}
          >
            {submitting ? "Submitting…" : "Extend"}
          </button>
          <button
            className="btn btn--primary"
            disabled={locked}
            onClick={() => onDecision("continue")}
          >
            Continue
          </button>
          <button
            className="btn btn--reject"
            disabled={locked}
            onClick={() => onDecision("abandon")}
          >
            Abandon
          </button>
        </div>
        <p className="decide__hint">
          Extend raises the replay budget and continues the deferred send-back.
          Continue accepts the limit and advances. Abandon stops the loop.
        </p>
      </div>
    </div>
  );
}
