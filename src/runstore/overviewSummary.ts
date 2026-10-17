import type { RunStatus } from "./port.js";

export const OVERVIEW_RANGES = ["24h", "7d", "30d"] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];

export function isOverviewRange(value: string): value is OverviewRange {
  return (OVERVIEW_RANGES as readonly string[]).includes(value);
}

const HOUR_MS = 3_600_000;

const RANGE_SHAPE: Record<OverviewRange, { windowMs: number; bucketMs: number }> = {
  "24h": { windowMs: 24 * HOUR_MS, bucketMs: 3 * HOUR_MS },
  "7d": { windowMs: 7 * 24 * HOUR_MS, bucketMs: 24 * HOUR_MS },
  "30d": { windowMs: 30 * 24 * HOUR_MS, bucketMs: 3 * 24 * HOUR_MS },
};

export function overviewWindowMs(range: OverviewRange): number {
  return RANGE_SHAPE[range].windowMs;
}

/** One run, as much as the overview needs; no stages. */
export type OverviewRunRow = {
  run_id: string;
  pipeline_id: string;
  status: RunStatus;
  created_at: string;
  finished_at?: string;
  cost_usd?: number;
};

export type OverviewTotals = {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  in_flight: number;
  /** succeeded + failed. Cancelled runs are neither a success nor a failure. */
  finished: number;
  success_rate: number | null;
  cost_usd: number;
};

export type OverviewBucket = {
  start: string;
  succeeded: number;
  failed: number;
  cancelled: number;
};

export type OverviewPipeline = {
  pipeline_id: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  success_rate: number | null;
  median_duration_ms: number | null;
  cost_usd: number;
  last_run_at: string;
};

export type OverviewSummary = {
  range: OverviewRange;
  generated_at: string;
  since: string;
  totals: OverviewTotals;
  previous: OverviewTotals;
  buckets: OverviewBucket[];
  pipelines: OverviewPipeline[];
};

function emptyTotals(): OverviewTotals {
  return {
    runs: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    in_flight: 0,
    finished: 0,
    success_rate: null,
    cost_usd: 0,
  };
}

function tally(rows: readonly OverviewRunRow[]): OverviewTotals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.runs += 1;
    if (row.status === "succeeded") totals.succeeded += 1;
    else if (row.status === "failed") totals.failed += 1;
    else if (row.status === "cancelled") totals.cancelled += 1;
    else totals.in_flight += 1;
    totals.cost_usd += row.cost_usd ?? 0;
  }
  totals.finished = totals.succeeded + totals.failed;
  totals.success_rate = totals.finished > 0 ? totals.succeeded / totals.finished : null;
  totals.cost_usd = roundCost(totals.cost_usd);
  return totals;
}

function roundCost(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function durationMs(row: OverviewRunRow): number | null {
  if (row.status !== "succeeded" && row.status !== "failed") return null;
  if (!row.finished_at) return null;
  const ms = Date.parse(row.finished_at) - Date.parse(row.created_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Rows must cover `[now - 2 * window, now]` by `created_at`; the older half feeds `previous`.
 * Buckets are rolling segments ending at `now`, so they need no time zone.
 */
export function buildOverview(
  rows: readonly OverviewRunRow[],
  range: OverviewRange,
  now: Date = new Date(),
): OverviewSummary {
  const { windowMs, bucketMs } = RANGE_SHAPE[range];
  const nowMs = now.getTime();
  const sinceMs = nowMs - windowMs;
  const previousSinceMs = sinceMs - windowMs;

  const current: OverviewRunRow[] = [];
  const previous: OverviewRunRow[] = [];
  for (const row of rows) {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created)) continue;
    if (created >= sinceMs && created <= nowMs) current.push(row);
    else if (created >= previousSinceMs && created < sinceMs) previous.push(row);
  }

  const bucketCount = windowMs / bucketMs;
  const buckets: OverviewBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: new Date(sinceMs + i * bucketMs).toISOString(),
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  }));
  for (const row of current) {
    const index = Math.min(bucketCount - 1, Math.floor((Date.parse(row.created_at) - sinceMs) / bucketMs));
    const bucket = buckets[index]!;
    if (row.status === "succeeded") bucket.succeeded += 1;
    else if (row.status === "failed") bucket.failed += 1;
    else if (row.status === "cancelled") bucket.cancelled += 1;
  }

  const byPipeline = new Map<string, OverviewRunRow[]>();
  for (const row of current) {
    const list = byPipeline.get(row.pipeline_id);
    if (list) list.push(row);
    else byPipeline.set(row.pipeline_id, [row]);
  }
  const pipelines: OverviewPipeline[] = [...byPipeline.entries()]
    .map(([pipeline_id, list]) => {
      const totals = tally(list);
      const durations = list.map(durationMs).filter((ms): ms is number => ms !== null);
      return {
        pipeline_id,
        runs: totals.runs,
        succeeded: totals.succeeded,
        failed: totals.failed,
        cancelled: totals.cancelled,
        success_rate: totals.success_rate,
        median_duration_ms: median(durations),
        cost_usd: totals.cost_usd,
        last_run_at: list.reduce((latest, row) => (row.created_at > latest ? row.created_at : latest), list[0]!.created_at),
      };
    })
    .sort((a, b) => b.runs - a.runs || a.pipeline_id.localeCompare(b.pipeline_id));

  return {
    range,
    generated_at: now.toISOString(),
    since: new Date(sinceMs).toISOString(),
    totals: tally(current),
    previous: tally(previous),
    buckets,
    pipelines,
  };
}
