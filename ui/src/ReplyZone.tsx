import { useEffect, useState } from "react";
import { type Decision, type PendingPrompt } from "./api";
import {
  emptyMultiDraft,
  isFreeTextReady,
  isMultiDraftReady,
} from "./stageAnswer/answerRules";
import { useOperatorAnswer } from "./stageAnswer/useOperatorAnswer";

export function ReplyZone({
  runId,
  stageId,
  prompt,
  onReviewSideBySide,
}: {
  runId: string;
  stageId: string;
  prompt: PendingPrompt;
  onReviewSideBySide?: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const [optionalText, setOptionalText] = useState("");
  const [multiDraft, setMultiDraft] = useState(() =>
    prompt.kind === "multi_question"
      ? emptyMultiDraft(prompt.questions)
      : emptyMultiDraft([]),
  );
  const { submitting, error, locked, submitIntent } = useOperatorAnswer(
    runId,
    stageId,
    { promptId: prompt.id, kind: prompt.kind },
  );

  useEffect(() => {
    setText("");
    setOptionalText("");
    setMultiDraft(
      prompt.kind === "multi_question"
        ? emptyMultiDraft(prompt.questions)
        : emptyMultiDraft([]),
    );
  }, [prompt.id, prompt.kind]);

  async function onFreeTextSubmit() {
    await submitIntent({ type: "free_text", text });
  }

  async function onDecision(decision: Decision) {
    if (prompt.kind !== "confirm" && prompt.kind !== "artifact_backed") return;
    await submitIntent({ type: "decision", decision, note: optionalText });
  }

  async function onMultiSubmit() {
    if (prompt.kind !== "multi_question") return;
    await submitIntent({ type: "multi", draft: multiDraft }, prompt);
  }

  const promptBody =
    prompt.kind === "multi_question"
      ? "Answer each question below."
      : prompt.message;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-3)" }}>
      <div>
        <h4 style={{ margin: "0 0 var(--spacing-1)", fontSize: "var(--font-size-base)", fontWeight: 600 }}>Operator reply</h4>
        <p className="muted" style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>{promptBody}</p>
      </div>
      {error ? (
        <div className="gate" style={{ padding: "var(--spacing-3)", borderColor: "var(--color-border-red)", borderLeftColor: "var(--color-error)", background: "var(--color-background-red)", color: "var(--color-text-red)" }}>
          <p style={{ margin: 0, fontSize: "var(--font-size-sm)" }}>Could not submit answer: {error}</p>
        </div>
      ) : null}
      {prompt.kind === "free_text" ? (
        <>
          <textarea
            className="select"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            disabled={locked}
            autoFocus
            placeholder="Your answer"
            style={{ minHeight: 84, resize: "vertical" }}
          ></textarea>
          <button
            className="btn btn--primary"
            disabled={locked || !isFreeTextReady(text)}
            onClick={() => void onFreeTextSubmit()}
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        </>
      ) : null}
      {prompt.kind === "confirm" || prompt.kind === "artifact_backed" ? (
        <>
          {prompt.kind === "artifact_backed" &&
          onReviewSideBySide &&
          prompt.artifacts.length > 0 ? (
            <button
              className="btn btn--ghost"
              onClick={() => onReviewSideBySide(prompt.artifacts[0])}
            >
              Review side by side
            </button>
          ) : null}
          <textarea
            className="select"
            value={optionalText}
            onChange={(e) => setOptionalText(e.target.value)}
            rows={3}
            disabled={locked}
            placeholder="Optional notes"
            style={{ minHeight: 62, resize: "vertical" }}
          ></textarea>
          <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
            <button
              className="btn btn--accept"
              disabled={locked}
              onClick={() => void onDecision("accept")}
            >
              {submitting ? "Submitting…" : "Accept"}
            </button>
            <button
              className="btn btn--reject"
              disabled={locked}
              onClick={() => void onDecision("reject")}
            >
              Reject
            </button>
          </div>
        </>
      ) : null}
      {prompt.kind === "multi_question" ? (
        <>
          {prompt.questions.map((q) =>
            q.kind === "free_text" ? (
              <div key={q.id}>
                <label style={{ display: "block", marginBottom: "var(--spacing-1)", fontSize: "var(--font-size-sm)", fontWeight: 600 }}>{q.message}</label>
                <textarea
                  className="select"
                  value={multiDraft.freeText[q.id] ?? ""}
                  onChange={(e) =>
                    setMultiDraft((prev) => ({
                      ...prev,
                      freeText: { ...prev.freeText, [q.id]: e.target.value },
                    }))
                  }
                  rows={3}
                  disabled={locked}
                  style={{ minHeight: 62, resize: "vertical" }}
                ></textarea>
              </div>
            ) : (
              <div key={q.id}>
                <p style={{ margin: "0 0 var(--spacing-2)", fontSize: "var(--font-size-sm)", fontWeight: 500 }}>{q.message}</p>
                <div style={{ display: "flex", gap: "var(--spacing-2)", marginBottom: "var(--spacing-2)" }}>
                  <button
                    className={`btn btn--sm${multiDraft.confirm[q.id]?.decision === "accept" ? " btn--accept" : ""}`}
                    disabled={locked}
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
                    className={`btn btn--sm${multiDraft.confirm[q.id]?.decision === "reject" ? " btn--reject" : ""}`}
                    disabled={locked}
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
                <textarea
                  className="select"
                  value={multiDraft.confirm[q.id]?.text ?? ""}
                  onChange={(e) =>
                    setMultiDraft((prev) => ({
                      ...prev,
                      confirm: {
                        ...prev.confirm,
                        [q.id]: {
                          decision: prev.confirm[q.id]?.decision ?? null,
                          text: e.target.value,
                        },
                      },
                    }))
                  }
                  rows={2}
                  disabled={locked}
                  placeholder="Optional notes"
                  style={{ minHeight: 42, resize: "vertical" }}
                ></textarea>
              </div>
            ),
          )}
          <button
            className="btn btn--primary"
            disabled={locked || !isMultiDraftReady(prompt.questions, multiDraft)}
            onClick={() => void onMultiSubmit()}
          >
            {submitting ? "Submitting…" : "Submit answers"}
          </button>
        </>
      ) : null}
    </div>
  );
}
