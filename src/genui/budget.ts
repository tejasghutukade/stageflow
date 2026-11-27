import { SESSION_ARTIFACT_RATE_LIMIT, SESSION_ARTIFACT_RATE_WINDOW_MS } from "../artifacts/sessionScope.js";
import { SlidingWindowLimiter } from "../util/slidingWindowLimiter.js";

/**
 * Cards drawn in the current reply. A call reserves its slot before it awaits anything, so parallel calls in one reply
 * each count, and releases it when the card fails, so a refused card does not use up the reply.
 */
export class TurnBudget {
  private used = 0;

  /** The slot this call holds: 1 for the first card of the reply. A slot over the cap is refused by the operation. */
  reserve(): number {
    this.used += 1;
    return this.used;
  }

  release(): void {
    this.used = Math.max(0, this.used - 1);
  }

  reset(): void {
    this.used = 0;
  }
}

const TURN_BUDGETS_MAX = 512;

/** Budgets for a tool shared by many conversations (the Guide): one per surface key, reset when its turn changes. */
export class TurnBudgets {
  private readonly byKey = new Map<string, { turn: number; budget: TurnBudget }>();

  for(key: string, turn: number): TurnBudget {
    const entry = this.byKey.get(key);
    if (entry) {
      if (entry.turn !== turn) {
        entry.turn = turn;
        entry.budget.reset();
      }
      return entry.budget;
    }
    if (this.byKey.size >= TURN_BUDGETS_MAX) {
      const oldest = this.byKey.keys().next().value;
      if (oldest !== undefined) this.byKey.delete(oldest);
    }
    const budget = new TurnBudget();
    this.byKey.set(key, { turn, budget });
    return budget;
  }
}

let cardLimiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);

/** Cards per minute for one surface (`surfaceKey`). */
export function takeCardRate(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterSec: number } {
  return cardLimiter.take(key, SESSION_ARTIFACT_RATE_LIMIT, nowMs);
}

export function resetCardLimiterForTests(): void {
  cardLimiter = new SlidingWindowLimiter(SESSION_ARTIFACT_RATE_WINDOW_MS);
}
