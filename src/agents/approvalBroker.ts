export type ApprovalOutcome = "approved" | "denied" | "expired";

/**
 * In-process rendezvous between a turn paused at an ask-first tool and the
 * decision that arrives later (console, CLI, MCP or a channel). A waiter only
 * exists while the Host process that started the turn is alive.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, Set<(outcome: ApprovalOutcome) => void>>();

  wait(approvalId: string, options: { expiresAt: string; signal: AbortSignal; now?: () => number }): Promise<ApprovalOutcome | "aborted"> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: ApprovalOutcome | "aborted") => {
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        this.waiters.get(approvalId)?.delete(listener);
        if (this.waiters.get(approvalId)?.size === 0) this.waiters.delete(approvalId);
        resolve(outcome);
      };
      const listener = (outcome: ApprovalOutcome) => finish(outcome);
      const onAbort = () => finish("aborted");
      if (options.signal.aborted) return resolve("aborted");
      options.signal.addEventListener("abort", onAbort, { once: true });
      const set = this.waiters.get(approvalId) ?? new Set();
      set.add(listener);
      this.waiters.set(approvalId, set);
      const arm = () => {
        const remaining = Date.parse(options.expiresAt) - (options.now?.() ?? Date.now());
        if (remaining <= 0) return finish("expired");
        // setTimeout caps at ~24.8 days; longer waits re-arm until the real expiry.
        timer = setTimeout(arm, Math.min(remaining, 2 ** 31 - 1));
      };
      timer = setTimeout(arm, 0);
    });
  }

  settle(approvalId: string, outcome: ApprovalOutcome): void {
    for (const listener of [...(this.waiters.get(approvalId) ?? [])]) listener(outcome);
  }

  pending(): number {
    return this.waiters.size;
  }
}
