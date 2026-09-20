export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_LIMIT_BURST = 20;
export const MAX_NONTERMINAL_TASKS_PER_CALLER = 2;
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MESSAGE_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Token-bucket per caller: `capacity` burst, refilling at `perMinute` tokens/minute. Clock is injectable for deterministic tests. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number = RATE_LIMIT_BURST,
    perMinute: number = RATE_LIMIT_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {
    this.refillPerMs = perMinute / 60000;
  }

  tryConsume(key: string): boolean {
    const at = this.now();
    const existing = this.buckets.get(key);
    const elapsed = existing ? Math.max(0, at - existing.updatedAt) : 0;
    const tokens = existing ? Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs) : this.capacity;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: at });
      return false;
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: at });
    return true;
  }
}
