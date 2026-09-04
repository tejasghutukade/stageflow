/**
 * Pi-agnostic stage activity events.
 *
 * Adapters map provider/SDK events into this vocabulary. Disk, API, UI, and
 * HITL control planes should speak these types — not Pi's AgentEvent.
 * Lifecycle `waiting_for_input` / `resumed` are owned by stageRunner (not
 * adapters).
 *
 * `operator_prompt` / `operator_answer` carry full T2 ask-operator payloads.
 * ACTIVITY_TEXT_LIMIT applies only to tool/message *previews* — never to
 * those Q&A bodies.
 */

import type {
  AskOperatorAnswer,
  AskOperatorPrompt,
} from "../tools/askOperator.js";

export const ACTIVITY_TEXT_LIMIT = 2000;

export const ACTIVITY_TEXT_LIMIT_ENV = "STAGEFLOW_ACTIVITY_TEXT_LIMIT";

export const ACTIVITY_VERBOSE_ENV = "STAGEFLOW_ACTIVITY_VERBOSE";

export function readActivityTextLimit(
  env: Record<string, string | undefined> = process.env,
  override?: number,
): number {
  if (override !== undefined) {
    if (Number.isFinite(override) && override >= 1) return Math.floor(override);
    return ACTIVITY_TEXT_LIMIT;
  }
  const raw = env[ACTIVITY_TEXT_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") {
    return ACTIVITY_TEXT_LIMIT;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return ACTIVITY_TEXT_LIMIT;
  }
  return n;
}

export function readActivityVerbose(
  env: Record<string, string | undefined> = process.env,
  override?: boolean,
): boolean {
  if (override !== undefined) {
    return override;
  }
  const raw = env[ACTIVITY_VERBOSE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return false;
  }
  return true;
}

export type StageActivityEvent =
  | { event: "agent_start" }
  | { event: "agent_end" }
  | { event: "turn_start" }
  | {
      event: "tool_start";
      toolName: string;
      toolCallId?: string;
      argsPreview?: string;
    }
  | {
      event: "tool_end";
      toolName: string;
      toolCallId?: string;
      isError?: boolean;
      resultPreview?: string;
    }
  | {
      event: "tool_progress";
      toolName: string;
      toolCallId?: string;
      textPreview?: string;
    }
  | {
      event: "message";
      role: string;
      text?: string;
    }
  | {
      event: "operator_prompt";
      prompt: AskOperatorPrompt;
    }
  | {
      event: "operator_answer";
      promptId: string;
      answer: AskOperatorAnswer;
    };

export type OperatorPromptActivityEvent = Extract<
  StageActivityEvent,
  { event: "operator_prompt" }
>;

export type OperatorAnswerActivityEvent = Extract<
  StageActivityEvent,
  { event: "operator_answer" }
>;

/** Lifecycle lines written by stageRunner (not the adapter). */
export type StageLifecycleEvent =
  | { event: "started" }
  | { event: "waiting_for_input" }
  | { event: "resumed" }
  | { event: "succeeded" }
  | { event: "failed"; reason: string }
  | { event: "skipped" }
  /** Operator explicitly authorized a new attempt after verified failure. */
  | { event: "manual_recovery_requested"; guidance?: string }
  /** Operator chose to leave the verified failure terminal. */
  | { event: "manual_recovery_stopped" };

export type StageLogLine = StageActivityEvent | StageLifecycleEvent;

export function truncateActivityText(
  value: unknown,
  limit = readActivityTextLimit(),
): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export function extractMessageText(message: {
  role?: string;
  content?: unknown;
}): { role: string; text?: string } {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const content = message.content;
  if (typeof content === "string") {
    return { role, text: truncateActivityText(content) };
  }
  if (!Array.isArray(content)) {
    return { role };
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  if (parts.length === 0) return { role };
  return { role, text: truncateActivityText(parts.join("")) };
}

/**
 * Map a loose Pi/session event object into a StageActivityEvent.
 * Returns null for events we intentionally ignore (e.g. text_delta streams).
 */
export function mapSessionEventToActivity(
  event: Record<string, unknown>,
): StageActivityEvent | null {
  const type = event.type;
  if (type === "agent_start") return { event: "agent_start" };
  if (type === "agent_end") return { event: "agent_end" };
  if (type === "turn_start") return { event: "turn_start" };

  if (type === "tool_execution_start") {
    return {
      event: "tool_start",
      toolName: String(event.toolName ?? "unknown"),
      toolCallId:
        typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      argsPreview: truncateActivityText(event.args),
    };
  }

  if (type === "tool_execution_end") {
    return {
      event: "tool_end",
      toolName: String(event.toolName ?? "unknown"),
      toolCallId:
        typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      isError: Boolean(event.isError),
      resultPreview: truncateActivityText(event.result),
    };
  }

  if (type === "message_end" && event.message && typeof event.message === "object") {
    const { role, text } = extractMessageText(
      event.message as { role?: string; content?: unknown },
    );
    return { event: "message", role, text };
  }

  return null;
}
