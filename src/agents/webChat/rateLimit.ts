/** Fixed-size sliding window per key. In memory: a Host restart forgives everyone, which is fine for abuse control. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(private readonly windowMs = 60_000) {}

  /** Records one hit unless the key is over `limit`; otherwise says how long until a slot frees up. */
  take(key: string, limit: number, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true };
  }

  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const [key, list] of this.hits) {
      const recent = list.filter((at) => now - at < this.windowMs);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
