import { useEffect, useState } from "react";

export type TimeInput = number | string | Date;

export function toEpochMs(at: TimeInput): number {
  if (typeof at === "number") return at;
  if (at instanceof Date) return at.getTime();
  return Date.parse(at);
}

export function formatAgo(at: TimeInput, now: number = Date.now()): string {
  const then = toEpochMs(at);
  if (!Number.isFinite(then)) return "";
  const sec = Math.floor(Math.max(0, now - then) / 1000);
  if (sec < 2) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function useNow(intervalMs = 5000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
