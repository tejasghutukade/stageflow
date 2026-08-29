import type { StageEnvelope } from "../types/envelope.js";

export function formatPriorEnvelope(
  priorEnvelope: StageEnvelope | null,
  priorEnvelopes?: StageEnvelope[],
): string {
  if (priorEnvelopes !== undefined && priorEnvelopes.length > 0) {
    return `Prior envelopes (${priorEnvelopes.length} clones, clone-list order):\n${JSON.stringify(priorEnvelopes, null, 2)}`;
  }
  return priorEnvelope === null
    ? "No prior envelope (first stage)."
    : `Prior envelope JSON:\n${JSON.stringify(priorEnvelope, null, 2)}`;
}
