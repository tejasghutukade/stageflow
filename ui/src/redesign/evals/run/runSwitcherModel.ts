import type { EvalActiveRun, EvalRunListItem } from "../../../api/evalTypes";
import { formatPercent, formatRelativeTime } from "../format";

export type SwitcherTone = "ok" | "fail" | "running" | "muted";

export type SwitcherRow = {
  runNumber: number;
  current: boolean;
  statusText: string;
  tone: SwitcherTone;
  /** Pass rate for finished runs, `done/total` for active ones. */
  metaText: string;
  timeText: string;
  label: string | null;
};

export function sortRunsNewestFirst<T extends { run_number: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.run_number - a.run_number);
}

function statusOf(item: EvalRunListItem): { text: string; tone: SwitcherTone } {
  switch (item.status) {
    case "queued":
      return { text: "Queued", tone: "running" };
    case "running":
      return { text: "Running", tone: "running" };
    case "completed":
      return item.passed ? { text: "Passed", tone: "ok" } : { text: "Below threshold", tone: "fail" };
    case "failed":
      return { text: "Failed", tone: "fail" };
    case "cancelled":
      return { text: "Stopped", tone: "muted" };
    case "budget_stopped":
      return { text: "Cost limit", tone: "muted" };
  }
}

export function switcherRows(items: readonly EvalRunListItem[], currentRunNumber: number, now = Date.now()): SwitcherRow[] {
  return sortRunsNewestFirst(items).map((item) => {
    const status = statusOf(item);
    const active = item.status === "queued" || item.status === "running";
    const total = item.results_total;
    return {
      runNumber: item.run_number,
      current: item.run_number === currentRunNumber,
      statusText: status.text,
      tone: status.tone,
      metaText: active
        ? total !== undefined && total > 0
          ? `${item.results_executed}/${total}`
          : "—"
        : formatPercent(item.pass_rate),
      timeText: formatRelativeTime(item.finished_at ?? item.started_at ?? item.created_at ?? null, now),
      label: item.label,
    };
  });
}

export function newestRunNumber(numbers: readonly number[]): number | null {
  return numbers.length === 0 ? null : Math.max(...numbers);
}

export type LandingTarget = { kind: "run"; runNumber: number } | { kind: "edit" };

/** Where opening an eval lands: the live run, else the newest run, else the editor. */
export function evalLandingTarget(input: {
  active_run?: EvalActiveRun | null;
  last_run: { run_number: number } | null;
  runs_count: number;
  newestRunNumber?: number | null;
}): LandingTarget {
  if (input.active_run) return { kind: "run", runNumber: input.active_run.run_number };
  if (input.runs_count > 0) {
    const newest = input.newestRunNumber ?? input.last_run?.run_number ?? null;
    if (newest !== null) return { kind: "run", runNumber: newest };
  }
  return { kind: "edit" };
}

export function activeRunText(active: EvalActiveRun): string {
  const progress = active.results_total > 0 ? ` · ${active.results_done}/${active.results_total}` : "";
  return `Run #${active.run_number} ${active.status === "queued" ? "queued" : "running"}${progress}`;
}
