import type { RunSummary } from "../../api";
import { runLocatorSubtitle, runTaskLabel } from "../../catalog/displayCatalogPath";
import { miniTrackLabel } from "../../catalogJoin";
import { MiniTrack } from "../../components/MiniTrack";
import { runStatusPillLabel } from "../statusSignal";
import { formatRunElapsed } from "./inboxViews";
import { runDisplayStatus } from "../../status/runStatus";

export type GateFocusHeaderProps = {
  run: RunSummary;
  stageId: string;
  kindLabel?: string;
  index: number;
  total: number;
};

export function GateFocusHeader({
  run,
  stageId,
  kindLabel,
  index,
  total,
}: GateFocusHeaderProps) {
  const elapsed = formatRunElapsed(run);
  const cost =
    run.total_cost_usd != null
      ? `$${run.total_cost_usd.toFixed(2)}`
      : null;
  const metaRight = [elapsed, cost].filter(Boolean).join(" · ");

  return (
    <header className="flex shrink-0 flex-col gap-3.5 border-b border-b-[#ffffff0f] px-8 pb-[18px] pt-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
          <span className="truncate">{runLocatorSubtitle(run)}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{stageId}</span>
          {kindLabel ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{kindLabel}</span>
            </>
          ) : null}
        </div>
        <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
          {total > 0 ? `${index + 1} / ${total}` : "—"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[22px] font-semibold tracking-[-0.44px] text-[var(--sf-text-1)]">
          {runTaskLabel(run)}
        </h2>
        <span className="flex h-6 items-center gap-1.5 rounded-full border border-[#f5b5444d] bg-[#f5b5441f] px-2 text-xs font-medium text-[var(--sf-needs)]">
          {runStatusPillLabel(runDisplayStatus(run))}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <MiniTrack
          stages={run.stages.map((s) => ({ id: s.id, status: s.status }))}
          label={miniTrackLabel(run)}
          variant="bar"
        />
        {metaRight ? (
          <span className="ml-auto shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            {metaRight}
          </span>
        ) : null}
      </div>
    </header>
  );
}
