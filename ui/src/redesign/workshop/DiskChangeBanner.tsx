import { LuFilePlus, LuX } from "react-icons/lu";
import { formatAgo, useNow, type TimeInput } from "./relativeTime";

export type DiskChangeBannerProps = {
  changedPaths: string[];
  onReload: () => void;
  onKeep: () => void;
  changedAt?: TimeInput | null;
  onDismiss?: () => void;
};

const MAX_PATHS = 2;

export function DiskChangeBanner({
  changedPaths,
  onReload,
  onKeep,
  changedAt,
  onDismiss,
}: DiskChangeBannerProps) {
  const now = useNow(30000, changedAt != null);
  const age = changedAt != null ? formatAgo(changedAt, now) : "";
  const shown = changedPaths.slice(0, MAX_PATHS);
  const more = changedPaths.length - shown.length;
  return (
    <div
      role="alert"
      className="flex h-10 w-full shrink-0 items-center gap-2.5 border-b border-b-[#ffffff12] bg-[#131418] px-4 font-sans"
    >
      <LuFilePlus className="size-3.5 shrink-0 text-[#a7aab2]" aria-hidden />
      <div className="mr-1 flex min-w-0 shrink items-center gap-1 whitespace-nowrap">
        <span
          className="min-w-0 truncate font-['Geist_Mono',monospace] text-xs text-[#ecedee]"
          title={changedPaths.join("\n")}
        >
          {shown.length ? shown.join(", ") : "Catalog files"}
        </span>
        {more > 0 ? <span className="text-[13px] text-[#a7aab2]">+{more} more</span> : null}
        <span className="text-[13px] text-[#a7aab2]">
          changed on disk{age ? ` ${age}` : ""}
        </span>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="flex h-[26px] shrink-0 items-center rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-2.5 text-xs font-medium text-[#ecedee] hover:bg-[#202228]"
      >
        Reload from disk
      </button>
      <button
        type="button"
        onClick={onKeep}
        className="flex h-[26px] shrink-0 items-center rounded-md px-2 text-xs font-medium text-[#a7aab2] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
      >
        Keep workshop draft
      </button>
      <div className="min-w-0 flex-1" />
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-[#ffffff0a]"
        >
          <LuX className="size-3.5 text-[#8b8f98]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
