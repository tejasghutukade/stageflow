import type { ApprovalBroker, ApprovalOutcome } from "./approvalBroker.js";
import type { AgentApproval, AgentStore, ApprovalActor, SessionStatus, TurnStatus } from "./store.js";

/** Turn statuses nothing can leave. */
export type TerminalTurnStatus = Exclude<TurnStatus, "running" | "waiting">;

export function isTerminalTurnStatus(status: TurnStatus): status is TerminalTurnStatus {
  return status !== "running" && status !== "waiting";
}

export type FinishInput = {
  status: TerminalTurnStatus;
  errorCode?: string | null;
  /** The assistant's reply, written with the turn so the transcript and the outcome never disagree. */
  assistant?: { id: string; author: string; text: string };
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number | null;
  evalScores?: Array<{ metric: string; score: number }>;
  sessionStatus?: SessionStatus;
};

/**
 * The single owner of what may happen to a turn, its session and its approval. Every change of those statuses goes
 * through here, so the rows and the broker wake-up move together and an illegal move is refused instead of applied.
 *
 *   turn:     running <-> waiting -> succeeded | failed | cancelled      (terminal states are final)
 *   approval: pending -> approved | denied | expired                     (decided approvals are final)
 *   session:  open -> running <-> waiting -> open                        (follows its one active turn)
 *
 * The methods are synchronous database work; callers serialise them (AgentService runs them in its exclusive section).
 */
export class TurnLifecycle {
  constructor(
    private readonly store: AgentStore,
    private readonly broker: ApprovalBroker,
    private readonly nowIso: () => string,
  ) {}

  /** The turn is paused on a person. Refused (false) unless it is running; an already decided approval returns its outcome instead. */
  wait(turnId: string, approvalId: string): "waiting" | ApprovalOutcome | "inactive" {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.status !== "running") return "inactive";
    const approval = this.store.getApproval(approvalId);
    // Decided between the request and this call: do not park on a decision that already happened.
    if (approval && approval.status !== "pending") return approval.status;
    this.store.transaction(() => {
      this.store.setTurnStatus(turnId, "waiting");
      this.store.updateSession(turn.sessionId, { status: "waiting" }, this.nowIso());
    });
    return "waiting";
  }

  /** The decision arrived (or the wait ended): back to running. No-op unless the turn is waiting. */
  resume(turnId: string): boolean {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.status !== "waiting") return false;
    this.store.transaction(() => {
      this.store.setTurnStatus(turnId, "running");
      this.store.updateSession(turn.sessionId, { status: "running" }, this.nowIso());
    });
    return true;
  }

  /**
   * End a turn: succeeded, failed or cancelled. Writes the reply, the outcome, scores and session status together, and
   * closes any approval the turn still has open so it can no longer be approved. Returns false (and changes nothing)
   * when the turn is unknown or already over.
   */
  finish(turnId: string, input: FinishInput): boolean {
    const turn = this.store.getTurn(turnId);
    if (!turn || isTerminalTurnStatus(turn.status)) return false;
    const now = this.nowIso();
    const closed = this.store.transaction(() => {
      if (input.assistant && input.assistant.text.length > 0) {
        this.store.appendMessage({
          id: input.assistant.id,
          sessionId: turn.sessionId,
          turnId,
          role: "assistant",
          author: input.assistant.author,
          text: input.assistant.text,
          createdAt: now,
        });
      }
      this.store.finishTurn(turnId, {
        status: input.status,
        errorCode: input.errorCode ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        costUsd: input.costUsd ?? null,
        endedAt: now,
      });
      for (const score of input.evalScores ?? []) {
        this.store.recordEvalScore({ turnId, metric: score.metric, score: score.score, recordedAt: now });
      }
      const ids = this.store.closePendingApprovalsOfTurn(turnId, now);
      this.store.updateSession(turn.sessionId, { status: input.sessionStatus ?? "open" }, now);
      return ids;
    });
    for (const approvalId of closed) this.broker.settle(approvalId, "expired");
    return true;
  }

  /** The Host restarted: nothing can resume running turns, so they fail and their approvals close. */
  interruptedByRestart(): number {
    return this.store.failInterruptedTurns(this.nowIso());
  }

  /** Close one open approval without a decision (its turn was stopped). Returns false when it was already decided. */
  closeApproval(approvalId: string): boolean {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.status !== "pending") return false;
    this.store.decideApproval(approvalId, { status: "expired", decidedAt: this.nowIso(), actor: null });
    this.broker.settle(approvalId, "expired");
    return true;
  }

  /** Expire every approval past its deadline and wake whoever waits on it. */
  expireDue(): void {
    const now = this.nowIso();
    for (const { approvalId, sessionId } of this.store.expireApprovals(now)) {
      const session = this.store.getSession(sessionId);
      if (session?.status === "waiting") this.store.updateSession(sessionId, { status: "open" }, now);
      this.broker.settle(approvalId, "expired");
    }
  }

  /**
   * Record a decision on the session's pending approval. An approval whose turn is already over is closed instead of
   * approved, so a late click cannot run an action nobody is waiting for or pre-approve a later identical call.
   * Returns the decided approval, or "stale" when the approval had to be closed.
   */
  decide(pending: AgentApproval, decision: "approve" | "deny", actor: ApprovalActor): { approval: AgentApproval } | "stale" {
    const now = this.nowIso();
    const turn = pending.turnId ? this.store.getTurn(pending.turnId) : undefined;
    if (turn && isTerminalTurnStatus(turn.status)) {
      this.closeApproval(pending.id);
      return "stale";
    }
    const status = decision === "approve" ? "approved" : "denied";
    this.store.transaction(() => {
      this.store.decideApproval(pending.id, { status, decidedAt: now, actor });
      if (decision === "approve") this.store.markPayloadExecuted(pending.sessionId, pending.payloadHash, now);
      this.store.updateSession(pending.sessionId, { status: "open" }, now);
    });
    this.broker.settle(pending.id, status);
    return { approval: { ...pending, status, decidedAt: now, actor } };
  }

  /**
   * A channel reply that could not be delivered turns a succeeded turn into a failure, and one that finally arrives puts
   * it right. Only that one marker moves; a turn that is unfinished, cancelled or failed for another reason is left alone.
   */
  replyDelivery(turnId: string, delivered: boolean): void {
    const turn = this.store.getTurn(turnId);
    if (!turn) return;
    const undelivered = turn.status === "failed" && turn.errorCode === "agent.reply_undelivered";
    if (delivered) {
      if (undelivered) this.store.setTurnOutcome(turnId, "succeeded", null);
    } else if (turn.status === "succeeded") {
      this.store.setTurnOutcome(turnId, "failed", "agent.reply_undelivered");
    }
  }

  /** Delivery sends a restart cut off: their turns wait for a person. Only finished (succeeded) turns are marked. */
  replyUnconfirmed(turnIds: string[]): void {
    for (const turnId of turnIds) this.replyDelivery(turnId, false);
  }
}
