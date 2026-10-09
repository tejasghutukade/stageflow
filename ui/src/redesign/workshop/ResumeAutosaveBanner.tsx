import { LuHistory, LuX } from "react-icons/lu";
import { formatAgo, useNow } from "./relativeTime";

export type ResumeAutosaveBannerProps = {
  updatedAt: string;
  onResume: () => void;
  onDismiss: () => void;
  pipelineId?: string | null;
  onDiscard?: () => void;
};

export function ResumeAutosaveBanner({
  updatedAt,
  onResume,
  onDismiss,
  pipelineId,
  onDiscard,
}: ResumeAutosaveBannerProps) {
  const now = useNow(30000);
  const age = formatAgo(updatedAt, now);
  return (
    <div
      role="status"
      className="flex h-10 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] bg-[#131418] px-4 font-sans"
    >
      <LuHistory className="size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
      <div className="mr-1 flex min-w-0 shrink items-center gap-1 whitespace-nowrap">
        <span className="text-[13px] text-[#a7aab2]">
          You have an autosaved draft{pipelineId ? " for" : ""}
        </span>
        {pipelineId ? (
          <span className="min-w-0 truncate font-['Geist_Mono',monospace] text-xs text-[#ecedee]">
            {pipelineId}
          </span>
        ) : null}
        {age ? <span className="text-[13px] text-[#8b8f98]">from {age}</span> : null}
      </div>
      <button
        type="button"
        onClick={onResume}
        className="flex h-[26px] shrink-0 items-center rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs font-medium text-[#ecedee] hover:bg-[#202228]"
      >
        Resume
      </button>
      {onDiscard ? (
        <button
          type="button"
          onClick={onDiscard}
          className="flex h-[26px] shrink-0 items-center rounded-md px-2 text-xs font-medium text-[#a7aab2] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
        >
          Discard…
        </button>
      ) : null}
      <div className="min-w-0 flex-1" />
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-[#ffffff0a]"
      >
        <LuX className="size-3.5 text-[#8b8f98]" aria-hidden />
      </button>
    </div>
  );
}
