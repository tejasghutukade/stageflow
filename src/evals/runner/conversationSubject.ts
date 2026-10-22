import { redactSecrets } from "../../agent/streamLogRedact.js";
import type { EvalToolCallRecord } from "../../agents/evalGate.js";
import type { AgentSessionDetail } from "../../agents/service.js";
import { EVAL_CONVERSATION_LIMITS } from "../constants.js";
import type {
  ConversationMessage,
  ConversationOutput,
  ConversationStopReason,
  ConversationToolCall,
  ConversationUsage,
} from "../types.js";

const L = EVAL_CONVERSATION_LIMITS;

export type ConversationSubjectInput = {
  detail: AgentSessionDetail;
  calls: readonly EvalToolCallRecord[];
  stopReason: ConversationStopReason;
  usage: ConversationUsage;
  /** User turns completed (a turn counts once the agent replied or failed). */
  turns: number;
  /** Set for the partial subject of a failed case. */
  failure?: string;
};

type Truncation = { messages: number; tool_results: number; tool_args: number; tool_calls_dropped: number };

function cut(text: string, max: number, count: () => void): string {
  if (text.length <= max) return text;
  count();
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

function redactedJson(value: unknown): string {
  try {
    return redactSecrets(JSON.stringify(value ?? {}));
  } catch {
    return "{}";
  }
}

function subAgentSessions(detail: AgentSessionDetail): Map<string, string> {
  const out = new Map<string, string>();
  for (const span of detail.spans) {
    const callId = span.attributes["gen_ai.tool.call.id"];
    const child = span.attributes["stageflow.sub_agent.session_id"];
    if (typeof callId === "string" && typeof child === "string") out.set(callId, child);
  }
  return out;
}

function messagesOf(detail: AgentSessionDetail): ConversationMessage[] {
  let turn = 0;
  const out: ConversationMessage[] = [];
  for (const message of detail.messages) {
    if (message.role === "user") turn += 1;
    out.push({
      role: message.role,
      text: cut(redactSecrets(message.text), L.maxMessageChars, () => undefined),
      turn: Math.max(turn, 1),
    });
  }
  return out;
}

function toolCallsOf(
  detail: AgentSessionDetail,
  calls: readonly EvalToolCallRecord[],
  truncation: Truncation,
): ConversationToolCall[] {
  const children = subAgentSessions(detail);
  const kept = calls.slice(0, L.maxToolCalls);
  truncation.tool_calls_dropped = calls.length - kept.length;
  return kept.map((call) => {
    let args: Record<string, unknown>;
    const json = redactedJson(call.args);
    if (json.length > L.maxArgsChars) {
      truncation.tool_args += 1;
      args = { _truncated: json.slice(0, L.maxArgsChars) };
    } else {
      args = JSON.parse(json) as Record<string, unknown>;
    }
    const result = cut(redactSecrets(call.result ?? ""), L.maxResultSummaryChars, () => (truncation.tool_results += 1));
    const sessionId = children.get(call.id);
    return {
      id: call.id,
      turn: call.turn,
      name: call.name,
      args,
      result_summary: result,
      status: call.status,
      policy_outcome: call.policyOutcome,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    };
  });
}

function sizeOf(output: ConversationOutput): number {
  return Buffer.byteLength(JSON.stringify(output));
}

/**
 * The normalized subject of an agent result. Every text is redacted before it is capped, because stored agent
 * messages are not redacted.
 */
export function buildConversationSubject(input: ConversationSubjectInput): ConversationOutput {
  const truncation: Truncation = { messages: 0, tool_results: 0, tool_args: 0, tool_calls_dropped: 0 };
  let messages = messagesOf(input.detail);
  const finalReply = [...messages].reverse().find((m) => m.role === "assistant")?.text ?? "";
  const tool_calls = toolCallsOf(input.detail, input.calls, truncation);

  let droppedMessages = 0;
  if (messages.length > L.maxMessages) {
    const tail = L.maxMessages - L.keepFirstMessages;
    droppedMessages = messages.length - L.maxMessages;
    messages = [...messages.slice(0, L.keepFirstMessages), ...messages.slice(messages.length - tail)];
  }

  const summary =
    input.failure !== undefined
      ? `${input.turns} turns, ${tool_calls.length} tool calls, ended ${input.stopReason}: ${input.failure}`
      : `${input.turns} turns, ${tool_calls.length} tool calls, ended ${input.stopReason}`;

  const output: ConversationOutput = {
    kind: "conversation",
    status: input.failure !== undefined ? "failure" : "success",
    summary,
    messages,
    tool_calls,
    final_reply: finalReply,
    turns: input.turns,
    stop_reason: input.stopReason,
    usage: input.usage,
  };

  while (sizeOf(output) > L.maxSubjectBytes && output.messages.length > 2) {
    const middle = Math.max(1, Math.floor(output.messages.length / 2));
    output.messages.splice(middle, 1);
    droppedMessages += 1;
  }
  truncation.messages = droppedMessages + countTruncatedText(output.messages);
  const counts = Object.entries(truncation).filter(([, value]) => value > 0);
  if (counts.length > 0) {
    output.truncated = {
      messages: truncation.messages,
      tool_results: truncation.tool_results,
      tool_args: truncation.tool_args,
      tool_calls_dropped: truncation.tool_calls_dropped,
    };
  }
  return output;
}

function countTruncatedText(messages: readonly ConversationMessage[]): number {
  return messages.filter((m) => /…\[truncated \d+ chars\]$/.test(m.text)).length;
}
