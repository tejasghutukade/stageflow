import type { ListRunStatsFilter, RunStatRow, RunStatus, RunStore } from "./port.js";

export const RUN_STATS_DAY_CAP = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RUN_STATS_WEEK_CAP = 104;
export const RUN_STATS_PIPELINE_CAP = 50;
export const RUN_STATS_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const RUN_STATUSES: readonly RunStatus[] = ["created", "queued", "running", "succeeded", "failed", "cancelled"];

export type RunStatsGroupBy = "day" | "week" | "pipeline";

export type RunStatusCounts = Record<RunStatus, number>;

export type RunStatsBucket = {
  key: string;
  label: string;
  total: number;
  by_status: RunStatusCounts;
};

export type RunStatsResult = {
  since: string;
  until: string;
  group_by: RunStatsGroupBy;
  timezone: string;
  total: number;
  by_status: RunStatusCounts;
  buckets: RunStatsBucket[];
  capped?: true;
  cap_note?: string;
};

export type RunStatsQuery = {
  since?: string;
  until?: string;
  group_by?: RunStatsGroupBy;
  pipeline?: string;
  status?: RunStatus;
  timezone?: string;
};

type Ymd = { year: number; month: number; day: number };

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function emptyStatusCounts(): RunStatusCounts {
  return { created: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function ymdKey(date: Ymd): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function compareYmd(a: Ymd, b: Ymd): number {
  return ymdKey(a) < ymdKey(b) ? -1 : ymdKey(a) > ymdKey(b) ? 1 : 0;
}

function addCalendarDays(date: Ymd, days: number): Ymd {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function zonedDate(ms: number, timeZone: string): { ymd: Ymd; weekday: number } | undefined {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(ms));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const weekday = WEEKDAY_INDEX[value("weekday")];
  if (!year || !month || !day || weekday === undefined) return undefined;
  return { ymd: { year, month, day }, weekday };
}

function mondayOf(date: Ymd, weekday: number): Ymd {
  const sinceMonday = weekday === 0 ? 6 : weekday - 1;
  return addCalendarDays(date, -sinceMonday);
}

function bump(counts: RunStatusCounts, status: string): void {
  if ((RUN_STATUSES as readonly string[]).includes(status)) counts[status as RunStatus] += 1;
}

function bucketOf(key: string, label: string): RunStatsBucket {
  return { key, label, total: 0, by_status: emptyStatusCounts() };
}

function addRow(bucket: RunStatsBucket, status: string): void {
  bucket.total += 1;
  bump(bucket.by_status, status);
}

function totalsFrom(buckets: readonly RunStatsBucket[]): { total: number; by_status: RunStatusCounts } {
  const by_status = emptyStatusCounts();
  let total = 0;
  for (const bucket of buckets) {
    total += bucket.total;
    for (const status of RUN_STATUSES) by_status[status] += bucket.by_status[status];
  }
  return { total, by_status };
}

function eachDay(start: Ymd, end: Ymd): Ymd[] {
  const days: Ymd[] = [];
  let cursor = start;
  while (compareYmd(cursor, end) <= 0) {
    days.push(cursor);
    cursor = addCalendarDays(cursor, 1);
    if (days.length > 20000) break;
  }
  return days;
}

export function buildRunStats(
  rows: readonly RunStatRow[],
  input: {
    since: string;
    until: string;
    group_by: RunStatsGroupBy;
    timezone: string;
  },
): RunStatsResult {
  const base = {
    since: input.since,
    until: input.until,
    group_by: input.group_by,
    timezone: input.timezone,
  };
  if (input.group_by === "pipeline") {
    const grouped = new Map<string, RunStatsBucket>();
    for (const row of rows) {
      const key = row.pipeline_id;
      const bucket = grouped.get(key) ?? bucketOf(key, key);
      addRow(bucket, row.status);
      grouped.set(key, bucket);
    }
    const sorted = [...grouped.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    let buckets = sorted;
    let capped = false;
    if (sorted.length > RUN_STATS_PIPELINE_CAP) {
      capped = true;
      const kept = sorted.slice(0, RUN_STATS_PIPELINE_CAP);
      const other = bucketOf("other", "Other");
      for (const bucket of sorted.slice(RUN_STATS_PIPELINE_CAP)) {
        other.total += bucket.total;
        for (const status of RUN_STATUSES) other.by_status[status] += bucket.by_status[status];
      }
      buckets = [...kept, other];
    }
    const sums = totalsFrom(buckets);
    return {
      ...base,
      ...sums,
      buckets,
      ...(capped
        ? { capped: true as const, cap_note: `Showing the ${RUN_STATS_PIPELINE_CAP} pipelines with the most runs. The rest are in "other".` }
        : {}),
    };
  }

  const sinceMs = Date.parse(input.since);
  const untilMs = Date.parse(input.until);
  const sinceZoned = zonedDate(sinceMs, input.timezone);
  const untilZoned = zonedDate(untilMs, input.timezone);
  if (!sinceZoned || !untilZoned) {
    return { ...base, total: 0, by_status: emptyStatusCounts(), buckets: [] };
  }
  const days = eachDay(sinceZoned.ymd, untilZoned.ymd);
  const cap = input.group_by === "week" ? RUN_STATS_WEEK_CAP : RUN_STATS_DAY_CAP;
  if (input.group_by === "day") {
    const keptDays = days.length > cap ? days.slice(days.length - cap) : days;
    const buckets = keptDays.map((day) => bucketOf(ymdKey(day), ymdKey(day)));
    const index = new Map(buckets.map((bucket, i) => [bucket.key, i]));
    for (const row of rows) {
      const zoned = zonedDate(Date.parse(row.created_at), input.timezone);
      if (!zoned) continue;
      const bucket = buckets[index.get(ymdKey(zoned.ymd)) ?? -1];
      if (bucket) addRow(bucket, row.status);
    }
    const sums = totalsFrom(buckets);
    const capped = days.length > cap;
    return {
      ...base,
      ...sums,
      buckets,
      ...(capped
        ? { capped: true as const, cap_note: `Showing the latest ${cap} day buckets. Earlier days in the window are omitted.` }
        : {}),
    };
  }

  const weekKeys: string[] = [];
  const seen = new Set<string>();
  for (const day of days) {
    const weekday = zonedDate(Date.parse(`${ymdKey(day)}T12:00:00.000Z`), "UTC");
    const monday = mondayOf(day, weekday?.weekday ?? 0);
    const key = ymdKey(monday);
    if (seen.has(key)) continue;
    seen.add(key);
    weekKeys.push(key);
  }
  const keptWeeks = weekKeys.length > cap ? weekKeys.slice(weekKeys.length - cap) : weekKeys;
  const buckets = keptWeeks.map((key) => bucketOf(key, `Week of ${key}`));
  const index = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  const firstKept = keptWeeks[0];
  for (const row of rows) {
    const zoned = zonedDate(Date.parse(row.created_at), input.timezone);
    if (!zoned) continue;
    const key = ymdKey(mondayOf(zoned.ymd, zoned.weekday));
    if (firstKept !== undefined && key < firstKept) continue;
    const bucket = buckets[index.get(key) ?? -1];
    if (bucket) addRow(bucket, row.status);
  }
  const sums = totalsFrom(buckets);
  const capped = weekKeys.length > cap;
  return {
    ...base,
    ...sums,
    buckets,
    ...(capped
      ? { capped: true as const, cap_note: `Showing the latest ${cap} week buckets. Earlier weeks in the window are omitted. A week key is the Monday of that week.` }
      : {}),
  };
}

export function parseRunStatsQuery(
  query: RunStatsQuery,
  now: Date,
): { ok: true; since: string; until: string; group_by: RunStatsGroupBy; timezone: string; filter: ListRunStatsFilter } | { ok: false; message: string } {
  const timezone = query.timezone?.trim() || "UTC";
  if (!isValidTimeZone(timezone)) return { ok: false, message: "timezone must be a valid IANA name, or omit it for UTC" };
  const untilMs = query.until === undefined ? now.getTime() : Date.parse(query.until);
  const sinceMs = query.since === undefined ? untilMs - RUN_STATS_DEFAULT_WINDOW_MS : Date.parse(query.since);
  if (!Number.isFinite(sinceMs)) return { ok: false, message: "since must be a valid date" };
  if (!Number.isFinite(untilMs)) return { ok: false, message: "until must be a valid date" };
  if (sinceMs > untilMs) return { ok: false, message: "since must be at or before until" };
  const group_by = query.group_by ?? "day";
  // Day and week buckets keep only the latest cap; read no further back than one bucket past it, so an "all time"
  // window still ends at until and the cap note applies.
  const spanCapMs =
    group_by === "day" ? (RUN_STATS_DAY_CAP + 1) * DAY_MS : group_by === "week" ? (RUN_STATS_WEEK_CAP + 1) * 7 * DAY_MS : Number.POSITIVE_INFINITY;
  const clampedSinceMs = Math.max(sinceMs, untilMs - spanCapMs);
  const since = new Date(clampedSinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  const filter: ListRunStatsFilter = { since, until };
  if (query.status !== undefined) filter.status = query.status;
  if (query.pipeline !== undefined && query.pipeline.trim().length > 0) filter.pipeline = query.pipeline.trim();
  return { ok: true, since, until, group_by, timezone, filter };
}

export async function collectRunStats(store: RunStore, query: RunStatsQuery, now: Date = new Date()): Promise<
  { ok: true; value: RunStatsResult } | { ok: false; message: string }
> {
  const parsed = parseRunStatsQuery(query, now);
  if (!parsed.ok) return parsed;
  const rows = await store.listRunStatRows(parsed.filter);
  return {
    ok: true,
    value: buildRunStats(rows, {
      since: parsed.since,
      until: parsed.until,
      group_by: parsed.group_by,
      timezone: parsed.timezone,
    }),
  };
}
