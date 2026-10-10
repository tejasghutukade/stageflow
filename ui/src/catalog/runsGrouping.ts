import type { RunSummary } from "../api";

export type RunsDisplayFilter =
  | "all"
  | "waiting"
  | "running"
  | "failed"
  | "finished";

export type RunDisplayGroupId =
  | "needs_you"
  | "running"
  | "earlier_today"
  | "earlier";

export type RunDisplayGroup = {
  id: RunDisplayGroupId;
  label: string;
  runs: RunSummary[];
};

function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sortNewestFirst(runs: RunSummary[]): RunSummary[] {
  return runs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function filterByTab(
  runs: RunSummary[],
  filter: RunsDisplayFilter,
): RunSummary[] {
  if (filter === "all") return runs;
  if (filter === "waiting") {
    return runs.filter((r) => Boolean(r.waiting_stage_id));
  }
  if (filter === "running") {
    return runs.filter(
      (r) =>
        !r.waiting_stage_id &&
        (r.status === "running" || r.status === "created"),
    );
  }
  if (filter === "failed") {
    return runs.filter((r) => r.status === "failed");
  }
  return runs.filter((r) => r.status === "succeeded");
}

export function groupRunsForDisplay(
  runs: RunSummary[],
  filter: RunsDisplayFilter,
  now = Date.now(),
): RunDisplayGroup[] {
  const visible = sortNewestFirst(filterByTab(runs, filter));
  const todayStart = startOfLocalDay(now);

  const needsYou: RunSummary[] = [];
  const running: RunSummary[] = [];
  const earlierToday: RunSummary[] = [];
  const earlier: RunSummary[] = [];

  for (const run of visible) {
    if (run.waiting_stage_id) {
      needsYou.push(run);
      continue;
    }
    if (run.status === "running" || run.status === "created") {
      running.push(run);
      continue;
    }
    const created = Date.parse(run.created_at);
    if (created >= todayStart) {
      earlierToday.push(run);
    } else if (filter === "all") {
      earlier.push(run);
    } else {
      earlierToday.push(run);
    }
  }

  const groups: RunDisplayGroup[] = [];
  if (needsYou.length > 0) {
    groups.push({ id: "needs_you", label: "Needs you", runs: needsYou });
  }
  if (running.length > 0) {
    groups.push({ id: "running", label: "Running", runs: running });
  }
  if (earlierToday.length > 0) {
    groups.push({ id: "earlier_today", label: "Earlier today", runs: earlierToday });
  }
  if (earlier.length > 0) {
    groups.push({ id: "earlier", label: "Earlier", runs: earlier });
  }
  return groups;
}
