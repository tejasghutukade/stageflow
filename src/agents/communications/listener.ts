import type { AgentInboundMessage } from "./port.js";

/** A stream the Host holds open to a provider so messages arrive without a public URL. */
export type ChannelListener = {
  /** Resolves once the first connection attempt has been made; it keeps itself connected until `stop`. */
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): ListenerState;
};

export type ListenerState = {
  status: "starting" | "connected" | "reconnecting" | "failed" | "stopped";
  since: string;
  /** Last failure, never a secret. */
  error?: string;
  /** Messages handed to the agents since the listener started. */
  received: number;
};

export type ListenerDeps = {
  onMessage(message: AgentInboundMessage): Promise<void>;
  log(message: string): void;
  now?: () => number;
  /** Test seam: waits between reconnect attempts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export const RECONNECT_MIN_MS = 2_000;
export const RECONNECT_MAX_MS = 60_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 10));
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Tracks a listener's state for the console. */
export class StateTracker {
  private current: ListenerState;
  constructor(private readonly now: () => number = Date.now) {
    this.current = { status: "starting", since: new Date(now()).toISOString(), received: 0 };
  }
  set(status: ListenerState["status"], error?: string): void {
    this.current = { ...this.current, status, since: new Date(this.now()).toISOString(), ...(error !== undefined ? { error } : {}) };
    if (error === undefined && status !== "failed" && status !== "reconnecting") delete this.current.error;
  }
  received(): void {
    this.current = { ...this.current, received: this.current.received + 1 };
  }
  get(): ListenerState {
    return { ...this.current };
  }
}
