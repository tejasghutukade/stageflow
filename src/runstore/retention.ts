import type { RunMeta, RunStatus } from "./port.js";

export type RetentionDecision = "none" | "slim" | "purge";

export type StatusRetentionWindow = {
  slimMs: number;
  purgeMs: number;
};

export type RetentionWindows = {
  succeeded: StatusRetentionWindow;
  failed: StatusRetentionWindow;
  cancelled: StatusRetentionWindow;
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Defaults: succeeded 3d/30d; failed and cancelled 30d/90d (R30 / AE6). */
export const DEFAULT_RETENTION_WINDOWS: RetentionWindows = {
  succeeded: { slimMs: 3 * DAY_MS, purgeMs: 30 * DAY_MS },
  cancelled: { slimMs: 30 * DAY_MS, purgeMs: 90 * DAY_MS },
  failed: { slimMs: 30 * DAY_MS, purgeMs: 90 * DAY_MS },
};

export const DEFAULT_BARE_CACHE_TTL_MS = 30 * DAY_MS;
export const DEFAULT_SLIM_ARTIFACT_MAX_BYTES = 1024 * 1024;

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export type RetentionRow = Pick<
  RunMeta,
  "status" | "finished_at" | "slimmed_at"
>;

function parsePositiveMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function windowFromEnv(
  env: NodeJS.ProcessEnv,
  status: keyof RetentionWindows,
  defaults: StatusRetentionWindow,
): StatusRetentionWindow {
  const statusKey = status.toUpperCase();
  return {
    slimMs:
      parsePositiveMs(env[`STAGEFLOW_SLIM_${statusKey}_MS`]) ?? defaults.slimMs,
    purgeMs:
      parsePositiveMs(env[`STAGEFLOW_PURGE_${statusKey}_MS`]) ??
      defaults.purgeMs,
  };
}

/** Resolve retention windows from KD1 defaults plus per-status env overrides. */
export function retentionWindowsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RetentionWindows {
  return {
    succeeded: windowFromEnv(env, "succeeded", DEFAULT_RETENTION_WINDOWS.succeeded),
    failed: windowFromEnv(env, "failed", DEFAULT_RETENTION_WINDOWS.failed),
    cancelled: windowFromEnv(env, "cancelled", DEFAULT_RETENTION_WINDOWS.cancelled),
  };
}

export function bareCacheTtlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parsePositiveMs(env.STAGEFLOW_BARE_CACHE_TTL_MS) ?? DEFAULT_BARE_CACHE_TTL_MS
  );
}

export function slimArtifactMaxBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    parsePositiveMs(env.STAGEFLOW_SLIM_ARTIFACT_MAX_BYTES) ??
    DEFAULT_SLIM_ARTIFACT_MAX_BYTES
  );
}

/**
 * Clock-injected eligibility. Reads `finished_at` only (KTD1), never `updated_at`.
 * Already-slimmed rows past SLIM but not PURGE return `"none"` (R18).
 */
export function retentionDecision(
  row: RetentionRow,
  now: Date,
  windows: RetentionWindows = DEFAULT_RETENTION_WINDOWS,
): RetentionDecision {
  const status = row.status;
  if (status === undefined || !TERMINAL.has(status)) return "none";
  if (row.finished_at === undefined || row.finished_at === "") return "none";

  const finishedMs = Date.parse(row.finished_at);
  if (!Number.isFinite(finishedMs)) return "none";

  const ageMs = now.getTime() - finishedMs;
  if (ageMs < 0) return "none";

  const window = windows[status as keyof RetentionWindows];
  if (ageMs >= window.purgeMs) return "purge";
  if (ageMs >= window.slimMs && row.slimmed_at === undefined) return "slim";
  return "none";
}

export function isTerminalRunStatus(
  status: RunStatus | undefined,
): status is "succeeded" | "failed" | "cancelled" {
  return status !== undefined && TERMINAL.has(status);
}
