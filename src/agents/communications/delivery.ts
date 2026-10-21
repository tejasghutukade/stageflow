import { CHANNEL_ERROR_INFO } from "../../channels/errorInfo.js";
import { ChannelError } from "../../channels/errors.js";
import { AgentError } from "../errors.js";
import type { DeliveryClaim, DeliveryInput } from "../ledgers.js";
import type { AgentService } from "../service.js";
import type { AgentDelivery } from "../store.js";

/** Waits before each automatic retry of a reply that definitely did not go out. */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000];

export type { DeliveryInput };

type Reply = (connectionId: string, to: string, text: string, operationKey: string) => Promise<void>;

type Outcome = { kind: "failed" | "unknown"; retryable: boolean; code: string; message: string };

/** Sorts a send failure into "never left" (safe to retry when transient) and "may have arrived" (never resent on its own). */
export function classifySendFailure(error: unknown): Outcome {
  if (error instanceof ChannelError) {
    const info = CHANNEL_ERROR_INFO[error.code];
    const unknown = error.code === "CHANNEL_SEND_OUTCOME_UNKNOWN";
    return { kind: unknown ? "unknown" : "failed", retryable: !unknown && error.retryable, code: error.code, message: `${info.reason}${info.hint ? `. ${info.hint}` : ""}` };
  }
  const code = String((error as { code?: unknown } | null)?.code ?? "SEND_FAILED");
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  // Something broke on this side before the send: nothing left, but retrying the same call will not fix it.
  return { kind: "failed", retryable: false, code, message };
}

/**
 * Gets an agent's reply to the person on the channel they wrote from. The turn only counts as succeeded once the
 * reply is delivered: a definite failure is retried with backoff when it may be transient; an unknown outcome is never
 * resent automatically (it could arrive twice); anything left over is a failed turn a person can resend or mark delivered.
 */
export class ReplyDelivery {
  private readonly timers = new Set<NodeJS.Timeout>();
  private sweeping: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      service: Pick<AgentService, "deliveries" | "settleInterruptedDeliveries" | "setReplyDelivered" | "clockMs">;
      reply: Reply;
      log?: (message: string) => void;
      backoffMs?: number[];
    },
  ) {}

  private get backoff(): number[] {
    return this.options.backoffMs ?? RETRY_BACKOFF_MS;
  }

  /** Record the reply and make the first attempt. Resolves with the delivery's state after that attempt. */
  async deliver(input: DeliveryInput): Promise<AgentDelivery> {
    const { deliveries } = this.options.service;
    const existing = deliveries.get(input.turnId);
    if (existing) return existing;
    deliveries.create(input);
    return this.attempt(input.turnId, "first");
  }

  /**
   * One send attempt. The right to send is claimed first, atomically (`pending`/`failed`/`unknown` -> `sending`), and
   * the row is what is trusted, not any list the caller read earlier: an attempt that finds the delivery already
   * claimed, sent or no longer due does nothing and returns it as it is. Overlapping sweeps and timers therefore
   * cannot send the same reply twice.
   */
  private async attempt(turnId: string, kind: DeliveryClaim): Promise<AgentDelivery> {
    const { service } = this.options;
    const automatic = kind !== "manual";
    // Written before sending: a crash mid-send leaves "sending", which a restart turns into "unknown".
    const current = service.deliveries.claim(turnId, kind);
    if (!current) return service.deliveries.get(turnId)!;
    const attempts = current.attempts;
    try {
      await this.options.reply(current.connectionId, current.replyTo, current.text, `agent-reply:${current.sessionId}:${turnId}:${attempts}`);
    } catch (error) {
      const outcome = classifySendFailure(error);
      const retry = automatic && outcome.kind === "failed" && outcome.retryable && attempts <= this.backoff.length;
      const delay = this.backoff[attempts - 1];
      const next = retry && delay !== undefined ? new Date(service.clockMs() + delay).toISOString() : null;
      const saved = service.deliveries.patch(turnId, { state: outcome.kind, errorCode: outcome.code, errorMessage: outcome.message, retryable: next !== null, nextAttemptAt: next })!;
      // While a retry is coming the turn stays as it was; when none is, the turn failed.
      if (next === null) service.setReplyDelivered(turnId, false);
      else if (delay !== undefined) this.later(delay);
      this.options.log?.(`agent reply ${turnId} ${outcome.kind} (${outcome.code}) after attempt ${attempts}${next ? `, retrying at ${next}` : ""}`);
      return saved;
    }
    const saved = service.deliveries.patch(turnId, { state: "delivered", errorCode: null, errorMessage: null, retryable: false, nextAttemptAt: null })!;
    service.setReplyDelivered(turnId, true);
    return saved;
  }

  private later(delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.sweepInBackground();
    }, delayMs + 50);
    timer.unref?.();
    this.timers.add(timer);
  }

  /** A timer-driven sweep has no caller to report to; a failure (a store closing mid-sweep) must not escape as an unhandled rejection. */
  private sweepInBackground(): void {
    this.sweep().catch((error: unknown) => {
      this.options.log?.(`agent reply sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Retry what is due. Also run on a timer, so retries survive a restart. */
  async sweep(): Promise<number> {
    const due = this.options.service.deliveries.due();
    let attempted = 0;
    for (const delivery of due) {
      const before = this.options.service.deliveries.get(delivery.turnId);
      // The list may be stale: another sweep or timer may have taken this one since it was read.
      if (!before || before.state !== "failed") continue;
      const after = await this.attempt(delivery.turnId, "retry");
      if (after.attempts > before.attempts) attempted += 1;
    }
    return attempted;
  }

  /** On start: sends a restart cut off are now unknown; retries that were waiting are picked up by the sweep. */
  start(intervalMs = 15_000): void {
    const settled = this.options.service.settleInterruptedDeliveries();
    if (settled.length > 0) this.options.log?.(`agent replies: ${settled.length} send(s) were cut off by a restart and need a person to resend or mark delivered`);
    this.sweepInBackground();
    this.sweeping = setInterval(() => this.sweepInBackground(), intervalMs);
    this.sweeping.unref?.();
  }

  stop(): void {
    if (this.sweeping) clearInterval(this.sweeping);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** A person resends a reply that failed or whose outcome was unknown. One attempt; no automatic retries after it. */
  async resend(turnId: string): Promise<AgentDelivery> {
    const current = this.options.service.deliveries.get(turnId);
    if (!current) throw new AgentError("agent.not_found", "This turn has no reply to send");
    if (current.state !== "failed" && current.state !== "unknown") throw new AgentError("agent.invalid", `The reply is ${current.state}; only a failed or unconfirmed reply can be resent`);
    return this.attempt(turnId, "manual");
  }

  /** A person confirms the reply did arrive (for example after an unknown outcome). */
  markDelivered(turnId: string): AgentDelivery {
    const current = this.options.service.deliveries.get(turnId);
    if (!current) throw new AgentError("agent.not_found", "This turn has no reply to send");
    if (current.state === "delivered") return current;
    const saved = this.options.service.deliveries.patch(turnId, { state: "delivered", errorCode: null, errorMessage: null, retryable: false, nextAttemptAt: null })!;
    this.options.service.setReplyDelivered(turnId, true);
    return saved;
  }
}
