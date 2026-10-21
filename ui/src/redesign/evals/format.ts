import { relativeTime } from "../../catalogJoin";

const MINUS = "−";

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return "—";
  return score.toFixed(2);
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "< $0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 59_950) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  const whole = Math.round(ms / 1000);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
}

function trimTenth(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return "—";
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${trimTenth(count / 1000)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trimTenth(count / 1_000_000)}M`;
}

export function formatPoints(points: number | null | undefined): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return "—";
  const rounded = Math.round(Math.abs(points) * 10) / 10;
  if (rounded === 0) return "0.0 pts";
  return `${points > 0 ? "+" : MINUS}${rounded.toFixed(1)} pts`;
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  return relativeTime(iso, now);
}
