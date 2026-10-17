import type { AgentSessionListItem } from "../../../api/agents";

export type SessionStatusView = { symbol: string; label: string; color: string };

/** How a session reads in a list: live state first, otherwise how its latest run ended. */
export function sessionStatusView(row: Pick<AgentSessionListItem, "status" | "lastTurnStatus">): SessionStatusView {
  if (row.status === "waiting") return { symbol: "●", label: "Waiting on you", color: "text-[var(--sf-needs)]" };
  if (row.status === "running") return { symbol: "●", label: "Running", color: "text-[var(--sf-running)]" };
  switch (row.lastTurnStatus) {
    case "succeeded":
      return { symbol: "✓", label: "Succeeded", color: "text-[var(--sf-ok)]" };
    case "failed":
      return { symbol: "×", label: "Failed", color: "text-[var(--sf-fail)]" };
    case "cancelled":
      return { symbol: "○", label: "Stopped", color: "text-[var(--sf-text-3)]" };
    default:
      return { symbol: "○", label: "No runs", color: "text-[var(--sf-text-3)]" };
  }
}
