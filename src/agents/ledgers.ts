import { agentProjectKey, type AgentDelivery, type AgentStore } from "./store.js";

export type DeliveryInput = { turnId: string; sessionId: string; connectionId: string; provider: string; replyTo: string; text: string };
export type DeliveryClaim = "first" | "retry" | "manual";

/** What reply delivery needs of storage, and nothing else. */
export type DeliveryLedger = {
  create(input: DeliveryInput): AgentDelivery;
  get(turnId: string): AgentDelivery | undefined;
  patch(turnId: string, patch: Parameters<AgentStore["updateDelivery"]>[1]): AgentDelivery | undefined;
  due(): AgentDelivery[];
  /**
   * Take the right to send, atomically: moves the delivery to `sending` only if it is still in a state this kind of
   * attempt may start from. Returns the claimed row, or undefined when someone else holds it or it already went out.
   */
  claim(turnId: string, kind: DeliveryClaim): AgentDelivery | undefined;
};

export function deliveryLedger(store: AgentStore, nowIso: () => string): DeliveryLedger {
  return {
    create(input) {
      const now = nowIso();
      const delivery: AgentDelivery = { ...input, state: "pending", attempts: 0, errorCode: null, errorMessage: null, retryable: false, nextAttemptAt: null, createdAt: now, updatedAt: now };
      store.insertDelivery(delivery);
      return delivery;
    },
    get: (turnId) => store.getDelivery(turnId),
    patch(turnId, patch) {
      store.updateDelivery(turnId, patch, nowIso());
      return store.getDelivery(turnId);
    },
    due: () => store.dueDeliveries(nowIso()),
    claim(turnId, kind) {
      const now = nowIso();
      return kind === "first"
        ? store.claimDelivery(turnId, ["pending"], now)
        : kind === "manual"
          ? store.claimDelivery(turnId, ["failed", "unknown"], now)
          : store.claimDelivery(turnId, ["failed"], now, { dueRetry: true });
    },
  };
}

/** What the scheduler needs of storage: when each scheduled agent runs next. */
export type ScheduleLedger = {
  nextRun(projectRoot: string, agentId: string): string | undefined;
  setNextRun(projectRoot: string, agentId: string, nextRunAt: string): void;
};

export function scheduleLedger(store: AgentStore): ScheduleLedger {
  return {
    nextRun: (projectRoot, agentId) => store.getScheduleNextRun(agentProjectKey(projectRoot), agentId),
    setNextRun: (projectRoot, agentId, nextRunAt) => store.setScheduleNextRun(agentProjectKey(projectRoot), agentId, nextRunAt),
  };
}
