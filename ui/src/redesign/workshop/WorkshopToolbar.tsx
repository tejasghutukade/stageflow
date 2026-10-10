import type { ReactNode } from "react";

export type WorkshopToolbarProps = {
  title: string;
  dirtyLine?: string;
  errorCount: number;
  onValidate: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  validating?: boolean;
  extra?: ReactNode;
};

export function WorkshopToolbar({
  title,
  dirtyLine,
  errorCount,
  onValidate,
  onSave,
  onSaveAs,
  validating,
  extra,
}: WorkshopToolbarProps) {
  return (
    <header
      className="flex shrink-0 items-start justify-between gap-4 border-b border-b-[#ffffff12] px-5 py-4"
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-[var(--sf-text-1)]">{title}</h1>
        {dirtyLine ? (
          <p className="mt-1 text-[13px] text-[var(--sf-text-2)]">{dirtyLine}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="sf-btn sf-btn--ghost sf-btn--sm"
          disabled={validating}
          onClick={onValidate}
        >
          Validate
        </button>
        <button
          type="button"
          className="sf-btn sf-btn--ghost sf-btn--sm"
          onClick={onSaveAs}
        >
          Save As
        </button>
        {errorCount > 0 ? (
          <span className="rounded-full bg-[#f2645a2e] px-2 py-0.5 text-[11px] text-[var(--sf-fail)]">
            {errorCount} errors
          </span>
        ) : null}
        <button
          type="button"
          className="sf-btn sf-btn--primary sf-btn--sm"
          onClick={onSave}
        >
          Save
        </button>
        {extra}
      </div>
    </header>
  );
}
