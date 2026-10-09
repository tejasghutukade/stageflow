import { useEffect, useRef, useState } from "react";
import { LuArrowRight, LuCheck, LuExternalLink, LuX } from "react-icons/lu";

export type SaveToastProps = {
  pipelineId: string;
  fileCount: number;
  canRun: boolean;
  onRun: () => void;
  onOpenCatalog: () => void;
  onDismiss: () => void;
  autoDismissMs?: number;
};

export function SaveToast({
  pipelineId,
  fileCount,
  canRun,
  onRun,
  onOpenCatalog,
  onDismiss,
  autoDismissMs = 8000,
}: SaveToastProps) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (paused || autoDismissMs <= 0) return;
    const id = window.setTimeout(() => dismissRef.current(), autoDismissMs);
    return () => window.clearTimeout(id);
  }, [autoDismissMs, paused]);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="fixed bottom-6 right-6 z-[60] flex w-[340px] flex-col gap-3 rounded-xl border border-[#ffffff1a] bg-[#1a1c21] px-3.5 py-3 font-sans shadow-[0px_16px_48px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-start gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#4cc38a1f]">
          <LuCheck className="size-3.5 text-[#4cc38a]" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1">
            <span className="shrink-0 text-[13px] font-medium text-[#ecedee]">Saved</span>
            <span className="min-w-0 truncate font-['Geist_Mono',monospace] text-xs text-[#ecedee]">
              {pipelineId}
            </span>
            <span className="shrink-0 whitespace-nowrap text-[13px] text-[#a7aab2]">
              · {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
          </div>
          <span className="text-xs text-[#8b8f98]">Autosave cleared. You are still in Workshop.</span>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-m-1 flex size-[22px] shrink-0 items-center justify-center rounded-md hover:bg-[#ffffff0a]"
        >
          <LuX className="size-3.5 text-[#8b8f98]" aria-hidden />
        </button>
      </div>
      <div className="flex items-center gap-1 pl-[34px]">
        {canRun ? (
          <button
            type="button"
            onClick={onRun}
            className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg bg-[#ecedee] px-2.5 hover:bg-white"
          >
            <span className="whitespace-nowrap text-[13px] font-medium text-[#0c0d0f]">Run this workflow</span>
            <LuArrowRight className="size-3.5 text-[#0c0d0f]" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onOpenCatalog}
          className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-2 hover:bg-[#ffffff0a]"
        >
          <LuExternalLink className="size-3.5 text-[#a7aab2]" aria-hidden />
          <span className="whitespace-nowrap text-[13px] font-medium text-[#a7aab2]">Open in catalog</span>
        </button>
      </div>
    </div>
  );
}
