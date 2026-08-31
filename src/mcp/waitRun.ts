import type { RunProjection } from "../projection/projectRun.js";

export type WaitUntil = "any" | "waiting" | "terminal";

export type WaitReason = "waiting" | "terminal" | "timeout" | "already";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 240_000;
export const POLL_INTERVAL_MS = 250;
export const PROGRESS_EVERY_MS = 2_000;

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
