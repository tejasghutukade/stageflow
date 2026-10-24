import { useState } from "react";
import { LuArrowUpRight, LuCheck, LuCopy, LuTrendingDown, LuTriangleAlert } from "react-icons/lu";
import type { BannerModel, EngineBannerModel } from "./evalListModel";

const MONO = "font-['Geist_Mono',monospace]";

export function RegressionBanner({ banner, onCompare }: { banner: BannerModel; onCompare: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-lg border border-[var(--sf-fail)]/30 bg-[var(--sf-fail-bg)] px-4 py-3"
    >
      <LuTrendingDown className="size-4 shrink-0 text-[var(--sf-fail)]" aria-hidden />
      <span className="text-[13px] font-medium text-[var(--sf-text-1)]">{banner.title}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-2)]">{banner.detail}</span>
      <button
        type="button"
        onClick={onCompare}
        className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-[var(--sf-text-1)] hover:underline"
      >
        Compare runs
        <LuArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function EngineBanner({ banner }: { banner: EngineBannerModel }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(banner.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--sf-needs-border)] bg-[var(--sf-needs-bg)] px-4 py-3"
    >
      <LuTriangleAlert className="size-4 shrink-0 text-[var(--sf-needs)]" aria-hidden />
      <span className="min-w-0 flex-1 text-[13px] text-[var(--sf-text-1)]">{banner.reason}</span>
      <code
        className={`${MONO} rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 py-1 text-xs text-[var(--sf-text-1)]`}
      >
        {banner.command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-2 text-xs text-[var(--sf-text-1)]"
      >
        {copied ? <LuCheck className="size-3.5" aria-hidden /> : <LuCopy className="size-3.5" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
