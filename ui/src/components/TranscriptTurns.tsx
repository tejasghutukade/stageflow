import { useState, type ReactNode } from "react";
import type {
  PendingPrompt,
  StageAnswer,
  StageEnvelopeView,
  StageLogEvent,
} from "../api";
import {
  formatActivityDescription,
  formatActivityLabel,
} from "../status/activityCopy";
import { relativeTime } from "../catalogJoin";

const TOOL_VISIBLE_LIMIT = 4;

export type ToolCallView = {
  name: string;
  status: "running" | "complete" | "error";
  args?: string;
  result?: string;
  progressPreview?: string;
  at?: string;
};

function eventKey(event: StageLogEvent, index: number): string {
  return `${event.event}-${event.at ?? "na"}-${index}`;
}

function asPrompt(value: unknown): PendingPrompt | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: string }).kind;
  if (
    kind === "free_text" ||
    kind === "confirm" ||
    kind === "multi_question" ||
    kind === "artifact_backed"
  ) {
    return value as PendingPrompt;
  }
  return null;
}

function asAnswer(value: unknown): StageAnswer | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: string }).kind;
  if (
    kind === "free_text" ||
    kind === "confirm" ||
    kind === "multi_question" ||
    kind === "artifact_backed"
  ) {
    return value as StageAnswer;
  }
  return null;
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
      if (matchIdx < 0) {
        continue;
      }
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
    });
  }

  return rows;
}

function TurnWhen({ at }: { at?: string }) {
  if (!at) return null;
  return <time>{relativeTime(at)}</time>;
}

