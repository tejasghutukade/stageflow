import { LIVE_REFRESH_MIN_SECONDS } from "./limits.js";
import type { LiveRefresh } from "./manifest.js";

/** Used when a live manifest omits `refresh.ttl_seconds`. */
export const DEFAULT_LIVE_TTL_SECONDS = 300;

/** Sent on `artifact.resource_limit` so clients can back off. */
export const REFRESH_RETRY_AFTER_SECONDS = 30;

export type ArtifactSnapshotSource = "cache" | "executed";

export function effectiveTtlSeconds(refresh: LiveRefresh | undefined): number {
  const ttl = refresh?.ttl_seconds;
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) return DEFAULT_LIVE_TTL_SECONDS;
  return Math.max(LIVE_REFRESH_MIN_SECONDS, ttl);
}

export function snapshotNeedsRefresh(
  snapshot: { status: string; error_code: string | null; fetched_at: string } | undefined,
  nowIso: string,
  ttlSeconds: number,
): boolean {
  if (!snapshot) return true;
  if (snapshot.status !== "ok" || snapshot.error_code) return true;
  const fetched = Date.parse(snapshot.fetched_at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(fetched) || !Number.isFinite(now)) return true;
  return now - fetched > ttlSeconds * 1000;
}

export function refreshHttpStatus(result: {
  errors: ReadonlyArray<{ code: string }>;
  snapshots: ReadonlyArray<{ status: string }>;
}): 200 | 503 {
  const limited = result.errors.some((error) => error.code === "artifact.resource_limit");
  if (!limited) return 200;
  return result.snapshots.some((snapshot) => snapshot.status === "ok") ? 200 : 503;
}
