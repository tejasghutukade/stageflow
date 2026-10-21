import { useEffect, useState } from "react";
import {
  buildDialogAnswer,
  canAnswer,
  DIALOG_HANDLED_LABEL,
  DIALOG_LABEL,
  DIALOG_VIEW_ONLY_HINT,
  MAX_PROMPT_TEXT,
  type DialogAnswerBody,
  type ViewerDialog,
} from "./dialogState";
import type { LiveViewMode } from "./types";

export function DialogOverlay({
  dialog,
  mode,
  busy,
  failed,
  onAnswer,
}: {
  dialog: ViewerDialog;
  mode: LiveViewMode;
  busy: boolean;
  failed: string | null;
  onAnswer(body: DialogAnswerBody): void;
}) {
  const [text, setText] = useState(dialog.defaultPrompt);
  useEffect(() => setText(dialog.defaultPrompt), [dialog.id, dialog.defaultPrompt]);
  const answerable = canAnswer(dialog, mode);
  const label = dialog.autoClosed ? DIALOG_HANDLED_LABEL : DIALOG_LABEL;

  return (
    <div className="liveview__dialog" role="alertdialog" aria-label={label}>
      <p className="liveview__dialog-label">{label}</p>
      <p className="liveview__dialog-message">{dialog.message}</p>
      {answerable && dialog.kind === "prompt" ? (
        <input
          className="liveview__dialog-input"
          type="text"
          aria-label="Answer to the page dialog"
          value={text}
          maxLength={MAX_PROMPT_TEXT}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      ) : null}
      {answerable ? (
        <div className="liveview__dialog-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => onAnswer(buildDialogAnswer(dialog, true, text))}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => onAnswer(buildDialogAnswer(dialog, false, text))}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {!answerable && mode === "view" && dialog.answerable ? (
        <p className="liveview__dialog-hint">{DIALOG_VIEW_ONLY_HINT}</p>
      ) : null}
      {failed !== null ? <p className="liveview__dialog-hint">{failed}</p> : null}
    </div>
  );
}