function InboundEnvelopeTurn({ envelope }: { envelope: StageEnvelopeView }) {
  return (
    <div className="turn">
      <div className="turn__who">
        Envelope
      </div>
      <div className="bubble" style={{ borderColor: "var(--color-border-green)" }}>
        <p>{envelope.summary}</p>
        {envelope.artifacts.length > 0 ? (
          <p className="muted">
            {envelope.artifacts
              .map((path) => path.split("/").pop() ?? path)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ToolGroup({ calls }: { calls: ToolCallView[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden =
    !expanded && calls.length > TOOL_VISIBLE_LIMIT
      ? calls.length - TOOL_VISIBLE_LIMIT
      : 0;
  const visible = hidden > 0 ? calls.slice(0, TOOL_VISIBLE_LIMIT) : calls;

  return (
    <div className="tools">
      {visible.map((call, i) => {
        const detail =
          call.status === "running"
            ? call.progressPreview
            : call.result;
        return (
          <div
            key={`${call.name}-${call.at ?? i}`}
            className={call.status === "error" ? "tool tool--error" : "tool"}
          >
            <span>
              {call.status === "error" ? "✕" : call.status === "running" ? "▸" : "⚙"}{" "}
              {call.name}
              {call.args ? ` ${call.args}` : ""}
              {detail ? ` · ${detail}` : ""}
            </span>
            <TurnWhen at={call.at} />
          </div>
        );
      })}
      {hidden > 0 ? (
        <button type="button" className="tools__more" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      ) : null}
    </div>
  );
}

function MessageTurn({ event }: { event: StageLogEvent }) {
  const role = event.role ?? "message";
  const text = event.text?.trim();
  if (!text) return null;

  return (
    <div className="turn">
      <div className="turn__who">
        {role}
        <TurnWhen at={event.at} />
      </div>
      <div className="bubble">
        <p>{text}</p>
      </div>
    </div>
  );
}

function AskTurn({ event }: { event: StageLogEvent }) {
  const prompt = asPrompt(event.prompt);
  return (
    <div className="ask">
      <div className="ask__label">
        {prompt?.kind ?? "ask"}
        <span style={{ marginLeft: "auto" }}>
          <TurnWhen at={event.at} />
        </span>
      </div>
      {prompt?.kind === "multi_question" ? (
        <ol className="qlist">
          {prompt.questions.map((q) => (
            <li key={q.id}>
              {q.message}
              <small>{q.kind}</small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ask__q">
          {prompt && "message" in prompt
            ? prompt.message
            : formatActivityDescription(event)}
        </p>
      )}
    </div>
  );
}

function AnswerTurn({ event }: { event: StageLogEvent }) {
  const answer = asAnswer(event.answer);
  let verdict: string | undefined;
  let body: string | undefined;

  if (answer?.kind === "free_text") {
    verdict = "answered";
    body = answer.text;
  } else if (answer?.kind === "confirm" || answer?.kind === "artifact_backed") {
    verdict = answer.decision;
    body = answer.text;
  } else if (answer?.kind === "multi_question") {
    const n = Object.keys(answer.answers ?? {}).length;
    verdict = n === 1 ? "1 answer" : `${n} answers`;
  } else {
    body = formatActivityDescription(event);
  }

  const verdictAttr =
    verdict === "accept" || verdict === "answered" || verdict === "reject"
      ? verdict
      : undefined;

  return (
    <div className="answer">
      <div className="turn__who">
        {verdict ? (
          <span className="answer__verdict" {...(verdictAttr ? { "data-v": verdictAttr } : {})}>
            {verdict}
          </span>
        ) : (
          <span>Operator</span>
        )}
        <TurnWhen at={event.at} />
      </div>
      {body ? <p>{body}</p> : null}
    </div>
  );
}

function SystemTurn({ event }: { event: StageLogEvent }) {
  const description = formatActivityDescription(event);
  const label = formatActivityLabel(event);
  return (
    <div className="divider-iter">
      {description ? `${label} · ${description}` : label}
    </div>
  );
}

export type TranscriptTurnKind =
  | "tools"
  | "message"
  | "operator_prompt"
  | "operator_answer"
  | "system";

export type TranscriptTurnModel =
  | { kind: "tools"; calls: ToolCallView[] }
  | { kind: "message"; event: StageLogEvent }
  | { kind: "operator_prompt"; event: StageLogEvent }
  | { kind: "operator_answer"; event: StageLogEvent }
  | { kind: "system"; event: StageLogEvent };

export function buildTranscriptTurns(
  events: StageLogEvent[],
): TranscriptTurnModel[] {
  const turns: TranscriptTurnModel[] = [];
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
        turns.push({ kind: "message", event: ev });
      }
    } else if (ev.event === "operator_prompt") {
      turns.push({ kind: "operator_prompt", event: ev });
    } else if (ev.event === "operator_answer") {
      turns.push({ kind: "operator_answer", event: ev });
    } else {
      turns.push({ kind: "system", event: ev });
    }
    i += 1;
  }
  return turns;
}

export function TranscriptTurns({
  events,
  inboundEnvelope,
}: {
  events: StageLogEvent[];
  inboundEnvelope?: StageEnvelopeView | null;
}) {
  const nodes: ReactNode[] = [];

  if (inboundEnvelope) {
    nodes.push(
      <InboundEnvelopeTurn key="inbound-envelope" envelope={inboundEnvelope} />,
    );
  }

  const turns = buildTranscriptTurns(events);
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    if (turn.kind === "tools") {
      nodes.push(<ToolGroup key={`tools-${t}`} calls={turn.calls} />);
      continue;
    }
    if (turn.kind === "message") {
      nodes.push(<MessageTurn key={eventKey(turn.event, t)} event={turn.event} />);
      continue;
    }
    if (turn.kind === "operator_prompt") {
      nodes.push(<AskTurn key={eventKey(turn.event, t)} event={turn.event} />);
      continue;
    }
    if (turn.kind === "operator_answer") {
      nodes.push(
        <AnswerTurn key={eventKey(turn.event, t)} event={turn.event} />,
      );
      continue;
    }
    nodes.push(<SystemTurn key={eventKey(turn.event, t)} event={turn.event} />);
  }

  if (nodes.length === 0) {
    return <p className="muted">No activity yet.</p>;
  }

  return <>{nodes}</>;
}
