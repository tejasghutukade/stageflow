import { useMemo } from "react";
import type { RunDetail, StageSnapshot } from "../../api";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import {
  formatDurationMs,
  formatRunCost,
} from "../../runs/formatRunMetrics";
import {
  axisSpanMs,
  futureBarSlots,
  isFutureTimelineStage,
  stageRowDurationMs,
  timelineBounds,
  visibleStageBars,
  type TimelineSegment,
} from "../../runs/stageTimeline";
import {
  findStageTrackNode,
  isTimelineBlockedStage,
  stageTimelineSubline,
} from "../../runs/stageTrackNode";
import {
  signalIcon,
  statusSignalFromReadiness,
  statusSignalFromStageStatus,
} from "../statusSignal";

function barClass(kind: TimelineSegment["kind"]): string {
  if (kind === "running") return "bg-[var(--sf-running)]";
  if (kind === "waiting") {
    return "overflow-hidden border border-[#f5b544b3] shadow-[0px_0px_10px_rgba(245,181,68,0.35)]";
  }
  if (kind === "succeeded") return "bg-[var(--sf-ok)]";
  if (kind === "failed") return "bg-[var(--sf-fail)]";
  if (kind === "skipped") return "bg-[var(--sf-text-3)]";
  return "bg-[var(--sf-track-empty)]";
}

function barRadius(index: number, count: number): string {
  if (count <= 1) return "rounded-sm";
  if (index === 0) return "rounded-l-sm";
  if (index === count - 1) return "rounded-r-sm";
  return "rounded-none";
}

