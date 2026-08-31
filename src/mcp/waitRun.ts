import type { RunProjection } from "../projection/projectRun.js";
import type { RunStore } from "../runstore/port.js";
import { projectRunForMcp } from "./projectRun.js";

export type WaitUntil = "any" | "waiting" | "terminal";

export type WaitReason = "waiting" | "terminal" | "timeout" | "already";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 240_000;
export const POLL_INTERVAL_MS = 250;
export const PROGRESS_EVERY_MS = 2_000;

export type WaitRunProgressInfo = {
  progress: number;
  message: string;
};

export type WaitRunSuccess = {
  ok: true;
  reason: WaitReason;
  elapsed_ms: number;
  until: WaitUntil;
  run: RunProjection;
};

export type WaitRunFailure = {
  ok: false;
  error: string;
  status?: number;
  code?: string;
};

export type WaitRunResult = WaitRunSuccess | WaitRunFailure;

export type WaitRunOpts = {
  store: Pick<RunStore, "readRun">;
  runId: string;
  timeoutMs?: number;
  until?: WaitUntil;
  signal?: AbortSignal;
  onProgress?: (info: WaitRunProgressInfo) => void | Promise<void>;
};

export function clampTimeoutMs(
  timeoutMs: number | undefined,
): { ok: true; value: number } | { ok: false; error: string } {
  const value = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    return {
      ok: false,
      error: `timeout_ms must be in (0, ${MAX_TIMEOUT_MS}]`,
    };
  }
  return { ok: true, value };
}

export function isWaitingProjection(
  projection: Pick<
    RunProjection,
    "waiting_stage_ids" | "waiting_stage_id" | "stages"
  >,
): boolean {
  if (
    projection.waiting_stage_ids !== undefined &&
    projection.waiting_stage_ids.length > 0
  ) {
    return true;
  }
  if (projection.waiting_stage_id !== undefined) {
    return true;
  }
  return projection.stages.some((s) => s.status === "waiting_for_input");
}

export function isTerminalProjection(
  projection: Pick<RunProjection, "status">,
): boolean {
  return projection.status === "succeeded" || projection.status === "failed";
}

export function classifyWaitWake(
  projection: Pick<
    RunProjection,
    "status" | "waiting_stage_ids" | "waiting_stage_id" | "stages"
  >,
  until: WaitUntil,
  hadWaited: boolean,
): Exclude<WaitReason, "timeout"> | null {
  const waiting = isWaitingProjection(projection);
  const terminal = isTerminalProjection(projection);

  let matched: "waiting" | "terminal" | null = null;
  if (until === "waiting") {
    if (waiting) matched = "waiting";
    else if (terminal) matched = "terminal";
  } else if (until === "terminal") {
    if (terminal) matched = "terminal";
  } else if (waiting) {
    matched = "waiting";
  } else if (terminal) {
    matched = "terminal";
  }

  if (matched === null) return null;
  return hadWaited ? matched : "already";
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { code: "aborted" as const }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { code: "aborted" as const }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitRun(opts: WaitRunOpts): Promise<WaitRunResult> {
  const untilVal: WaitUntil = opts.until ?? "any";
  const clamped = clampTimeoutMs(opts.timeoutMs);
  if (!clamped.ok) {
    return { ok: false, error: clamped.error, status: 400 };
  }

  const signal = opts.signal;
  const started = Date.now();
  let hadWaited = false;
  let pollCount = 0;
  let lastProgressAt = 0;

  while (true) {
    if (signal?.aborted) {
      return { ok: false, error: "wait aborted", code: "aborted" };
    }

    let detail;
    try {
      detail = await opts.store.readRun(opts.runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = /not found|no such|unknown run/i.test(message);
      return {
        ok: false,
        error: message,
        status: notFound ? 404 : 500,
      };
    }

    const run = projectRunForMcp(detail);
    const wake = classifyWaitWake(run, untilVal, hadWaited);
    const elapsed_ms = Date.now() - started;
    if (wake !== null) {
      return {
        ok: true,
        reason: wake,
        elapsed_ms,
        until: untilVal,
        run,
      };
    }

    if (elapsed_ms >= clamped.value) {
      return {
        ok: true,
        reason: "timeout",
        elapsed_ms,
        until: untilVal,
        run,
      };
    }

    if (
      opts.onProgress &&
      elapsed_ms - lastProgressAt >= PROGRESS_EVERY_MS
    ) {
      try {
        const maybe = opts.onProgress({
          progress: pollCount,
          message: `waiting until=${untilVal} elapsed_ms=${elapsed_ms}`,
        });
        void Promise.resolve(maybe).catch(() => {});
      } catch {
      }
      lastProgressAt = elapsed_ms;
    }

    const remaining = clamped.value - elapsed_ms;
    const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
    try {
      await sleepAbortable(sleepMs, signal);
    } catch {
      return { ok: false, error: "wait aborted", code: "aborted" };
    }
    hadWaited = true;
    pollCount += 1;
  }
}
