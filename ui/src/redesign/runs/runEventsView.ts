import type { StageLogEvent } from "../../api";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../../status/activityCopy";

export type RunEventsKindFilter =
  | "all"
  | "tool"
  | "message"
  | "operator_prompt";

const TOOL_KINDS = new Set([
  "tool_start",
  "tool_end",
  "tool_progress",
]);

export function eventMatchesKindFilter(
  event: StageLogEvent,
  filter: RunEventsKindFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "tool") return TOOL_KINDS.has(event.event);
  if (filter === "message") return event.event === "message";
  if (filter === "operator_prompt") {
    return (
      event.event === "operator_prompt" ||
      event.event === "operator_answer" ||
      event.event === "waiting_for_input"
    );
  }
  return true;
}

export function filterStageEvents(
  events: StageLogEvent[],
  filter: RunEventsKindFilter,
): StageLogEvent[] {
  return events.filter((ev) => eventMatchesKindFilter(ev, filter));
}

export function formatEventTime(at: string | undefined): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

export function eventRowLabel(event: StageLogEvent): string {
  return formatActivityLabel(event);
}

export function eventRowDetails(event: StageLogEvent): string {
  const detail = formatActivityDescription(event);
  if (detail) return detail;
  if (event.text) return event.text;
  return event.event;
}
