import type { AgentDefinition } from "../config/loadAgent.js";
import type { ConversationMessage } from "./runtime/types.js";

/** Characters of replayed history a restarted session is given (about 15k tokens). */
export const HISTORY_CHAR_BUDGET = 60_000;

/**
 * Apply `limits.long_context` when a transcript is replayed into a new model
 * session: `truncate` drops the oldest messages; `summarize` condenses them to
 * one line each so the thread is still visible. The newest message is always kept.
 */
export function fitHistory(
  messages: readonly ConversationMessage[],
  policy: AgentDefinition["limits"]["long_context"],
  budget: number = HISTORY_CHAR_BUDGET,
): ConversationMessage[] {
  const total = messages.reduce((sum, m) => sum + m.text.length, 0);
  if (total <= budget || messages.length <= 1) return [...messages];
  const kept: ConversationMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (kept.length > 0 && used + message.text.length > budget) break;
    kept.unshift(message);
    used += message.text.length;
  }
  const dropped = messages.slice(0, messages.length - kept.length);
  if (policy === "truncate" || dropped.length === 0) return kept;
  const digest = dropped.map((m) => `- ${m.role}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 160)}`).join("\n");
  return [{ role: "assistant", text: `Earlier in this conversation (condensed):\n${digest}` }, ...kept];
}
