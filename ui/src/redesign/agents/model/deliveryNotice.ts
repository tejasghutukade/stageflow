import type { AgentDelivery } from "../../../api/agents";

export type DeliveryNotice = { title: string; detail: string; tone: "bad" | "warn"; canResend: boolean };

/**
 * What a person sees on a run whose reply did not get through. Nothing for a delivered reply or one still being
 * retried automatically.
 */
export function deliveryNotice(delivery: AgentDelivery | undefined, label: string): DeliveryNotice | null {
  if (!delivery || (delivery.state !== "failed" && delivery.state !== "unknown")) return null;
  if (delivery.state === "failed" && delivery.retryable) return null;
  const where = `${label} (${delivery.replyTo})`;
  if (delivery.state === "unknown") {
    return {
      title: "Reply may or may not have arrived",
      detail: `Sending to ${where} did not confirm. It is not resent on its own, in case it arrives twice. ${delivery.errorMessage ?? ""}`.trim(),
      tone: "warn",
      canResend: true,
    };
  }
  return {
    title: "Reply was not delivered",
    detail: `Sending to ${where} failed${delivery.attempts > 1 ? ` after ${delivery.attempts} attempts` : ""}. ${delivery.errorMessage ?? ""}`.trim(),
    tone: "bad",
    canResend: true,
  };
}
