export type TriggerFireEvent = { triggerId: string; payload?: Record<string, unknown> };

/**
 * Abstract seam for anything that decides "fire trigger X now" — a croner-backed
 * schedule loop, a GitHub/email poller, a webhook receiver. No adapter implements
 * this yet; it exists so those later adapters build against a locked contract.
 */
export interface TriggerSourcePort {
  start(onFire: (event: TriggerFireEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
