import type { RunSummary } from "../../api";
import { relativeTime } from "../../catalogJoin";
import type { RunDisplayGroupId } from "../../catalog/runsGrouping";

export function formatRunsListStarted(
  run: RunSummary,
  groupId: RunDisplayGroupId | undefined,
  now: number,
): string {
  if (groupId === "earlier_today" || groupId === "earlier") {
    const t = Date.parse(run.created_at);
    if (!Number.isFinite(t)) return "—";
    return new Date(t).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  }
  const rel = relativeTime(run.created_at, now);
  if (rel === "just now") return rel;
  return `${rel} ago`;
}
