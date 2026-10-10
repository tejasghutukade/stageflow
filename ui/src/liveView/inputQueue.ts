import type { LiveViewInput } from "./types";

export type QueueNotice = "rejected" | "overflow" | "network";
export type QueueStopReason = "closed" | "unauthorized";

export type InputQueueDeps = {
  post(batch: LiveViewInput[]): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
  refreshSession(): Promise<boolean>;
  onNotice(notice: QueueNotice): void;
  onStopped(reason: QueueStopReason): void;
  maxBatch?: number;
  eventsPerSecond?: number;
  retryDelayMs?: number;
  maxQueued?: number;
};

export type InputQueue = {
  push(event: LiveViewInput): void;
  stop(): void;
  idle(): Promise<void>;
};

export const DEFAULT_MAX_BATCH = 64;
export const DEFAULT_EVENTS_PER_SECOND = 400;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_MAX_QUEUED = 4096;

export function createInputQueue(deps: InputQueueDeps): InputQueue {
  const maxBatch = deps.maxBatch ?? DEFAULT_MAX_BATCH;
  const rate = deps.eventsPerSecond ?? DEFAULT_EVENTS_PER_SECOND;
  const retryDelay = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  let pending: LiveViewInput[] = [];
  let running: Promise<void> | undefined;
  let stopped = false;
  let nextAllowedAt = 0;
  let overflowReported = false;

  function stopWith(reason: QueueStopReason): void {
    if (stopped) return;
    stopped = true;
    pending = [];
    deps.onStopped(reason);
  }

  async function sendBatch(batch: LiveViewInput[]): Promise<void> {
    let refreshed = false;
    for (;;) {
      if (stopped) return;
      const wait = nextAllowedAt - deps.now();
      if (wait > 0) await deps.sleep(wait);
      if (stopped) return;
      const start = deps.now();
      nextAllowedAt = start + (batch.length * 1000) / rate;
      let status: number;
      try {
        status = await deps.post(batch);
      } catch {
        deps.onNotice("network");
        return;
      }
      if (status >= 200 && status < 300) return;
      if (status === 429) {
        await deps.sleep(retryDelay);
        continue;
      }
      if (status === 400 || status === 413) {
        deps.onNotice("rejected");
        return;
      }
      if (status === 409) {
        stopWith("closed");
        return;
      }
      if (status === 401 || status === 403) {
        if (!refreshed) {
          refreshed = true;
          let ok = false;
          try {
            ok = await deps.refreshSession();
          } catch {
            ok = false;
          }
          if (ok) continue;
        }
        stopWith("unauthorized");
        return;
      }
      deps.onNotice("rejected");
      return;
    }
  }

  async function drain(): Promise<void> {
    while (!stopped && pending.length > 0) {
      const batch = pending.splice(0, maxBatch);
      await sendBatch(batch);
    }
  }

  function kick(): void {
    if (running !== undefined || stopped) return;
    running = drain().finally(() => {
      running = undefined;
      if (!stopped && pending.length > 0) kick();
    });
  }

  return {
    push(event) {
      if (stopped) return;
      const last = pending[pending.length - 1];
      if (
        event.type === "input_mouse" &&
        event.eventType === "mouseMoved" &&
        last?.type === "input_mouse" &&
        last.eventType === "mouseMoved"
      ) {
        pending[pending.length - 1] = event;
      } else if (pending.length >= maxQueued) {
        if (!overflowReported) {
          overflowReported = true;
          deps.onNotice("overflow");
        }
        return;
      } else {
        pending.push(event);
        overflowReported = false;
      }
      kick();
    },
    stop() {
      stopped = true;
      pending = [];
    },
    async idle() {
      while (running !== undefined) await running;
    },
  };
}
