import type { AgentGuardrails } from "../config/loadAgent.js";

export type GuardrailResult = { ok: true } | { ok: false; pattern: string };

/** Block patterns are validated as regular expressions when the definition is parsed. */
export function checkGuardrails(guardrails: AgentGuardrails, text: string): GuardrailResult {
  for (const pattern of guardrails.block_patterns) {
    if (new RegExp(pattern).test(text)) return { ok: false, pattern };
  }
  return { ok: true };
}

/**
 * The one path model output takes to a person. Without block patterns, deltas go straight through. With them, a
 * pattern can match text that has not been written yet, so deltas are held and released only once the finished reply
 * (and everything held) has passed the check; a blocked reply is never streamed. The cost is that guarded agents show
 * their reply at the end instead of word by word.
 */
export type GuardedStream = {
  /** Give this to the model runtime. */
  push(delta: string): void;
  /** The check on the finished reply passed: let held text out. Returns the verdict; nothing is released when it fails. */
  release(finalText: string): GuardrailResult;
  /** The turn ended without a reply to show: drop what was held. */
  discard(): void;
};

export function guardedStream(guardrails: AgentGuardrails, forward: ((text: string) => void) | undefined): GuardedStream {
  if (guardrails.block_patterns.length === 0) {
    return { push: (delta) => forward?.(delta), release: () => ({ ok: true }), discard: () => undefined };
  }
  let held: string[] = [];
  return {
    push: (delta) => {
      held.push(delta);
    },
    release(finalText) {
      const verdict = checkGuardrails(guardrails, finalText);
      if (!verdict.ok) {
        held = [];
        return verdict;
      }
      const streamed = checkGuardrails(guardrails, held.join(""));
      if (!streamed.ok) {
        held = [];
        return streamed;
      }
      const out = held;
      held = [];
      for (const delta of out) forward?.(delta);
      return { ok: true };
    },
    discard() {
      held = [];
    },
  };
}
