import { useState, type ReactNode } from "react";
import {
  LuCheck,
  LuChevronRight,
  LuFileSearch,
  LuSparkles,
  LuTerminal,
  LuX,
} from "react-icons/lu";
import type {
  StageAnswer,
  StageEnvelopeView,
  StageLogEvent,
} from "../../api";
import {
  formatActivityDescription,
} from "../../status/activityCopy";
import { formatEventTime } from "./runEventsView";
import {
  formatToolCallDuration,
  toolCallArgSummary,
} from "./runDetailTranscriptFormat";
import {
  buildRunDetailTranscriptTurns,
  stageAgentLabel,
  type ToolCallView,
} from "./runDetailTranscriptModel";

const TOOL_VISIBLE_LIMIT = 4;

function eventKey(event: StageLogEvent, index: number): string {
  return `${event.event}-${event.at ?? "na"}-${index}`;
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

function messageAuthorLabel(role: string, stageLabel: string): string {
  if (role === "user") return "Operator";
  if (role === "assistant" || role === "thinking" || role === "opening") {
    return stageAgentLabel(stageLabel);
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function messageBodyClass(role: string): string {
  if (role === "thinking" || role === "opening") {
    return "text-[13px] leading-[1.55] text-[#a7aab2] whitespace-pre-wrap";
  }
  return "text-[13px] leading-[1.55] text-[var(--sf-text-1)] whitespace-pre-wrap";
}

function ToolIcon({ name }: { name: string }) {
  const key = name.toLowerCase();
  const className = "size-3.5 shrink-0 text-[var(--sf-text-3)]";
  if (key === "bash" || key === "shell") {
    return <LuTerminal className={className} aria-hidden="true" />;
  }
  if (
    key === "read" ||
    key === "grep" ||
    key === "glob" ||
    key === "write" ||
    key === "edit"
  ) {
    return <LuFileSearch className={className} aria-hidden="true" />;
  }
  return <LuTerminal className={className} aria-hidden="true" />;
}

function toolRowResultLabel(call: ToolCallView): string | undefined {
  if (call.status === "running") return undefined;
  const raw = call.result?.trim();
  if (!raw) return undefined;
  const line = raw.split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > 48 ? `${line.slice(0, 45)}…` : line;
}

function ToolRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const arg = toolCallArgSummary(call);
  const now = Date.now();
  const duration = formatToolCallDuration(call, now);
  const resultLabel = toolRowResultLabel(call);
  const detail =
    call.status === "running"
      ? call.progressPreview
      : call.status === "error"
        ? call.result
        : call.result;
  const hasDetail = Boolean(detail?.trim());

  return (
    <div className="border-b border-b-[#ffffff12] last:border-b-0">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left disabled:cursor-default"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <LuChevronRight
          className={`size-3 shrink-0 text-[var(--sf-text-3)] transition-transform${
            open ? " rotate-90" : ""
          }${hasDetail ? "" : " opacity-0"}`}
          aria-hidden="true"
        />
        <ToolIcon name={call.name} />
        <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]">
          {call.name}
        </span>
        {arg ? (
          <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
            {arg}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {call.status === "running" ? (
          <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            …
          </span>
        ) : null}
        {resultLabel && call.status === "complete" ? (
          <span className="flex shrink-0 items-center gap-1">
            <LuCheck
              className="size-3 shrink-0 text-[var(--sf-ok)]"
              aria-hidden="true"
            />
            <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-ok)]">
              {resultLabel}
            </span>
          </span>
        ) : null}
        {resultLabel && call.status === "error" ? (
          <span className="flex shrink-0 items-center gap-1">
            <LuX
              className="size-3 shrink-0 text-[var(--sf-fail)]"
              aria-hidden="true"
            />
            <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-fail)]">
              {resultLabel}
            </span>
          </span>
        ) : null}
        {duration ? (
          <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            {duration}
          </span>
        ) : null}
        {call.status === "complete" && !resultLabel ? (
          <LuCheck
            className="size-3 shrink-0 text-[var(--sf-ok)]"
            aria-hidden="true"
          />
        ) : null}
        {call.status === "error" && !resultLabel ? (
          <LuX
            className="size-3 shrink-0 text-[var(--sf-fail)]"
            aria-hidden="true"
          />
        ) : null}
      </button>
      {open && hasDetail ? (
        <pre className="max-h-40 overflow-auto border-t border-t-[#ffffff12] bg-[var(--sf-raised)] px-3 py-2 font-['Geist_Mono',monospace] text-[11px] leading-relaxed text-[var(--sf-text-2)] whitespace-pre-wrap">
          {detail}
        </pre>
      ) : null}
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
    <div className="ml-[30px] overflow-hidden rounded-lg border border-[#ffffff12]">
      {visible.map((call, i) => (
        <ToolRow key={`${call.name}-${call.at ?? i}`} call={call} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="h-8 w-full px-3 text-left text-[11px] text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} more
        </button>
      ) : null}
    </div>
  );
}

