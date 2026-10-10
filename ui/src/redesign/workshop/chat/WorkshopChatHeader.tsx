import { LuHistory, LuSparkles, LuSquarePen } from "react-icons/lu";

export type WorkshopChatHeaderProps = {
  sessionTitle: string | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onNewSession: () => void;
};

export function WorkshopChatHeader({
  sessionTitle,
  historyOpen,
  onToggleHistory,
  onNewSession,
}: WorkshopChatHeaderProps) {
  const title = sessionTitle?.trim() ?? "";
  return (
    <div className="flex h-[52px] w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] px-4">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[#ffffff14] bg-[#1a1c21]">
        <LuSparkles aria-hidden className="size-3.5 text-[#ecedee]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <div className="flex items-center gap-1.5">
          <span className="whitespace-nowrap text-[13px] font-semibold leading-normal text-[#ecedee]">
            Workshop Author
          </span>
          <span className="flex h-[18px] items-center rounded-sm border border-[#ffffff1a] bg-[#1a1c21] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#a7aab2]">
            workshop-author
          </span>
        </div>
        {title ? (
          <span title={title} className="min-w-0 truncate text-xs leading-normal text-[#a7aab2]">
            {title}
          </span>
        ) : (
          <span className="font-['Geist_Mono',monospace] text-[11px] leading-normal text-[#8b8f98]">
            new session
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label="Workshop history"
        aria-expanded={historyOpen}
        data-workshop-history-toggle=""
        onClick={onToggleHistory}
        className={`flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-[#ffffff0a] ${historyOpen ? "bg-[#ffffff0a] text-[#ecedee]" : "text-[#8b8f98]"}`}
      >
        <LuHistory aria-hidden className="size-[15px]" />
      </button>
      <button
        type="button"
        aria-label="New session"
        onClick={onNewSession}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[#8b8f98] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
      >
        <LuSquarePen aria-hidden className="size-[15px]" />
      </button>
    </div>
  );
}
