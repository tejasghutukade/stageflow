import type { RunSummary, StageLogEvent } from "../../api";

export type FailedSortOrder = "newest" | "oldest";

const HIDDEN_INBOX_ACTIVITY_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "tool_progress",
]);

export function isInterruptedFailedRun(run: RunSummary): boolean {
  const stageId = run.failed_stage_id;
  if (stageId) {
    const compact = run.stages.find((s) => s.id === stageId);
    if (compact?.status === "interrupted") return true;
  }
  const reason = run.failed_reason ?? "";
  if (reason.includes("process_interrupted")) return true;
  return /\binterrupted\b/i.test(reason);
}

export function sortFailedRuns(
  runs: RunSummary[],
  order: "newest" | "oldest",
): RunSummary[] {
  const sorted = runs.slice().sort((a, b) => {
    const aAt = a.updated_at ?? a.created_at;
    const bAt = b.updated_at ?? b.created_at;
    return aAt.localeCompare(bAt);
  });
  return order === "newest" ? sorted.reverse() : sorted;
}

export function flattenFailedQueue(partition: {
  interrupted: RunSummary[];
  other: RunSummary[];
}): RunSummary[] {
  return [...partition.interrupted, ...partition.other];
}

export function partitionFailedRuns(runs: RunSummary[]): {
  interrupted: RunSummary[];
  other: RunSummary[];
} {
  const interrupted: RunSummary[] = [];
  const other: RunSummary[] = [];
  for (const run of runs) {
    if (isInterruptedFailedRun(run)) {
      interrupted.push(run);
    } else {
      other.push(run);
    }
  }
  return { interrupted, other };
}

export function isDisplayableFailedStageEvent(event: StageLogEvent): boolean {
  if (HIDDEN_INBOX_ACTIVITY_EVENTS.has(event.event)) return false;
  if (event.event === "message" && !event.text?.trim()) return false;
  return true;
}

export function lastDisplayableFailedStageEvents(
  events: StageLogEvent[],
  limit = 12,
): StageLogEvent[] {
  const displayable = events.filter(isDisplayableFailedStageEvent);
  return displayable.slice(-limit);
}
