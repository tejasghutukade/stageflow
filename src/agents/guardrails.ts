import type { AgentGuardrails } from "../config/loadAgent.js";

export type GuardrailResult = { ok: true } | { ok: false; pattern: string };

/** Block patterns are validated as regular expressions when the definition is parsed. */
export function checkGuardrails(guardrails: AgentGuardrails, text: string): GuardrailResult {
  for (const pattern of guardrails.block_patterns) {
    if (new RegExp(pattern).test(text)) return { ok: false, pattern };
  }
  return { ok: true };
}
