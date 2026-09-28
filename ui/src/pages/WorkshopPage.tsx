import { useCallback, useMemo, useState } from "react";
import {
  createDraftPackageWithDetails,
  validateDraftPackage,
  type DraftValidationResult,
  type ValidationFinding,
} from "../api";
import { PipelineTrack, type TrackStage } from "../components/PipelineTrack";
import { showToast } from "../toast";
import {
  draftStageIds,
  emptyDraftPackage,
  proposeStageFromMessage,
  WORKSHOP_AUTHOR_GREETING,
  type ChatMessage,
  type DraftPackage,
  type WorkshopProposal,
} from "../workshop/draft";

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `msg-${msgSeq}`;
}

function definitionTrack(
  draft: DraftPackage,
  highlightIds: ReadonlySet<string>,
): TrackStage[] {
  return draftStageIds(draft).map((id) => ({
    id,
    label: id,
    status: "pending" as const,
    selected: highlightIds.has(id),
  }));
}

export function WorkshopPage() {
  const [draft, setDraft] = useState<DraftPackage>(() => emptyDraftPackage());
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: nextMsgId(),
      role: "assistant",
      text: WORKSHOP_AUTHOR_GREETING,
    },
  ]);
  const [pending, setPending] = useState<WorkshopProposal | null>(null);
  const [input, setInput] = useState("");
  const [findings, setFindings] = useState<ValidationFinding[]>([]);
  const [validationOk, setValidationOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [saveDirectory, setSaveDirectory] = useState("pipelines");
  const [savePipelineId, setSavePipelineId] = useState("untitled");

  const pendingIds = useMemo(() => {
    if (!pending) return new Set<string>();
    const current = new Set(draftStageIds(draft));
    return new Set(
      draftStageIds(pending.nextDraft).filter((id) => !current.has(id)),
    );
  }, [draft, pending]);

  const track = useMemo(
    () =>
      definitionTrack(
        pending ? pending.nextDraft : draft,
        pendingIds,
      ),
    [draft, pending, pendingIds],
  );
  const canSave = validationOk === true && !busy;

  const startNew = useCallback(() => {
    setDraft(emptyDraftPackage());
    setPending(null);
    setFindings([]);
    setValidationOk(null);
    setSavedPath(null);
    setShowSaveForm(false);
    setSavePipelineId("untitled");
    setMessages([
      {
        id: nextMsgId(),
        role: "assistant",
        text: WORKSHOP_AUTHOR_GREETING,
      },
    ]);
  }, []);

  const onSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy || pending) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: nextMsgId(), role: "user", text },
    ]);
    const proposal = proposeStageFromMessage(draft, text);
    setPending(proposal);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "assistant",
        text: `I propose: ${proposal.summary}. Accept to update the draft, or Reject to leave it unchanged.`,
      },
    ]);
  }, [busy, draft, input, pending]);

  const onAccept = useCallback(() => {
    if (!pending) return;
    setDraft(pending.nextDraft);
    if (typeof pending.nextDraft.pipeline.id === "string") {
      setSavePipelineId(pending.nextDraft.pipeline.id);
    }
    setPending(null);
    setValidationOk(null);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "system",
        text: `Accepted: ${pending.summary}`,
      },
    ]);
  }, [pending]);

  const onReject = useCallback(() => {
    if (!pending) return;
    const summary = pending.summary;
    setPending(null);
    setMessages((prev) => [
      ...prev,
      {
        id: nextMsgId(),
        role: "system",
        text: `Rejected: ${summary}`,
      },
    ]);
  }, [pending]);

  const onValidate = useCallback(async () => {
    setBusy(true);
    try {
      const result: DraftValidationResult = await validateDraftPackage(draft);
      setFindings(result.findings);
      setValidationOk(result.ok);
      if (result.ok) {
        showToast("Draft is valid");
      } else {
        showToast(
          `${result.summary.errors} validation error${result.summary.errors === 1 ? "" : "s"}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setValidationOk(false);
      setFindings([
        {
          severity: "error",
          code: "workshop.validate_failed",
          path: "<draft>",
          message,
          category: "pipeline",
        },
      ]);
      showToast(message);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const onSaveClick = useCallback(async () => {
    if (savedPath) {
      showToast("Overwrite save lands in a later ticket — use New for another create");
      return;
    }
    if (validationOk !== true) {
      showToast("Validate successfully before Save");
      return;
    }
    setShowSaveForm(true);
    setSavePipelineId(draft.pipeline.id || "untitled");
  }, [draft.pipeline.id, savedPath, validationOk]);

  const onConfirmSave = useCallback(async () => {
    if (validationOk !== true) {
      showToast("Save blocked: draft is invalid");
      return;
    }
    const directory = saveDirectory.trim() || "pipelines";
    const id = savePipelineId.trim() || "untitled";
    const packageDraft: DraftPackage = {
      ...draft,
      pipeline: { ...draft.pipeline, id },
    };
    setBusy(true);
    try {
      const result = await createDraftPackageWithDetails({
        directory,
        draft: packageDraft,
      });
      if (!result.ok) {
        if (result.findings) setFindings(result.findings);
        setValidationOk(false);
        showToast(result.error);
        return;
      }
      setDraft(packageDraft);
      setSavedPath(result.pipelinePath);
      setShowSaveForm(false);
      showToast(`Saved ${result.pipelinePath}`);
    } finally {
      setBusy(false);
    }
  }, [draft, saveDirectory, savePipelineId, validationOk]);

  return (
    <div className="pane workshop">
      <div className="topbar">
        <div className="topbar__title">Workshop</div>
        <div className="topbar__sub">
          {savedPath ? savedPath : "Untitled draft · Workshop Author"}
        </div>
        <div className="topbar__spacer" />
        <button type="button" className="btn" onClick={startNew} disabled={busy}>
          New
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void onValidate()}
          disabled={busy}
        >
          Validate
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void onSaveClick()}
          disabled={!canSave}
          title={
            validationOk === true
              ? "Save package to disk"
              : "Validate successfully before Save"
          }
        >
          Save
        </button>
      </div>

      <div className="workshop__body">
        <section className="workshop__canvas" aria-label="Draft DAG">
          <div className="eyebrow">Draft DAG</div>
          {track.length === 0 ? (
            <p className="empty-hint">
              Empty scaffold — chat with Workshop Author to propose stages.
            </p>
          ) : (
            <PipelineTrack stages={track} mode="definition" />
          )}
          {pending ? (
            <div className="workshop__proposal">
              <div className="eyebrow">Pending proposal</div>
              <p>{pending.summary}</p>
              <div className="workshop__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={onAccept}
                >
                  Accept
                </button>
                <button type="button" className="btn" onClick={onReject}>
                  Reject
                </button>
              </div>
            </div>
          ) : null}
          {findings.length > 0 ? (
            <div className="workshop__findings" aria-label="Validation findings">
              <div className="eyebrow">
                Validation {validationOk ? "passed" : "findings"}
              </div>
              <ul className="workshop__findings-list">
                {findings.map((f, i) => (
                  <li key={`${f.code}-${f.path}-${i}`}>
                    <span className="mono">{f.severity}</span> · {f.message}
                    <span className="muted"> ({f.path})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {showSaveForm ? (
            <div className="workshop__save">
              <div className="eyebrow">First Save destination</div>
              <label className="workshop__field">
                Directory
                <input
                  className="input"
                  value={saveDirectory}
                  onChange={(e) => setSaveDirectory(e.target.value)}
                />
              </label>
              <label className="workshop__field">
                Pipeline id
                <input
                  className="input"
                  value={savePipelineId}
                  onChange={(e) => setSavePipelineId(e.target.value)}
                />
              </label>
              <div className="workshop__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void onConfirmSave()}
                >
                  Create package
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowSaveForm(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="workshop__chat" aria-label="Workshop Author chat">
          <div className="eyebrow">Workshop Author</div>
          <div className="workshop__transcript">
            {messages.map((m) => (
              <div
                key={m.id}
                className="workshop__bubble"
                data-role={m.role}
              >
                <div className="eyebrow">{m.role}</div>
                <p>{m.text}</p>
              </div>
            ))}
          </div>
          <form
            className="workshop__composer"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                pending
                  ? "Accept or Reject the pending proposal first"
                  : "Describe a stage or workflow…"
              }
              disabled={busy || Boolean(pending)}
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || Boolean(pending) || !input.trim()}
            >
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