function formatAxis(ms: number, spanMs: number): string {
  const trim = (value: number) => {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (spanMs <= 60_000) return `${trim(ms / 1000)}s`;
  if (spanMs < 3_600_000) return `${trim(ms / 60_000)}m`;
  if (spanMs < 86_400_000) return `${trim(ms / 3_600_000)}h`;
  return `${trim(ms / 86_400_000)}d`;
}

export function RunTimelineGantt({
  run,
  stages,
  selectedStageId,
  onSelectStage,
  now,
}: {
  run: RunDetail;
  stages: StageSnapshot[];
  selectedStageId: string | null;
  onSelectStage: (stageId: string) => void;
  now: number;
}) {
  const bounds = useMemo(
    () => timelineBounds(run, stages, now),
    [run, stages, now],
  );
  const terminalRunStatuses = new Set<string>([
    "succeeded",
    "failed",
    "cancelled",
    "abandoned",
  ]);
  const showNowMarker =
    run.finished_at == null && !terminalRunStatuses.has(run.status);
  const span = axisSpanMs(bounds.endMs - bounds.startMs, showNowMarker);
  const doneCount = stages.filter((s) => s.status === "succeeded").length;
  const tickCount = 5;
  const ticks = useMemo(() => {
    return Array.from({ length: tickCount }, (_, i) => {
      const frac = i / (tickCount - 1);
      return { label: formatAxis(span * frac, span), left: `${frac * 100}%` };
    });
  }, [span]);
  const nowLeftPct = showNowMarker
    ? Math.min(100, Math.max(0, ((now - bounds.startMs) / span) * 100))
    : null;
  const futureStages = stages.filter((stage) => isFutureTimelineStage(stage));
  const futureSlots = futureBarSlots(futureStages.length, nowLeftPct);
  const futureSlotById = new Map(
    futureStages.map((stage, index) => [stage.stage_id, futureSlots[index]]),
  );

  return (
    <div className="flex w-full flex-col border-b border-b-[#ffffff12] px-0 pt-3 pb-2">
      <div className="flex items-center justify-between px-6 pb-2 pt-0">
        <div className="flex items-center gap-2">
          <span className="font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Stages
          </span>
          <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
            {doneCount} / {stages.length} done
          </span>
        </div>
        <div className="flex items-center gap-3.5">
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-2.5 rounded-xs bg-[var(--sf-ok)]" />
            <span className="font-sans text-xs text-[var(--sf-text-2)]">Succeeded</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-2.5 rounded-xs bg-[var(--sf-running)]" />
            <span className="font-sans text-xs text-[var(--sf-text-2)]">Agent working</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-2.5 rounded-xs bg-[var(--sf-needs)] shadow-[0px_0px_6px_rgba(245,181,68,0.6)]" />
            <span className="font-sans text-xs text-[var(--sf-text-2)]">Waiting on you</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-2.5 rounded-xs border border-dashed border-[#a7aab28c] bg-transparent" />
            <span className="font-sans text-xs text-[var(--sf-text-2)]">Queued</span>
          </span>
        </div>
      </div>
      <div className="relative flex w-full flex-col">
        <div
          className="pointer-events-none absolute flex gap-4 px-6"
          style={{ top: 0, right: 0, bottom: 0, left: 0, zIndex: 3 }}
          aria-hidden="true"
        >
          <span className="block w-[140px] shrink-0" style={{ width: 140 }} />
          <div className="relative flex-1">
            {ticks.map((tick, index) => (
              <span
                key={`grid-${index}`}
                className="absolute bottom-0 w-px bg-[#ffffff0f]"
                style={{ left: tick.left, top: 24 }}
              />
            ))}
            {nowLeftPct != null ? (
              <span
                className="absolute w-px"
                style={{
                  left: `${nowLeftPct}%`,
                  top: 18,
                  bottom: 0,
                  backgroundColor: "rgba(236, 237, 238, 0.7)",
                }}
              />
            ) : null}
          </div>
          <span className="block w-[150px] shrink-0" />
        </div>
        <div className="relative flex h-6 items-center gap-4 px-6 py-0" style={{ zIndex: 4 }}>
          <span className="block w-[140px] shrink-0" style={{ width: 140 }} />
          <div className="relative h-4 flex-1">
            {ticks.map((tick, index) => (
              <span
                key={`tick-${index}`}
                className="absolute top-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]"
                style={{ left: tick.left, transform: "translateX(-50%)" }}
              >
                {tick.label}
              </span>
            ))}
            {nowLeftPct != null ? (
              <span
                className="absolute z-[2] rounded-sm bg-[#ecedee] px-[5px] py-0 font-['Geist_Mono',monospace] text-[10px] font-semibold leading-[1.6] text-[#0c0d0f]"
                style={{ left: `${nowLeftPct}%`, transform: "translateX(-50%)" }}
              >
                now
              </span>
            ) : null}
          </div>
          <div className="flex w-[150px] shrink-0 justify-end gap-3">
            <span className="font-sans text-[11px] uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Time
            </span>
            <span className="w-12 text-right font-sans text-[11px] uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Cost
            </span>
          </div>
        </div>
        {stages.map((stage) => {
          const trackNode = findStageTrackNode(run, stage.stage_id);
          const blocked = isTimelineBlockedStage(stage, trackNode);
          const waiting = stage.status === "waiting_for_input";
          const futureSlot = futureSlotById.get(stage.stage_id);
          const bars = futureSlot ? [] : visibleStageBars(stage, now, trackNode);
          const duration = formatDurationMs(stageRowDurationMs(stage, now));
          const selected = selectedStageId === stage.stage_id;
          const signal = blocked
            ? statusSignalFromReadiness("blocked")
            : statusSignalFromStageStatus(stage.status);
          const timelineSubline = stageTimelineSubline(stage, trackNode);
          const Icon = signalIcon(signal);
          const iconColor =
            signal === "ok"
              ? "text-[#4cc38a]"
              : signal === "fail"
                ? "text-[#f2645a]"
                : signal === "needs"
                  ? "text-[#f5b544]"
                  : signal === "running"
                    ? "text-[var(--sf-running)]"
                    : "text-[var(--sf-text-2)]";
          const mutedLabel = blocked;
          const selectionBarClass =
            signal === "fail"
              ? "bg-[var(--sf-fail)]"
              : signal === "needs"
                ? "bg-[var(--sf-needs)] shadow-[0px_0px_8px_rgba(245,181,68,0.6)]"
                : "bg-[var(--sf-needs)]";
          const durationClass =
            waiting && (selected || signal === "needs")
              ? "text-[var(--sf-needs)]"
              : mutedLabel && !selected
                ? "text-[var(--sf-text-3)]"
                : "text-[var(--sf-text-1)]";

          return (
            <button
              key={stage.stage_id}
              type="button"
              className={`relative z-[1] flex h-8 w-full items-center gap-4 px-6 py-0 text-left${
                selected ? " bg-[var(--sf-panel)]" : ""
              }`}
              onClick={() => onSelectStage(stage.stage_id)}
            >
              {selected ? (
                <span
                  className={`absolute bottom-0 left-0 top-0 w-0.5 ${selectionBarClass}`}
                />
              ) : null}
              <div
                className="flex w-[140px] min-w-0 shrink-0 items-center gap-2 overflow-hidden"
                style={{ width: 140 }}
              >
                <Icon className={`size-3.5 shrink-0 ${iconColor}`} aria-hidden="true" />
                <span
                  className={`truncate font-sans text-[13px] leading-normal${
                    selected && !mutedLabel ? " font-medium" : ""
                  }${
                    mutedLabel ? " text-[var(--sf-text-2)]" : " text-[var(--sf-text-1)]"
                  }`}
                >
                  {stageCloneLabel(run, stage.stage_id)}
                </span>
                {waiting ? (
                  <span className="shrink-0 font-sans text-[11px] font-medium text-[var(--sf-needs)]">
                    waiting
                  </span>
                ) : blocked ? (
                  <span className="shrink-0 font-sans text-[11px] font-medium text-[var(--sf-text-2)]">
                    Blocked
                  </span>
                ) : timelineSubline ? (
                  <span className="shrink-0 font-sans text-[11px] text-[var(--sf-text-3)]">
                    {timelineSubline}
                  </span>
                ) : null}
              </div>
              <div className="relative h-3.5 flex-1">
                {futureSlot ? (
                  <span
                    className="absolute top-0 block h-3.5 rounded-sm border border-dashed border-[#a7aab28c] bg-transparent"
                    style={{
                      left: `${futureSlot.left}%`,
                      width: `${futureSlot.width}%`,
                    }}
                  />
                ) : (
                  bars.map((seg, i) => {
                    const leftPct =
                      ((Math.max(bounds.startMs, seg.startMs) - bounds.startMs) / span) * 100;
                    const widthPct = (Math.max(0, seg.endMs - seg.startMs) / span) * 100;
                    return (
                      <span
                        key={`${seg.kind}-${i}`}
                        className={`absolute top-0 block h-3.5 ${barRadius(i, bars.length)} ${barClass(seg.kind)}`}
                        style={{
                          left: `${leftPct}%`,
                          width: `${Math.max(widthPct, 0.35)}%`,
                          ...(seg.kind === "waiting"
                            ? {
                                backgroundColor: "#f5b54424",
                                backgroundImage:
                                  "repeating-linear-gradient(90deg, #f5b54499 0 2px, transparent 2px 8px)",
                              }
                            : {}),
                        }}
                      />
                    );
                  })
                )}
              </div>
              <div className="flex w-[150px] shrink-0 justify-end gap-3 font-['Geist_Mono',monospace] text-xs">
                <span className={durationClass}>{duration}</span>
                <span className="w-12 text-right text-[var(--sf-text-3)]">
                  {formatRunCost(stage.cost_usd)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
