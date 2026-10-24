import type { EvalResultDetail } from "../../../api/evalTypes";
import { formatCost, formatDuration } from "../format";

export type PolicyOutcome = "ran" | "stubbed" | "mocked" | "would_ask_first" | "denied";
export type CallStatus = "ok" | "error" | "not_run";

export type SubjectMessage = { role: "user" | "assistant"; text: string; turn: number };
export type SubjectToolCall = {
  id: string;
  turn: number;
  name: string;
  args: unknown;
  result_summary: string;
  status: CallStatus;
  policy_outcome: PolicyOutcome;
  session_id?: string;
};

export type ConversationSubject = {
  kind: "conversation";
  status: "success" | "failure";
  summary: string;
  messages: SubjectMessage[];
  tool_calls: SubjectToolCall[];
  final_reply: string;
  turns: number;
  stop_reason: string;
  usage?: Record<string, unknown>;
  truncated?: { messages?: number; tool_results?: number; tool_args?: number; tool_calls_dropped?: number };
};

export function asSubject(output: unknown): ConversationSubject | null {
  if (output === null || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (o.kind !== "conversation" && !Array.isArray(o.messages)) return null;
  return {
    kind: "conversation",
    status: o.status === "failure" ? "failure" : "success",
    summary: typeof o.summary === "string" ? o.summary : "",
    messages: Array.isArray(o.messages) ? (o.messages as SubjectMessage[]) : [],
    tool_calls: Array.isArray(o.tool_calls) ? (o.tool_calls as SubjectToolCall[]) : [],
    final_reply: typeof o.final_reply === "string" ? o.final_reply : "",
    turns: typeof o.turns === "number" ? o.turns : 0,
    stop_reason: typeof o.stop_reason === "string" ? o.stop_reason : "",
    ...(o.usage && typeof o.usage === "object" ? { usage: o.usage as Record<string, unknown> } : {}),
    ...(o.truncated && typeof o.truncated === "object" ? { truncated: o.truncated as ConversationSubject["truncated"] } : {}),
  };
}

export const STOP_REASON_LABELS: Record<string, string> = {
  resolved: "Resolved",
  abandoned: "Gave up",
  max_turns: "Turn limit",
  script_end: "Script ended",
  no_progress: "Repeated itself",
  empty_message: "Empty message",
  error: "Agent failed",
  timeout: "Timed out",
};

export function stopReasonLabel(reason: string): string {
  return STOP_REASON_LABELS[reason] ?? (reason === "" ? "Ended" : reason);
}

export type BadgeTone = "ok" | "neutral" | "running" | "needs" | "fail";
export type OutcomeBadge = { label: string; tone: BadgeTone; tooltip: string };

export const OUTCOME_BADGES: Record<PolicyOutcome, OutcomeBadge> = {
  ran: { label: "Ran", tone: "ok", tooltip: "The tool ran." },
  stubbed: { label: "Stubbed", tone: "neutral", tooltip: "Not executed in this evaluation" },
  mocked: { label: "Mocked", tone: "running", tooltip: "Canned result from the scenario" },
  would_ask_first: { label: "Would ask first", tone: "needs", tooltip: "The agent needed approval; it was recorded and denied" },
  denied: { label: "Denied", tone: "fail", tooltip: "Not allowed by the agent's grants or the eval policy" },
};

export function outcomeBadge(outcome: string): OutcomeBadge {
  return OUTCOME_BADGES[outcome as PolicyOutcome] ?? { label: outcome, tone: "neutral", tooltip: "" };
}

const STATUS_TEXT: Record<CallStatus, string> = { ok: "ok", error: "error", not_run: "not run" };

const TRUNCATION = /…\[truncated (\d+) chars\]$/;

/** Cut text ends with a marker; the view shows it as a muted note instead of part of the message. */
export function splitTruncation(text: string): { body: string; note: string | null } {
  const match = TRUNCATION.exec(text);
  if (!match) return { body: text, note: null };
  return { body: text.slice(0, match.index), note: `…[truncated ${match[1]} chars]` };
}

export type ChipView = {
  id: string;
  name: string;
  badge: OutcomeBadge;
  statusText: string;
  argsText: string;
  resultText: string;
  resultNote: string | null;
  subSession: string | null;
};

function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    return String(args);
  }
}

export function chipView(call: SubjectToolCall): ChipView {
  const result = splitTruncation(call.result_summary ?? "");
  return {
    id: call.id,
    name: call.name,
    badge: outcomeBadge(call.policy_outcome),
    statusText: STATUS_TEXT[call.status] ?? String(call.status),
    argsText: prettyArgs(call.args),
    resultText: result.body === "" ? "(no result)" : result.body,
    resultNote: result.note,
    subSession: call.session_id ?? null,
  };
}

export type BubbleView = { role: "user" | "assistant"; text: string; note: string | null };
export type TurnView = { turn: number; bubbles: BubbleView[]; chips: ChipView[] };

