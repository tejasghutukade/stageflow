import { ChannelError, type ChannelErrorCode } from "./errors.js";
import type { ChannelRegistry } from "./registry.js";
import type { ConnectionHealth } from "./types.js";

export type ChannelHealthOptions = {
  registry: ChannelRegistry;
  intervalMs?: number;
  jitter?: number;
  timeoutMs?: number;
  maxBackoffFactor?: number;
  random?: () => number;
  onResult?: (connectionId: string, health: ConnectionHealth) => void;
};

export const DEFAULT_HEALTH_INTERVAL_MS = 300000;

function failed(code: ChannelErrorCode, retryable: boolean): ConnectionHealth {
  return { state: "failed", checkedAt: new Date().toISOString(), error: { code, retryable } };
}

/**
 * Host-only background check. It keeps the last result per connection in memory so the
 * Connections page can show current status. It never sends a message and keeps no secrets.
 * Failures back off up to `maxBackoffFactor` times the interval; successes return to it.
 */
export class ChannelHealthMonitor {
  private readonly registry: ChannelRegistry;
  private readonly intervalMs: number;
  private readonly jitter: number;
  private readonly timeoutMs: number;
  private readonly maxBackoffFactor: number;
  private readonly random: () => number;
  private readonly onResult?: (connectionId: string, health: ConnectionHealth) => void;
  private readonly results = new Map<string, ConnectionHealth>();
  private readonly failures = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<void>>();
  private controller = new AbortController();
  private running = false;

  constructor(options: ChannelHealthOptions) {
    this.registry = options.registry;
    this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.jitter = options.jitter ?? 0.2;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxBackoffFactor = options.maxBackoffFactor ?? 8;
    this.random = options.random ?? Math.random;
    this.onResult = options.onResult;
  }

  snapshot(): Record<string, ConnectionHealth> {
    return Object.fromEntries([...this.results].map(([id, health]) => [id, structuredClone(health)]));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    for (const connection of this.registry.list()) {
      if (connection.enabled) this.schedule(connection.id, Math.floor(this.random() * 2000));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.inflight]);
  }

  /** Runs one check now, outside the schedule. */
  async checkNow(connectionId: string): Promise<ConnectionHealth> {
    const health = await this.runCheck(connectionId);
    this.results.set(connectionId, health);
    this.onResult?.(connectionId, structuredClone(health));
    return structuredClone(health);
  }

  private schedule(id: string, delay: number): void {
    if (!this.running) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const work = this.checkNow(id).then(health => {
        const count = health.state === "ok" ? 0 : (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, count);
        this.schedule(id, this.nextDelay(count));
      }).finally(() => { this.inflight.delete(work); });
      this.inflight.add(work);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private nextDelay(failureCount: number): number {
    const factor = Math.min(2 ** failureCount, this.maxBackoffFactor);
    const base = this.intervalMs * (failureCount === 0 ? 1 : factor);
    return Math.round(base * (1 + (this.random() * 2 - 1) * this.jitter));
  }

  private async runCheck(id: string): Promise<ConnectionHealth> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const provider = this.registry.providerFor(id);
      const connection = this.registry.resolve(id);
      const timeout = new Promise<ConnectionHealth>(resolve => {
        timer = setTimeout(() => resolve(failed("CHANNEL_TIMEOUT", true)), this.timeoutMs);
      });
      return await Promise.race([provider.check(connection, this.controller.signal), timeout]);
    } catch (error) {
      return error instanceof ChannelError ? failed(error.code, error.retryable) : failed("CHANNEL_CONNECTION_FAILED", false);
    } finally {
      clearTimeout(timer);
    }
  }
}
