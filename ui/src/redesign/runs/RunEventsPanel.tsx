import { useEffect, useRef, useState } from "react";
import type { StageLogEvent } from "../../api";
import {
  type RunEventsKindFilter,
  eventRowDetails,
  filterStageEvents,
  formatEventTime,
} from "./runEventsView";

const FILTERS: { id: RunEventsKindFilter; label: string }[] = [
  { id: "all", label: "All kinds" },
  { id: "tool", label: "tool" },
  { id: "message", label: "message" },
  { id: "operator_prompt", label: "operator_prompt" },
];

function eventRowSurfaceClass(event: StageLogEvent): string {
  if (event.event === "waiting_for_input") return "bg-[#f5b54414]";
  if (event.event === "operator_prompt") return "bg-[#f5b5440f]";
  return "";
}

function eventKindClass(event: StageLogEvent): string {
  if (event.event === "waiting_for_input" || event.event === "operator_prompt") {
    return "text-[#f5b544]";
  }
  if (event.event === "agent_start") return "text-[#6ca6ff]";
  if (event.event === "message") return "text-[#ecedee]";
  return "text-[var(--sf-text-2)]";
}

function filterChipClass(active: boolean): string {
  const base =
    "rounded-md border border-[#ffffff12] px-2 py-1 text-xs leading-[1.33]";
  return active
    ? `${base} bg-[#1a1c21] text-[#ecedee]`
    : `${base} text-[#a7aab2] hover:text-[var(--sf-text-1)]`;
}

export function RunEventsPanel({
  events,
  stageId,
  live,
}: {
  events: StageLogEvent[];
  stageId: string;
  live: boolean;
}) {
  const [filter, setFilter] = useState<RunEventsKindFilter>("all");
  const [followTail, setFollowTail] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const filtered = filterStageEvents(events, filter);

  useEffect(() => {
    if (!followTail || !live) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, filter, followTail, live]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 pb-1">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={filterChipClass(filter === chip.id)}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-[#a7aab2]">
          Follow tail
          <button
            type="button"
            role="switch"
            aria-checked={followTail}
            className={`relative h-[18px] w-8 rounded-full transition-colors ${
              followTail ? "bg-[#6ca6ff]" : "bg-[#ffffff1a]"
            }`}
            onClick={() => setFollowTail((v) => !v)}
          >
            <span
              className={`absolute top-0.5 size-3.5 rounded-full bg-[#ecedee] transition-transform ${
                followTail ? "right-0.5" : "left-0.5"
              }`}
            />
          </button>
        </label>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="flex h-7 shrink-0 items-center gap-3 border-b border-b-[#ffffff12] px-2 font-['Geist_Mono',monospace] text-[11px] uppercase tracking-[1.28px] text-[#8b8f98]"
          role="row"
        >
          <span className="w-[72px] tracking-[0.88px]">Time</span>
          <span className="w-[120px] tracking-[0.88px]">Event</span>
          <span className="w-20 tracking-[0.88px]">Stage</span>
          <span className="min-w-0 flex-1 tracking-[0.88px]">Details</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {filtered.map((ev, i) => {
            const hitl =
              ev.event === "waiting_for_input" || ev.event === "operator_prompt";
            const surface = eventRowSurfaceClass(ev);
            const kindClass = eventKindClass(ev);
            return (
              <div
                key={`${ev.at ?? i}-${ev.event}-${i}`}
                className={`flex h-7 items-center gap-3 px-2 font-['Geist_Mono',monospace] text-xs leading-[1.33] ${surface}`}
                role="row"
              >
                <span
                  className={`w-[72px] shrink-0 ${
                    hitl ? "text-[#f5b544]" : "text-[#8b8f98]"
                  }`}
                >
                  {formatEventTime(ev.at)}
                </span>
                <span className={`w-[120px] shrink-0 truncate ${kindClass}`}>
                  {ev.event}
                </span>
                <span className="w-20 shrink-0 truncate text-[#ecedee]">
                  {stageId}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate ${
                    hitl && ev.event === "waiting_for_input"
                      ? "text-[#f5b544]"
                      : "text-[#a7aab2]"
                  }`}
                >
                  {eventRowDetails(ev)}
                </span>
              </div>
            );
          })}
        </div>
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-[13px] text-[var(--sf-text-3)]">
            No events match this filter.
          </p>
        ) : null}
      </div>
    </div>
  );
}
