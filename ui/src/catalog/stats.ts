import type { RunSummary } from "../api";

export function startOfLocalWeek(now = Date.now()): number {
  const d = new Date(now);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

export function countRunsThisWeek(runs: RunSummary[], now = Date.now()): number {
  const weekStart = startOfLocalWeek(now);
  return runs.filter((run) => Date.parse(run.created_at) >= weekStart).length;
}

export function sumRunListCostUsd(runs: RunSummary[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const run of runs) {
    if (run.total_cost_usd !== undefined) {
      sum += run.total_cost_usd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

export type RunListFooterStats = {
  runCount: number;
  costUsd: number | undefined;
};

export function runListFooterStats(runs: RunSummary[]): RunListFooterStats {
  return {
    runCount: runs.length,
    costUsd: sumRunListCostUsd(runs),
  };
}

function runDurationMs(run: RunSummary): number | undefined {
  const start = Date.parse(run.created_at);
  const endRaw = run.finished_at ?? run.updated_at;
  if (!endRaw) return undefined;
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

export function aggregatePipelineStats(
  runs: RunSummary[],
  pipelineId: string,
  limit = 20,
): {
  sampleCount: number;
  avgCostUsd: number | undefined;
  avgDurationMs: number | undefined;
} {
  const sample = runs
    .filter((r) => r.pipeline_id === pipelineId && r.status === "succeeded")
    .sort((a, b) => {
      const aRaw = a.finished_at ?? a.updated_at ?? a.created_at;
      const bRaw = b.finished_at ?? b.updated_at ?? b.created_at;
      return Date.parse(bRaw) - Date.parse(aRaw);
    })
    .slice(0, limit);
  const costUsd = sumRunListCostUsd(sample);
  const durations = sample
    .map(runDurationMs)
    .filter((ms): ms is number => ms != null);
  const avgDurationMs =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : undefined;
  return {
    sampleCount: sample.length,
    avgCostUsd:
      costUsd !== undefined && sample.length > 0
        ? costUsd / sample.length
        : undefined,
    avgDurationMs,
  };
}

export function formatApproxDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `~${min}m`;
  const h = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `~${h}h ${rm}m` : `~${h}h`;
}

export function formatApproxCost(usd: number): string {
  if (usd < 0.01) return "~<$0.01";
  return `~$${usd.toFixed(2)}`;
}

export function lastRunAtForTask(
  runs: RunSummary[],
  taskPath: string,
): string | undefined {
  let best: string | undefined;
  for (const run of runs) {
    if (run.task_id !== taskPath && run.task_path !== taskPath) continue;
    const at = run.updated_at ?? run.created_at;
    if (!best || at.localeCompare(best) > 0) best = at;
  }
  return best;
}
