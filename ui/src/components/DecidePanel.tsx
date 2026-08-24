import { useState } from "react";
import type { ReactNode } from "react";
import type {
  Decision,
  PendingPrompt,
  StageAnswer,
  StageEnvelopeView,
  StageLogEvent,
} from "../api";
import { useOperatorAnswer } from "../stageAnswer/useOperatorAnswer";
import { waitingOnYouTitle } from "../status/runStatus";

export type DecidePanelProps = {
  question: string;
  note: string;
  onNoteChange: (value: string) => void;
  onAccept: () => void;
  onReject: () => void;
  isSubmitting?: boolean;
  error?: string | null;
  refs?: ReactNode;
  children?: ReactNode;
};

export function DecidePanel({
  question,
  note,
  onNoteChange,
  onAccept,
  onReject,
  isSubmitting,
  error,
  refs,
  children,
}: DecidePanelProps) {
  const locked = !!isSubmitting;

  return (
    <div className="decide" style={{ height: "100%" }}>
      <div className="decide__gate">
        <div className="decide__label">
          <span className="dot dot--waiting"></span>
          {waitingOnYouTitle()} · artifact_backed
        </div>
        <p className="decide__q">{question}</p>

        {refs ? <div className="decide__refs">{refs}</div> : null}

        {error ? (
          <div className="gate" style={{ padding: "var(--spacing-3)", marginBottom: "var(--spacing-3)", borderColor: "var(--color-border-red)", borderLeftColor: "var(--color-error)", background: "var(--color-background-red)", color: "var(--color-text-red)" }}>
            <p style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>Could not submit answer: {error}</p>
          </div>
        ) : null}

        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          disabled={locked}
          placeholder="Optional review notes"
          rows={3}
        ></textarea>
        <div className="decide__buttons">
          <button
            className="btn btn--accept"
            disabled={locked}
            onClick={onAccept}
          >
            {isSubmitting ? "Submitting…" : "Accept"}
          </button>
          <button
            className="btn btn--reject"
            disabled={locked}
            onClick={onReject}
          >
            Reject
          </button>
        </div>
      </div>

      {children ? (
        <div className="decide__body">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function asPrompt(value: unknown): PendingPrompt | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: string }).kind;
  if (
    kind === "free_text" ||
    kind === "confirm" ||
    kind === "multi_question" ||
    kind === "artifact_backed"
  ) {
    return value as PendingPrompt;
  }
  return null;
}

function asAnswer(value: unknown): StageAnswer | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: string }).kind;
  if (
    kind === "free_text" ||
    kind === "confirm" ||
    kind === "multi_question" ||
    kind === "artifact_backed"
  ) {
    return value as StageAnswer;
  }
  return null;
}

export function artifactBackedIteration(events: StageLogEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.event !== "operator_prompt") continue;
    const prompt = asPrompt(ev.prompt);
    if (prompt?.kind === "artifact_backed") n += 1;
  }
  return Math.max(n, 1);
}

type HistoryRound = {
  key: string;
  label: string;
  at?: string;
  note?: string;
};

function reviewHistory(events: StageLogEvent[]): HistoryRound[] {
  const rounds: HistoryRound[] = [];
  events.forEach((ev, i) => {
    if (ev.event === "operator_prompt") {
      rounds.push({
        key: `ask-${ev.at ?? i}`,
        label: "Asked you",
        at: ev.at,
      });
      return;
    }
    if (ev.event !== "operator_answer") return;
    const answer = asAnswer(ev.answer);
    let verdict = "Answered";
    let note: string | undefined;
    if (answer?.kind === "artifact_backed" || answer?.kind === "confirm") {
      verdict = answer.decision === "reject" ? "Rejected" : "Accepted";
      note = answer.text;
    } else if (answer?.kind === "free_text") {
      note = answer.text;
    }
    rounds.push({
      key: `ans-${ev.at ?? i}`,
      label: verdict,
      at: ev.at,
      note,
    });
  });
  return rounds;
}

function relTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return d.toLocaleDateString();
  } catch { return ""; }
}

export function ArtifactDecideColumn({
  runId,
  stageId,
  prompt,
  events,
  inboundEnvelope,
  inboundFromStageId,
  inboundToStageId,
  selectedPath,
  onSelectArtifact,
  onOpenInboundEnvelope,
}: {
  runId: string;
  stageId: string;
  prompt: Extract<PendingPrompt, { kind: "artifact_backed" }>;
  events: StageLogEvent[];
  inboundEnvelope?: StageEnvelopeView | null;
  inboundFromStageId?: string;
  inboundToStageId?: string;
  selectedPath?: string;
  onSelectArtifact: (path: string) => void;
  onOpenInboundEnvelope?: () => void;
}) {
  const [note, setNote] = useState("");
  const { submitting, error, locked, submitIntent } = useOperatorAnswer(
    runId,
    stageId,
    { promptId: prompt.id, kind: prompt.kind },
  );
  const iteration = artifactBackedIteration(events);
  const history = reviewHistory(events);

  async function onDecision(decision: Decision) {
    await submitIntent({ type: "decision", decision, note });
  }

  const inboundLabel =
    inboundFromStageId && inboundToStageId
      ? `${inboundFromStageId} → ${inboundToStageId}`
      : inboundFromStageId ?? "previous stage";

  return (
    <DecidePanel
      question={prompt.message}
      note={note}
      onNoteChange={setNote}
      onAccept={() => void onDecision("accept")}
      onReject={() => void onDecision("reject")}
      isSubmitting={submitting || locked}
      error={error}
      refs={
        prompt.artifacts.length > 0 ? (
          <>
            {prompt.artifacts.map((path) => (
              <button
                key={path}
                className={`chip${path === selectedPath ? " chip--active" : ""}`}
                onClick={() => onSelectArtifact(path)}
                style={path === selectedPath ? { borderColor: "var(--color-warning)", background: "var(--color-background-yellow)" } : undefined}
              >
                {path.split("/").pop() ?? path}
              </button>
            ))}
          </>
        ) : undefined
      }
    >
      <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
        Iteration {iteration}. A rejection returns to the same live session,
        which revises this file and asks again — the stage is not restarted.
      </p>

      {history.length > 0 ? (
        <div style={{ marginTop: "var(--spacing-3)" }}>
          <strong style={{ fontSize: "var(--font-size-sm)" }}>Review history</strong>
          {history.map((round) => (
            <div key={round.key} style={{ marginTop: "var(--spacing-2)" }}>
              <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>{round.label}</span>
              {round.at ? (
                <span className="muted" style={{ fontSize: "var(--font-size-xs)", marginLeft: "var(--spacing-2)", fontFamily: "var(--font-family-code)" }}>{relTime(round.at)}</span>
              ) : null}
              {round.note ? (
                <p className="muted" style={{ margin: "2px 0 0", fontSize: "var(--font-size-sm)" }}>{round.note}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {inboundEnvelope ? (
        <div style={{ marginTop: "var(--spacing-3)" }}>
          <strong style={{ fontSize: "var(--font-size-sm)" }}>Inbound context</strong>
          <p className="muted" style={{ fontSize: "var(--font-size-sm)", margin: "2px 0 var(--spacing-2)" }}>{inboundEnvelope.summary}</p>
          {onOpenInboundEnvelope ? (
            <button className="btn btn--ghost btn--sm" onClick={onOpenInboundEnvelope}>{inboundLabel}</button>
          ) : (
            <span className="muted" style={{ fontSize: "var(--font-size-sm)" }}>{inboundLabel}</span>
          )}
        </div>
      ) : null}
    </DecidePanel>
  );
}
