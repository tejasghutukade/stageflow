import type { ValidationFinding } from "../../api";
import { Keycap } from "../Keycap";

export type SaveToCatalogDialogProps = {
  open: boolean;
  title: string;
  directory: string;
  pipelineId: string;
  filePaths: string[];
  findings: ValidationFinding[];
  saving: boolean;
  onClose: () => void;
  onSave: (allowInvalid: boolean) => void;
};

export function SaveToCatalogDialog({
  open,
  title,
  directory,
  pipelineId,
  filePaths,
  findings,
  saving,
  onClose,
  onSave,
}: SaveToCatalogDialogProps) {
  if (!open) return null;
  const errors = findings.filter((f) => f.severity === "error").length;
  const blocked = errors > 0;

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col items-center bg-[#040506a8] pt-[104px]"
      role="presentation"
    >
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close save dialog"
        onClick={onClose}
      />
      <div
        className="relative flex w-[680px] max-w-[calc(100vw-2rem)] flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[var(--sf-panel)] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start gap-3 px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-[17px] font-semibold tracking-[-0.17px] text-[var(--sf-text-1)]">
              {title}
            </h2>
            <p className="text-[13px] text-[var(--sf-text-2)]">
              Writes these files after validation passes.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <Keycap>esc</Keycap>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-lg text-[var(--sf-text-3)] hover:bg-[var(--sf-raised)]"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </header>
        <div className="flex flex-col gap-2 px-5 pb-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Destination
          </div>
          <p className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            {directory} · {pipelineId}
          </p>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-4">
          <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Files to write
          </div>
          <ul className="flex max-h-48 flex-col overflow-auto rounded-[10px] border border-[#ffffff12] bg-[#0f1013]">
            {filePaths.map((path) => (
              <li
                key={path}
                className="flex h-[38px] items-center gap-2.5 border-b border-b-[#ffffff0d] px-3 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)] last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate" title={path}>
                  {path}
                </span>
              </li>
            ))}
          </ul>
        </div>
        {findings.length > 0 ? (
          <div className="px-5 pb-4">
            <div
              className={`rounded-[10px] border px-3 py-2.5 ${
                blocked
                  ? "border-[#f2645a47] bg-[#f2645a0f]"
                  : "border-[#ffffff12] bg-[var(--sf-ground)]"
              }`}
            >
              <p
                className={`text-[13px] font-medium ${
                  blocked ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-1)]"
                }`}
              >
                {errors} validation {errors === 1 ? "error" : "errors"}
                {blocked ? " block save" : ""}
              </p>
              <ul className="mt-2 space-y-1 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
                {findings.slice(0, 6).map((f, i) => (
                  <li key={`${f.path}-${i}`} className="truncate" title={f.message}>
                    {f.path}: {f.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        <footer className="flex items-center gap-2 border-t border-t-[#ffffff12] bg-[#101114] px-5 py-3.5">
          {blocked ? (
            <p className="min-w-0 flex-1 text-xs text-[var(--sf-text-3)]">
              Fix the error or save invalid anyway
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <button
            type="button"
            className="sf-btn sf-btn--ghost"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sf-btn sf-btn--primary"
            disabled={saving || blocked}
            onClick={() => onSave(false)}
          >
            Save
          </button>
          {blocked ? (
            <button
              type="button"
              className="sf-btn sf-btn--ghost"
              disabled={saving}
              onClick={() => onSave(true)}
            >
              Save invalid anyway
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
