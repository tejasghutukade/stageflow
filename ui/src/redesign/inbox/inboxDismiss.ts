import type { RunSummary } from "../../api";

export const INBOX_DISMISSED_FAILED_KEY = "sf-inbox-dismissed-failed";

function readDismissedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(INBOX_DISMISSED_FAILED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function writeDismissedIds(ids: Set<string>): void {
  localStorage.setItem(INBOX_DISMISSED_FAILED_KEY, JSON.stringify([...ids]));
}

export function getDismissedFailedRunIds(): ReadonlySet<string> {
  return readDismissedIds();
}

export function dismissFailedRun(runId: string): void {
  const ids = readDismissedIds();
  ids.add(runId);
  writeDismissedIds(ids);
}

export function filterDismissedFailed(runs: RunSummary[]): RunSummary[] {
  const dismissed = readDismissedIds();
  return runs.filter((run) => !dismissed.has(run.run_id));
}
