import type { PendingPrompt, StageAnswer, StageLogEvent } from "../api/types";
import { waitingOnYouTitle } from "./runStatus";

const ACTIVITY_SNIPPET_LIMIT = 160;

function activitySnippet(text: string, limit = ACTIVITY_SNIPPET_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

function describeOperatorPrompt(event: StageLogEvent): string | undefined {
  const prompt = event.prompt;
  if (!prompt || typeof prompt !== "object") return undefined;
  const p = prompt as PendingPrompt;
  if (p.kind === "multi_question") {
    const n = p.questions?.length ?? 0;
    return n === 1 ? "1 question" : `${n} questions`;
  }
  if (typeof p.message === "string" && p.message.trim()) {
    return activitySnippet(p.message);
  }
  return undefined;
}

function describeOperatorAnswer(event: StageLogEvent): string | undefined {
  const answer = event.answer;
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as StageAnswer;
  if (a.kind === "free_text") {
    return typeof a.text === "string" ? activitySnippet(a.text) : undefined;
  }
  if (a.kind === "confirm" || a.kind === "artifact_backed") {
    const decision = a.decision;
    const note =
      typeof a.text === "string" && a.text.trim()
        ? activitySnippet(a.text)
        : undefined;
    if (decision && note) return `${decision} — ${note}`;
    if (decision) return decision;
    return note;
  }
  if (a.kind === "multi_question") {
    const n = Object.keys(a.answers ?? {}).length;
    return n === 1 ? "1 answer" : `${n} answers`;
  }
  return undefined;
}

export function formatActivityLabel(event: StageLogEvent): string {
  switch (event.event) {
    case "started":
      return "Stage started";
    case "succeeded":
      return "Stage succeeded";
    case "failed":
      return event.reason ? `Stage failed: ${event.reason}` : "Stage failed";
    case "agent_start":
      return "Agent started";
    case "agent_end":
      return "Agent settled";
    case "turn_start":
      return "Turn";
    case "tool_start":
      return `→ ${event.toolName ?? "tool"}`;
    case "tool_end":
      return event.isError
        ? `✕ ${event.toolName ?? "tool"}`
        : `✓ ${event.toolName ?? "tool"}`;
    case "message": {
      const role = event.role ?? "message";
      if (event.text) return `${role}: ${event.text}`;
      return role;
    }
    case "operator_prompt":
      return "Operator prompt";
    case "operator_answer":
      return "Operator answer";
    case "waiting_for_input":
      return waitingOnYouTitle();
    case "resumed":
      return "Stage resumed";
    default:
      return event.event;
  }
}

export function formatActivityDescription(event: StageLogEvent): string | undefined {
  if (event.event === "tool_start" && event.argsPreview) return event.argsPreview;
  if (event.event === "tool_end" && event.resultPreview) return event.resultPreview;
  if (event.event === "failed" && event.reason) return event.reason;
  if (event.event === "operator_prompt") return describeOperatorPrompt(event);
  if (event.event === "operator_answer") return describeOperatorAnswer(event);
  return undefined;
}
