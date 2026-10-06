import type { RefObject } from "react";
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
}: GateDecisionBarProps) {
  return (
    <footer className="flex shrink-0 flex-col gap-3 border-t border-t-[#ffffff0f] bg-[#0e0f11] px-8 py-[18px]">
      <label className="flex h-10 items-center gap-2.5 rounded-lg border border-[#ffffff1a] bg-[var(--sf-panel)] px-3">
        <textarea
          ref={noteRef}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent py-2 text-[13px] text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)]"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          rows={1}
          placeholder="Add a note for the agent (optional; required to reject)…"
          disabled={disabled}
        />
        <Keycap>N</Keycap>
      </label>
      {showActions ? (
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg bg-[var(--sf-needs)] px-3.5 text-[13px] font-medium text-[#1a1306] shadow-[0px_0px_16px_rgba(245,181,68,0.25)] disabled:opacity-50"
            disabled={disabled}
            onClick={onAccept}
          >
            Accept
            <Keycap>1</Keycap>
          </button>
          {canReject ? (
            <button
              type="button"
              className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3.5 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
              disabled={disabled}
              onClick={onReject}
            >
              Send back with note
              <Keycap>3</Keycap>
            </button>
          ) : null}
          <div className="ml-auto hidden min-w-0 flex-1 text-right text-xs leading-[1.4] text-[var(--sf-text-3)] sm:block" />
        </div>
      ) : null}
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
