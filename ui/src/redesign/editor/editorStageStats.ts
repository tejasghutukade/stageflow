import type { RunDetail, RunSummary } from "../../api";

export type StageStats = {
  runs: number;
  avgMs?: number;
  avgCostUsd?: number;
  passRate?: number;
};

type StageAcc = {
  runs: number;
  succeeded: number;
  costSum: number;
  costCount: number;
};

function finiteMs(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return finiteMs(Date.parse(value));
}

function createdAtMs(run: RunSummary): number {
  return timestampMs(run.created_at) ?? Number.NEGATIVE_INFINITY;
}

export function summaryStageStats(
  runs: readonly RunSummary[],
): Map<string, StageStats> {
  const acc = new Map<string, StageAcc>();
  for (const run of runs) {
    const seen = new Set<string>();
    for (const stage of run.stages) {
      if (stage.status !== "succeeded" && stage.status !== "failed") continue;
      if (seen.has(stage.id)) continue;
      seen.add(stage.id);
      const row = acc.get(stage.id) ?? {
        runs: 0,
        succeeded: 0,
        costSum: 0,
        costCount: 0,
      };
      row.runs += 1;
      if (stage.status === "succeeded") row.succeeded += 1;
      if (stage.cost_usd !== undefined && Number.isFinite(stage.cost_usd)) {
        row.costSum += stage.cost_usd;
        row.costCount += 1;
      }
      acc.set(stage.id, row);
    }
  }
  const stats = new Map<string, StageStats>();
  for (const [id, row] of acc) {
    const next: StageStats = { runs: row.runs };
    if (row.runs > 0) next.passRate = row.succeeded / row.runs;
    if (row.costCount > 0) next.avgCostUsd = row.costSum / row.costCount;
    stats.set(id, next);
  }
  return stats;
}

export function runP50Ms(runs: readonly RunSummary[]): number | null {
  const samples: number[] = [];
  for (const run of runs) {
    if (run.status !== "succeeded" || run.finished_at == null) continue;
    const start = timestampMs(run.created_at);
    const end = timestampMs(run.finished_at);
    if (start == null || end == null) continue;
    const duration = end - start;
    if (!Number.isFinite(duration) || duration < 0) continue;
    samples.push(duration);
  }
  if (samples.length === 0) return null;
  samples.sort((left, right) => left - right);
  const mid = Math.floor(samples.length / 2);
  if (samples.length % 2 === 1) return samples[mid] ?? null;
  const lower = samples[mid - 1];
  const upper = samples[mid];
  if (lower == null || upper == null) return null;
  return (lower + upper) / 2;
}

export function stageDurationsFromDetail(
  detail: RunDetail,
): Map<string, number> {
  const durations = new Map<string, number>();
  for (const stage of detail.stages) {
    const times: number[] = [];
    for (const event of stage.events) {
      const at = timestampMs(event.at);
      if (at != null) times.push(at);
    }
    if (times.length < 2) continue;
    const duration = Math.max(...times) - Math.min(...times);
    if (!Number.isFinite(duration) || duration < 0) continue;
    durations.set(stage.stage_id, duration);
  }
  return durations;
}

export function mergeDurations(
  base: ReadonlyMap<string, StageStats>,
  durations: readonly ReadonlyMap<string, number>[],
): Map<string, StageStats> {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const map of durations) {
    for (const [id, ms] of map) {
      if (!Number.isFinite(ms) || ms < 0) continue;
      const row = sums.get(id) ?? { sum: 0, count: 0 };
      row.sum += ms;
      row.count += 1;
      sums.set(id, row);
    }
  }
  const merged = new Map<string, StageStats>();
  for (const [id, stats] of base) {
    merged.set(id, { ...stats });
  }
  for (const [id, row] of sums) {
    if (row.count === 0) continue;
    const avgMs = row.sum / row.count;
    const existing = merged.get(id);
    if (existing) {
      merged.set(id, { ...existing, avgMs });
    } else {
      merged.set(id, { runs: 0, avgMs });
    }
  }
  return merged;
}

export function recentTerminalRuns(
  runs: readonly RunSummary[],
  limit = 8,
): RunSummary[] {
  return runs
    .filter((run) => run.status === "succeeded" || run.status === "failed")
    .slice()
    .sort(
      (left, right) =>
        createdAtMs(right) - createdAtMs(left) ||
        left.run_id.localeCompare(right.run_id),
    )
    .slice(0, limit);
}
