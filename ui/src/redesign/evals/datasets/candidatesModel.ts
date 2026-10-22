import type { EvalSessionCandidate } from "../../../api/evalTypes";

export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export function addRunsLabel(count: number): string {
  return count === 0 ? "Add cases" : `Add ${count} ${count === 1 ? "case" : "cases"}`;
}

export function addSessionsLabel(count: number): string {
  return count === 0 ? "Add scenarios" : `Use ${count} ${count === 1 ? "session" : "sessions"} as scenarios`;
}

export function sessionMeta(item: Pick<EvalSessionCandidate, "turns" | "tools">): string {
  const turns = `${item.turns} ${item.turns === 1 ? "turn" : "turns"}`;
  return item.tools.length > 0 ? `${turns} · tools ${item.tools.join(", ")}` : turns;
}

export const NO_SESSIONS = "No finished sessions of this agent yet.";
