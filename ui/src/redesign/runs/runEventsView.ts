import type { StageLogEvent } from "../../api";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../../status/activityCopy";

export function uniqueEventKinds(events: StageLogEvent[]): string[] {
  const kinds = new Set<string>();
  for (const ev of events) {
    if (ev.event) kinds.add(ev.event);
  }
  return [...kinds].sort();
}

export function filterEventsByKinds(
  events: StageLogEvent[],
  activeKinds: ReadonlySet<string> | null,
): StageLogEvent[] {
  if (!activeKinds || activeKinds.size === 0) return events;
  return events.filter((ev) => activeKinds.has(ev.event));
}

export function formatEventTime(at?: string): string {
  if (!at) return "—";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export type EventRowModel = {
  id: string;
  at?: string;
  timeLabel: string;
  kind: string;
  label: string;
  detail?: string;
};

export function buildEventRows(events: StageLogEvent[]): EventRowModel[] {
  return events.map((ev, index) => ({
    id: `${ev.event}-${ev.at ?? index}-${index}`,
    at: ev.at,
    timeLabel: formatEventTime(ev.at),
    kind: ev.event,
    label: formatActivityLabel(ev),
    detail: formatActivityDescription(ev),
  }));
}