export function turnViews(subject: ConversationSubject): TurnView[] {
  const turns = new Map<number, TurnView>();
  const at = (turn: number) => {
    let view = turns.get(turn);
    if (!view) {
      view = { turn, bubbles: [], chips: [] };
      turns.set(turn, view);
    }
    return view;
  };
  for (const m of subject.messages) {
    const split = splitTruncation(m.text);
    at(m.turn).bubbles.push({ role: m.role, text: split.body, note: split.note });
  }
  for (const call of subject.tool_calls) at(call.turn).chips.push(chipView(call));
  return [...turns.values()].sort((a, b) => a.turn - b.turn);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type HeaderChips = { stop: string; turns: string; calls: string; time: string; cost: string };

export function headerChips(result: Pick<EvalResultDetail, "latency_ms" | "cost_usd">, subject: ConversationSubject): HeaderChips {
  return {
    stop: stopReasonLabel(subject.stop_reason),
    turns: plural(subject.turns, "turn", "turns"),
    calls: plural(subject.tool_calls.length, "tool call", "tool calls"),
    time: formatDuration(result.latency_ms),
    cost: formatCost(result.cost_usd),
  };
}

export type ChecklistRow = { text: string; kind: "expected" | "forbidden"; ok: boolean; note: string };

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith(".*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Expected and forbidden tools from the scenario against the recorded calls; shown only when the scenario has them. */
export function expectedChecklist(expected: unknown, subject: ConversationSubject): ChecklistRow[] | null {
  const record = expected !== null && typeof expected === "object" && !Array.isArray(expected) ? (expected as Record<string, unknown>) : {};
  const want = stringList(record.tools);
  const forbidden = stringList(record.forbidden_tools);
  if (want.length === 0 && forbidden.length === 0) return null;
  const names = subject.tool_calls.map((c) => c.name);
  return [
    ...want.map((t) => {
      const ok = names.some((n) => matches(t, n));
      return { text: t, kind: "expected" as const, ok, note: ok ? "called" : "not called" };
    }),
    ...forbidden.map((t) => {
      const hit = names.some((n) => matches(t, n));
      return { text: t, kind: "forbidden" as const, ok: !hit, note: hit ? "called" : "not called" };
    }),
  ];
}

export function truncationNotes(subject: ConversationSubject): string[] {
  const t = subject.truncated;
  if (!t) return [];
  const out: string[] = [];
  if ((t.messages ?? 0) > 0) out.push(`${plural(t.messages ?? 0, "message", "messages")} left out of the middle of the conversation`);
  if ((t.tool_calls_dropped ?? 0) > 0) out.push(`${plural(t.tool_calls_dropped ?? 0, "tool call", "tool calls")} not shown`);
  if ((t.tool_results ?? 0) > 0) out.push(`${plural(t.tool_results ?? 0, "tool result", "tool results")} shortened`);
  if ((t.tool_args ?? 0) > 0) out.push(`${plural(t.tool_args ?? 0, "set of arguments", "sets of arguments")} shortened`);
  return out;
}

export const ERROR_LABELS: Record<string, string> = {
  EVAL_AGENT_FAILED: "Agent failed",
  EVAL_AGENT_EMPTY_REPLY: "Empty reply",
  EVAL_AGENT_TIMEOUT: "Timed out",
  EVAL_SIMULATOR_ERROR: "Simulator error",
  EVAL_ENGINE_ERROR: "Engine error",
  EVAL_CANCELLED: "Cancelled",
  EVAL_BUDGET_EXCEEDED: "Cost limit reached",
};

export function errorLabel(code: string | null): string | null {
  return code ? (ERROR_LABELS[code] ?? null) : null;
}

export const SESSION_DELETED = "agent session deleted";
export const TRANSCRIPT_EMPTY = "No transcript was recorded for this result.";
export const TRANSCRIPT_LOADING = "Loading transcript…";

export type SessionLink = { agentId: string; sessionId: string };

/** The Agent run page link: needs the agent id and session id from the result. */
export function sessionLink(result: Pick<EvalResultDetail, "agent" | "subject_ref">): SessionLink | null {
  const sessionId = result.agent?.session_id ?? result.subject_ref ?? null;
  const agentId = result.agent?.id ?? null;
  return sessionId && agentId ? { agentId, sessionId } : null;
}

export type TranscriptView = {
  subject: ConversationSubject;
  chips: HeaderChips;
  turns: TurnView[];
  failed: boolean;
  notes: string[];
};

export function transcriptView(result: EvalResultDetail): TranscriptView | null {
  const subject = asSubject(result.output);
  if (!subject) return null;
  return {
    subject,
    chips: headerChips(result, subject),
    turns: turnViews(subject),
    failed: result.status !== "completed" || subject.status === "failure",
    notes: truncationNotes(subject),
  };
}

export function isAgentResult(result: Pick<EvalResultDetail, "agent" | "output" | "stage_run_id">): boolean {
  return result.agent != null || asSubject(result.output) !== null;
}