function AgentAvatar() {
  return (
    <div
      className="flex size-5 shrink-0 items-center justify-center rounded-md border border-[#ffffff12] bg-[#1a1c21]"
      aria-hidden="true"
    >
      <LuSparkles className="size-[11px] text-[var(--sf-text-3)]" />
    </div>
  );
}

function OperatorAvatar() {
  return (
    <div
      className="flex size-5 shrink-0 items-center justify-center rounded-md border border-[#ffffff12] bg-[#1a1c21] text-[10px] font-medium text-[var(--sf-text-2)]"
      aria-hidden="true"
    >
      Op
    </div>
  );
}

function MessageTurn({
  event,
  stageLabel,
}: {
  event: StageLogEvent;
  stageLabel: string;
}) {
  const role = event.role ?? "message";
  const text = event.text?.trim();
  if (!text) return null;
  const isOperator = role === "user";

  return (
    <div className="flex gap-2.5">
      {isOperator ? <OperatorAvatar /> : <AgentAvatar />}
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--sf-text-1)]">
            {messageAuthorLabel(role, stageLabel)}
          </span>
          {event.at ? (
            <time className="font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
              {formatEventTime(event.at)}
            </time>
          ) : null}
        </div>
        <p className={messageBodyClass(role)}>{text}</p>
      </div>
    </div>
  );
}

function InboundEnvelopeTurn({ envelope }: { envelope: StageEnvelopeView }) {
  return (
    <div className="flex gap-2.5">
      <AgentAvatar />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--sf-text-1)]">
            Envelope
          </span>
        </div>
        <div className="rounded-lg border border-[var(--sf-ok)]/40 bg-[var(--sf-raised)] px-3 py-2">
          <p className="text-[13px] text-[var(--sf-text-1)]">{envelope.summary}</p>
          {envelope.artifacts.length > 0 ? (
            <p className="mt-1 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
              {envelope.artifacts
                .map((path) => path.split("/").pop() ?? path)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AnswerTurn({ event }: { event: StageLogEvent }) {
  const answer = asAnswer(event.answer);
  let verdict: string | undefined;
  let body: string | undefined;

  if (answer?.kind === "free_text") {
    verdict = "Operator";
    body = answer.text;
  } else if (answer?.kind === "confirm" || answer?.kind === "artifact_backed") {
    verdict = "Operator";
    body = answer.text?.trim()
      ? answer.text
      : answer.decision;
  } else if (answer?.kind === "multi_question") {
    verdict = "Operator";
    const parts = Object.entries(answer.answers ?? {}).map(
      ([id, value]) => `${id}: ${value}`,
    );
    body = parts.length > 0 ? parts.join("\n") : undefined;
  } else {
    body = formatActivityDescription(event);
    verdict = "Operator";
  }

  return (
    <div className="flex gap-2.5">
      <OperatorAvatar />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--sf-text-1)]">
            {verdict ?? "Operator"}
          </span>
          {event.at ? (
            <time className="font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
              {formatEventTime(event.at)}
            </time>
          ) : null}
        </div>
        {body ? (
          <p className="text-[13px] leading-[1.55] text-[var(--sf-text-2)] whitespace-pre-wrap">
            {body}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function RunDetailTranscriptTurns({
  events,
  inboundEnvelope,
  stageLabel,
}: {
  events: StageLogEvent[];
  inboundEnvelope?: StageEnvelopeView | null;
  stageLabel: string;
}) {
  const nodes: ReactNode[] = [];

  if (inboundEnvelope) {
    nodes.push(
      <InboundEnvelopeTurn key="inbound-envelope" envelope={inboundEnvelope} />,
    );
  }

  const turns = buildRunDetailTranscriptTurns(events);
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    if (turn.kind === "tools") {
      nodes.push(<ToolGroup key={`tools-${t}`} calls={turn.calls} />);
      continue;
    }
    if (turn.kind === "message") {
      nodes.push(
        <MessageTurn
          key={eventKey(turn.event, t)}
          event={turn.event}
          stageLabel={stageLabel}
        />,
      );
      continue;
    }
    if (turn.kind === "operator_answer") {
      nodes.push(
        <AnswerTurn key={eventKey(turn.event, t)} event={turn.event} />,
      );
    }
  }

  if (nodes.length === 0) {
    return (
      <p className="text-[13px] text-[var(--sf-text-3)]">No activity yet.</p>
    );
  }

  return <>{nodes}</>;
}
