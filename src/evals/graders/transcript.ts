import { JUDGE_TRANSCRIPT_LIMITS } from "../constants.js";
import type { ConversationOutput } from "../types.js";

export type TranscriptLimits = {
  turns: number;
  messageChars: number;
  toolArgsChars: number;
  toolResultChars: number;
};

const KEEP_FIRST_TURNS = 3;

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function neutralize(text: string): string {
  return text.replace(/<(\/?)(transcript|rubric|examples|case_input|case_expected)\b/gi, "<\\$1$2");
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * The bounded transcript the judge reads: one line block per message or tool call, tool arguments and results
 * capped, and only the first and last turns kept past the turn limit.
 */
export function renderTranscript(
  subject: Pick<ConversationOutput, "messages" | "tool_calls">,
  limits: TranscriptLimits = JUDGE_TRANSCRIPT_LIMITS,
): string {
  const turns = [
    ...new Set([...subject.messages.map((m) => m.turn), ...subject.tool_calls.map((c) => c.turn)]),
  ].sort((a, b) => a - b);

  let kept = turns;
  let omitted = 0;
  if (turns.length > limits.turns) {
    const tail = Math.max(0, limits.turns - KEEP_FIRST_TURNS);
    omitted = turns.length - limits.turns;
    kept = [...turns.slice(0, KEEP_FIRST_TURNS), ...turns.slice(turns.length - tail)];
  }

  const lines: string[] = [];
  kept.forEach((turn, index) => {
    if (omitted > 0 && index === KEEP_FIRST_TURNS) lines.push(`[${omitted} turns omitted]`);
    const say = (role: "user" | "assistant") => {
      for (const m of subject.messages) {
        if (m.turn === turn && m.role === role) {
          lines.push(`[turn ${turn}] ${role === "user" ? "USER" : "AGENT"}: ${neutralize(cut(m.text, limits.messageChars))}`);
        }
      }
    };
    say("user");
    for (const call of subject.tool_calls) {
      if (call.turn !== turn) continue;
      const outcome = call.status === "error" ? `${call.policy_outcome}, error` : call.policy_outcome;
      const args = neutralize(cut(json(call.args), limits.toolArgsChars));
      const result = neutralize(cut(call.result_summary, limits.toolResultChars));
      lines.push(`[turn ${turn}] TOOL ${call.name} (${outcome}) args=${args} -> ${result}`);
    }
    say("assistant");
  });
  return lines.join("\n");
}
