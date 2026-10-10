import type { StageLogEvent } from "../../api";
import { formatActivityDescription } from "../../status/activityCopy";

export type ToolCallView = {
  name: string;
  status: "running" | "complete" | "error";
  args?: string;
  result?: string;
  progressPreview?: string;
  at?: string;
  startedAt?: string;
};

export type RunDetailTranscriptTurnKind =
  | "tools"
  | "message"
  | "operator_answer";

export type RunDetailTranscriptTurnModel =
  | { kind: "tools"; calls: ToolCallView[] }
  | { kind: "message"; event: StageLogEvent }
  | { kind: "operator_answer"; event: StageLogEvent };

const TRANSCRIPT_NOISE_EVENTS = new Set<string>([
  "started",
  "succeeded",
  "failed",
  "interrupted",
  "agent_start",
  "agent_end",
  "waiting_for_input",
  "resumed",
  "operator_prompt",
  "feedback_loop_decided",
]);

export function isRunDetailTranscriptNoiseEvent(event: StageLogEvent): boolean {
  if (TRANSCRIPT_NOISE_EVENTS.has(event.event)) return true;
  if (event.event === "turn_start" && !formatActivityDescription(event)) {
    return true;
  }
  return false;
}

export function stageAgentLabel(stageLabel: string): string {
  const trimmed = stageLabel.trim();
  if (!trimmed) return "agent";
  const lower = trimmed.toLowerCase();
  return lower.endsWith(" agent") ? lower : `${lower} agent`;
}

export function isToolBatchEvent(event: string): boolean {
  return (
    event === "tool_start" ||
    event === "tool_end" ||
    event === "tool_progress"
  );
}

export function pairToolEvents(events: StageLogEvent[]): ToolCallView[] {
  const pending: {
    name: string;
    args?: string;
    at?: string;
    id: string;
    progressPreview?: string;
  }[] = [];
  const rows: ToolCallView[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.event === "tool_start") {
      pending.push({
        name: ev.toolName ?? "tool",
        args: ev.argsPreview,
        at: ev.at,
        id: ev.toolCallId ?? `start-${i}`,
      });
      continue;
    }
    if (ev.event === "tool_progress") {
      let matchIdx = -1;
      if (ev.toolCallId) {
        matchIdx = pending.findIndex((p) => p.id === ev.toolCallId);
      }
      if (matchIdx < 0) {
        matchIdx = pending.length > 0 ? pending.length - 1 : -1;
      }
      if (matchIdx < 0) continue;
      const preview =
        typeof ev.textPreview === "string" ? ev.textPreview : undefined;
      if (preview !== undefined) {
        pending[matchIdx].progressPreview = preview;
      }
      continue;
    }
    if (ev.event === "tool_end") {
      const matchIdx = ev.toolCallId
        ? pending.findIndex((p) => p.id === ev.toolCallId)
        : pending.findIndex((p) => p.name === (ev.toolName ?? "tool"));
      const start = matchIdx >= 0 ? pending.splice(matchIdx, 1)[0] : undefined;
      rows.push({
        name: ev.toolName ?? start?.name ?? "tool",
        status: ev.isError ? "error" : "complete",
        args: start?.args,
        result: ev.resultPreview,
        at: ev.at ?? start?.at,
        startedAt: start?.at,
      });
    }
  }

  for (const start of pending) {
    rows.push({
      name: start.name,
      status: "running",
      args: start.args,
      progressPreview: start.progressPreview,
      at: start.at,
      startedAt: start.at,
    });
  }

  return rows;
}

function mergeAssistantMessage(
  turns: RunDetailTranscriptTurnModel[],
  event: StageLogEvent,
): void {
  const text = event.text?.trim();
  if (!text) return;
  const last = turns[turns.length - 1];
  if (
    last?.kind === "message" &&
    last.event.role === "assistant" &&
    event.role === "assistant" &&
    last.event.text?.trim()
  ) {
    last.event = {
      ...last.event,
      text: `${last.event.text?.trim()}\n\n${text}`,
      at: event.at ?? last.event.at,
    };
    return;
  }
  turns.push({ kind: "message", event });
}

export function buildRunDetailTranscriptTurns(
  events: StageLogEvent[],
  options?: { mergeConsecutiveAssistant?: boolean },
): RunDetailTranscriptTurnModel[] {
  const mergeAssistant = options?.mergeConsecutiveAssistant ?? false;
  const turns: RunDetailTranscriptTurnModel[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (isToolBatchEvent(ev.event)) {
      const batch: StageLogEvent[] = [];
      while (i < events.length && isToolBatchEvent(events[i].event)) {
        batch.push(events[i]);
        i += 1;
      }
      const calls = pairToolEvents(batch);
      if (calls.length > 0) {
        turns.push({ kind: "tools", calls });
      }
      continue;
    }

    if (ev.event === "message") {
      if (ev.text?.trim()) {
        if (mergeAssistant && ev.role === "assistant") {
          mergeAssistantMessage(turns, ev);
        } else {
          turns.push({ kind: "message", event: ev });
        }
      }
    } else if (ev.event === "operator_answer") {
      turns.push({ kind: "operator_answer", event: ev });
    } else if (!isRunDetailTranscriptNoiseEvent(ev)) {
      // Redesign transcript omits remaining lifecycle markers (no centered system lines).
    }
    i += 1;
  }
  return turns;
}
