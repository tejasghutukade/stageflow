import type { RefObject } from "react";
import { LuCheck, LuFileText, LuX } from "react-icons/lu";
import { Keycap } from "../Keycap";

export type GateDecisionBarProps = {
  note: string;
  onNoteChange: (value: string) => void;
  noteRef?: RefObject<HTMLTextAreaElement | null>;
  onAccept?: () => void;
  onReject?: () => void;
  disabled?: boolean;
  showActions?: boolean;
  canReject?: boolean;
  layout?: "inbox-footer" | "run-detail-inline";
  acceptLabel?: string;
  onOpenArtifact?: () => void;
};

export function GateDecisionBar({
  note,
  onNoteChange,
  noteRef,
  onAccept,
  onReject,
  disabled,
  showActions = true,
  canReject = false,
  layout = "inbox-footer",
  acceptLabel = "Accept",
  onOpenArtifact,
}: GateDecisionBarProps) {
  const inline = layout === "run-detail-inline";

  const noteField = (
    <label
      className={
        inline
          ? "flex h-11 flex-col rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-2.5 py-2"
          : "flex h-10 items-center gap-2.5 rounded-lg border border-[#ffffff1a] bg-[var(--sf-panel)] px-3"
      }
    >
      <textarea
        ref={noteRef}
        className="min-h-0 flex-1 resize-none border-0 bg-transparent text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[#8b8f98]"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        rows={inline ? 2 : 1}
        placeholder={
          inline
            ? "Add a note for the agent (optional)"
            : "Add a note for the agent (optional; required to reject)…"
        }
        disabled={disabled}
      />
      {inline ? null : <Keycap>N</Keycap>}
    </label>
  );

  const actions = showActions ? (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={
          inline
            ? "flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[#f5b544] px-3 text-[13px] font-semibold text-[#1a1306] shadow-[0px_0px_10px_rgba(245,181,68,0.45)] disabled:opacity-50"
            : "flex h-[34px] shrink-0 items-center gap-2 rounded-lg bg-[var(--sf-needs)] px-3.5 text-[13px] font-medium text-[#1a1306] shadow-[0px_0px_16px_rgba(245,181,68,0.25)] disabled:opacity-50"
        }
        disabled={disabled}
        onClick={onAccept}
      >
        {inline ? (
          <LuCheck className="size-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        {acceptLabel}
        <Keycap
          className={
            inline
              ? "border-[#1a130640]! bg-[#1a13061a] text-[#1a1306]!"
              : undefined
          }
        >
          1
        </Keycap>
      </button>
      {canReject ? (
        <button
          type="button"
          className={
            inline
              ? "flex h-8 shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 text-[13px] font-medium text-[#ecedee] disabled:opacity-50"
              : "flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3.5 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
          }
          disabled={disabled}
          onClick={onReject}
        >
          {inline ? (
            <LuX className="size-3.5 shrink-0" aria-hidden="true" />
          ) : null}
          {inline ? "Reject with note" : "Send back with note"}
          <Keycap>3</Keycap>
        </button>
      ) : null}
      {inline && onOpenArtifact ? (
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] text-[#a7aab2] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
          onClick={onOpenArtifact}
        >
          <LuFileText className="size-3.5 shrink-0" aria-hidden="true" />
          Open artifact
        </button>
      ) : null}
      {inline ? (
        <span className="ml-auto font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
          ⌘↵ send note
        </span>
      ) : (
        <div className="ml-auto hidden min-w-0 flex-1 text-right text-xs leading-[1.4] text-[var(--sf-text-3)] sm:block" />
      )}
    </div>
  ) : null;

  if (inline) {
    return (
      <div className="flex flex-col gap-2.5">
        {noteField}
        {actions}
      </div>
    );
  }

  return (
    <footer className="flex shrink-0 flex-col gap-3 border-t border-t-[#ffffff0f] bg-[#0e0f11] px-8 py-[18px]">
      {noteField}
      {actions}
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--sf-text-3)]">
        <span className="inline-flex items-center gap-1">
          <Keycap>J</Keycap>
          <Keycap>K</Keycap>
          move
        </span>
        <span className="inline-flex items-center gap-1">
          <Keycap>N</Keycap>
          note
        </span>
        <span className="inline-flex items-center gap-1">
          <Keycap>O</Keycap>
          open run
        </span>
      </div>
    </footer>
  );
}
