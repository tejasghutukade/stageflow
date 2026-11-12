import { BTN, BTN_PRIMARY, DialogShell } from "../evals/datasets/DialogShell";
import { FILE_CHANGED_TITLE } from "./pipelineEditorModel";

export function EditorFileChangedDialog({
  busy,
  onOverwrite,
  onReload,
  onCopy,
  onClose,
}: {
  busy?: boolean;
  onOverwrite: () => void;
  onReload: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <DialogShell
      title={FILE_CHANGED_TITLE}
      width="w-[520px]"
      onClose={onClose}
      footer={
        <>
          <span className="text-xs text-[var(--sf-text-3)]">
            Overwrite replaces the files on disk with your draft.
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className={BTN} disabled={busy} onClick={onCopy}>
              Copy draft to clipboard
            </button>
            <button type="button" className={BTN} disabled={busy} onClick={onReload}>
              Reload from disk
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={onOverwrite}>
              Overwrite on disk
            </button>
          </div>
        </>
      }
    >
      <p className="text-[13px] text-[var(--sf-text-2)]">
        Reloading drops your local edits and reads the files again. Copy keeps your draft in
        the editor and puts the YAML on the clipboard so you can merge changes elsewhere.
      </p>
    </DialogShell>
  );
}
