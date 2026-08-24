import type { StageEnvelope } from "../types/envelope.js";

export function formatPriorEnvelope(
  priorEnvelope: StageEnvelope | null,
): string {
  return priorEnvelope === null
    ? "No prior envelope (first stage)."
    : `Prior envelope JSON:\n${JSON.stringify(priorEnvelope, null, 2)}`;
}
