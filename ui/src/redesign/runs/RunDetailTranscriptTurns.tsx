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
  presentToolResult,
  toolCallArgSummary,
  toolResultSummary,
  type ToolResultPresentation,
} from "./runDetailTranscriptFormat";
import {
  buildRunDetailTranscriptTurns,
  stageAgentLabel,
  type ToolCallView,
} from "./runDetailTranscriptModel";

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
  return toolResultSummary(raw) || undefined;
}

function ToolResultBody({ text }: { text: string }) {
  const view = presentToolResult(text);
  if (view.kind === "text") {
    return (
      <pre className="font-['Geist_Mono',monospace] text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--sf-text-2)]">
        {view.text}
      </pre>
    );
  }
  if (view.kind === "rows") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[12px] font-medium text-[var(--sf-text-1)]">
          {view.headline}
        </p>
        <ul className="flex flex-col">
          {view.rows.map((row, index) => (
            <li
              key={`${row.primary}-${index}`}
              className="flex items-baseline gap-2 border-b border-b-[#ffffff0d] py-1 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-1)]">
                {row.primary}
              </span>
              {row.secondary ? (
                <span className="shrink-0 text-[11px] text-[var(--sf-text-3)]">
                  {row.secondary}
                </span>
              ) : null}
              {row.stat ? (
                <span className="shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
                  {row.stat}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {view.more > 0 ? (
          <p className="text-[11px] text-[var(--sf-text-3)]">
            {view.more} more
          </p>
        ) : null}
      </div>
    );
  }
  return <ToolResultCard view={view} />;
}

function ToolResultCard({
  view,
}: {
  view: Extract<ToolResultPresentation, { kind: "card" }>;
}) {
  const [proseOpen, setProseOpen] = useState(false);
  const prose = view.prose?.trim();
  const proseLong = Boolean(prose && (prose.length > 280 || prose.split("\n").length > 6));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] font-medium leading-snug text-[var(--sf-text-1)]">
        {view.headline}
      </p>
      {view.fields.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {view.fields.map((field) => (
            <div key={field.label} className="flex items-baseline gap-1.5">
              <span className="text-[11px] text-[var(--sf-text-3)]">
                {field.label}
              </span>
              {field.href ? (
                <a
                  className="text-[11px] text-[var(--sf-text-1)] underline decoration-[#ffffff24] underline-offset-2"
                  href={field.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {field.value}
                </a>
              ) : (
                <span className="text-[11px] text-[var(--sf-text-1)]">
                  {field.value}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {prose ? (
        <div className="flex flex-col gap-1">
          <p
            className={`text-[12px] leading-relaxed whitespace-pre-wrap text-[var(--sf-text-2)]${
              proseLong && !proseOpen ? " line-clamp-6" : ""
            }`}
          >
            {prose}
          </p>
          {proseLong ? (
            <button
              type="button"
              className="self-start text-[11px] text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"
              onClick={() => setProseOpen((open) => !open)}
            >
              {proseOpen ? "Show less" : "Show full text"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function presentedResult(call: ToolCallView): ToolResultPresentation | undefined {
  if (!call.result) return undefined;
  return presentToolResult(call.result);
}

function isEmptyResult(call: ToolCallView): boolean {
  const view = presentedResult(call);
  return Boolean(
    view && view.kind === "card" && !view.prose && view.fields.length === 0,
  );
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
  const hasDetail = Boolean(detail?.trim()) && !isEmptyResult(call);

  return (
    <div className="border-b border-b-[#ffffff12] last:border-b-0">
      <button
        type="button"
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left disabled:cursor-default"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
        onClick={() => {
          if (!hasDetail) return;
          setOpen((v) => !v);
        }}
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
        <div className="max-h-40 overflow-auto border-t border-t-[#ffffff12] bg-[var(--sf-raised)] px-3 py-2">
          <ToolResultBody text={detail ?? ""} />
        </div>
      ) : null}
    </div>
  );
}

function ToolGroup({ calls }: { calls: ToolCallView[] }) {
  return (
    <div className="ml-[30px] shrink-0 overflow-hidden rounded-lg border border-[#ffffff12]">
      {calls.map((call, i) => (
        <ToolRow key={`${call.name}-${call.at ?? i}`} call={call} />
      ))}
    </div>
  );
}

function ToolResultTurn({ text, at }: { text: string; at?: string }) {
  return (
    <div className="ml-[30px] shrink-0 overflow-hidden rounded-lg border border-[#ffffff12]">
      <div className="flex h-8 items-center gap-2 px-2.5">
        <LuTerminal
          className="size-3.5 shrink-0 text-[var(--sf-text-3)]"
          aria-hidden="true"
        />
        <span className="text-xs font-medium text-[var(--sf-text-1)]">
          Tool result
        </span>
        {at ? (
          <time className="font-['Geist_Mono',monospace] text-[11px] text-[#8b8f98]">
            {formatEventTime(at)}
          </time>
        ) : null}
      </div>
      <div className="max-h-40 overflow-auto border-t border-t-[#ffffff12] bg-[var(--sf-raised)] px-3 py-2">
        <ToolResultBody text={text} />
      </div>
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
    <div className="flex shrink-0 gap-2.5">
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
    <div className="flex shrink-0 gap-2.5">
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
    <div className="flex shrink-0 gap-2.5">
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
    if (turn.kind === "tool_result") {
      nodes.push(
        <ToolResultTurn key={`result-${t}`} text={turn.text} at={turn.at} />,
      );
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
