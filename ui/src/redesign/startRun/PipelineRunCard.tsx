import type { PipelineListing, RunSummary } from "../../api";
import {
  aggregatePipelineStats,
  formatApproxCost,
  formatApproxDuration,
} from "../../catalog/stats";
import { LuCheck } from "react-icons/lu";

export type PipelineRunCardProps = {
  pipeline: PipelineListing;
  runs: RunSummary[];
  selected: boolean;
  onSelect: () => void;
  className?: string;
};

export function PipelineRunCard({
  pipeline,
  runs,
  selected,
  onSelect,
  className,
}: PipelineRunCardProps) {
  const stats = aggregatePipelineStats(runs, pipeline.id);
  const stageNames = pipeline.stages.map((s) => s.id).join(" · ");
  const trackFill = selected ? "bg-[#3a3d44]" : "bg-[var(--sf-track-empty)]";

  const avgLabel =
    stats.sampleCount > 0 &&
    (stats.avgDurationMs != null || stats.avgCostUsd != null)
      ? [
          stats.avgDurationMs != null
            ? formatApproxDuration(stats.avgDurationMs)
            : null,
          stats.avgCostUsd != null ? formatApproxCost(stats.avgCostUsd) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex h-fit flex-col gap-2.5 rounded-[10px] border p-3 text-left${
        selected
          ? " border-[#ecedee8c] bg-[var(--sf-raised)] shadow-[0px_0px_0px_3px_rgba(236,237,238,0.06)]"
          : " border-[#ffffff1a] bg-[#0f1013]"
      }${className ? ` ${className}` : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-['Geist_Mono',monospace] text-[13px] font-medium text-[var(--sf-text-1)]">
          {pipeline.id}
        </span>
        {selected ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-[var(--sf-text-1)]">
            <LuCheck className="size-[11px] text-[var(--sf-ground)]" aria-hidden="true" />
          </span>
        ) : (
          <span className="size-4 rounded-full border border-[#ffffff2e]" />
        )}
      </div>
      <div className="flex w-full gap-[3px]">
        {pipeline.stages.map((s) => (
          <span key={s.id} className={`block h-1.5 flex-1 rounded-full ${trackFill}`} />
        ))}
      </div>
      <span className="font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
        {stageNames}
      </span>
      <div className="flex items-center justify-between border-t border-t-[#ffffff12] pt-2">
        <span
          className={`font-sans text-xs${selected ? " text-[var(--sf-text-2)]" : " text-[var(--sf-text-3)]"}`}
        >
          {pipeline.stages.length} stages
        </span>
        {avgLabel ? (
          <span
            className={`font-['Geist_Mono',monospace] text-xs${selected ? " text-[var(--sf-text-1)]" : " text-[var(--sf-text-2)]"}`}
          >
            {avgLabel}
          </span>
        ) : null}
      </div>
    </button>
  );
}
