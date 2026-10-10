import { formatRunShortTimestamp } from "../catalogJoin";
import { formatCostUsd } from "../components/CostBadge";

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function runDurationMs(
  createdAt: string,
  finishedAt: string | undefined,
  updatedAt: string | undefined,
  now = Date.now(),
): number {
  const start = Date.parse(createdAt);
  const end = finishedAt
    ? Date.parse(finishedAt)
    : updatedAt
      ? Date.parse(updatedAt)
      : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function formatRunDuration(
  createdAt: string,
  finishedAt: string | undefined,
  updatedAt: string | undefined,
  now = Date.now(),
): string {
  return formatDurationMs(
    runDurationMs(createdAt, finishedAt, updatedAt, now),
  );
}

export function formatRunCost(costUsd: number | undefined): string {
  return formatCostUsd(costUsd) ?? "—";
}

export function formatStartedTime(iso: string): string {
  return formatRunShortTimestamp(iso);
}
