import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";
import { Keycap } from "../../Keycap";
import { MONO } from "./inspectorFields";
import { promptStats } from "./stageFields";

export type PromptExpandDialogProps = {
  stageId: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
};

export function PromptExpandDialog({ stageId, value, onChange, onClose }: PromptExpandDialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stats = promptStats(value);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#040506a8] [font-family:Geist,_sans-serif]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`system_prompt for ${stageId}`}
        className="flex h-[min(640px,calc(100vh-96px))] w-[min(760px,calc(100vw-48px))] flex-col overflow-clip rounded-[14px] border border-[#ffffff1a] bg-[#131418] shadow-[0px_32px_96px_rgba(0,0,0,0.65),0px_8px_24px_rgba(0,0,0,0.45)]"
      >
        <div className="flex shrink-0 items-center gap-3 px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className={`text-[15px] font-semibold tracking-[-0.15px] text-[#ecedee] ${MONO}`}>
              system_prompt
            </div>
            <div className={`truncate text-xs text-[#a7aab2] ${MONO}`}>{stageId}</div>
          </div>
          <Keycap>esc</Keycap>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg text-[#8b8f98] hover:bg-[#ffffff0d] hover:text-[#ecedee]"
          >
            <LuX className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 px-5">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            placeholder="Describe what this stage does, what it reads, and what it must emit."
            className="min-h-0 flex-1 resize-none rounded-lg border border-[#ffffff1a] bg-[#1a1c21] px-3 py-2.5 text-[13px] leading-[1.55] text-[#ecedee] outline-none transition-[border-color,box-shadow] placeholder:text-[#8b8f98] focus:border-[#ffffff33] focus:shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]"
          />
        </div>
        <div className="mt-3.5 flex shrink-0 items-center gap-2 border-t border-t-[#ffffff12] bg-[#101114] px-5 py-3.5">
          <div className={`flex-1 text-[11px] text-[#8b8f98] ${MONO}`}>
            {stats.lines} lines · {stats.chars} chars
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center gap-2 rounded-lg bg-[#ecedee] px-3 text-[13px] font-medium text-[#0c0d0f]"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
