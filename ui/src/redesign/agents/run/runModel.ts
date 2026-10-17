import type { AgentApproval, AgentSpan } from "../../../api/agents";
import { formatDuration, formatTokens } from "../model/format";
import type { RunView } from "../model/sessionView";

/** Pure view-model for the run inspector tabs. */

export type KindGroup = "agent" | "model" | "tool" | "gate" | "guardrail" | "internal";

export const KIND_LABEL: Record<KindGroup, string> = {
  agent: "Agent",
  model: "LLM",
  tool: "Tool",
  gate: "Human gate",
  guardrail: "Guardrail",
  internal: "Internal",
};

export function kindGroup(span: Pick<AgentSpan, "kind">): KindGroup {
  switch (span.kind) {
    case "agent":
    case "sub_agent":
      return "agent";
    case "model":
    case "tool":
    case "gate":
    case "guardrail":
      return span.kind;
    default:
      return "internal";
  }
}

export type SpanRow = { span: AgentSpan; depth: number };

/** Spans depth-first by parent, siblings by start time; orphans become roots. */
export function orderSpans(spans: AgentSpan[]): SpanRow[] {
  const byStart = (a: AgentSpan, b: AgentSpan) => Date.parse(a.startedAt) - Date.parse(b.startedAt);
  const ids = new Set(spans.map((s) => s.id));
  const children = new Map<string | null, AgentSpan[]>();
  for (const span of [...spans].sort(byStart)) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  const rows: SpanRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      rows.push({ span, depth });
      if (depth < 12) walk(span.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function spanModel(span: AgentSpan): string | null {
  const model = span.attributes["gen_ai.request.model"];
  return typeof model === "string" ? model : null;
}

export function spanTokens(span: AgentSpan): number {
  return (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
}

/** Dim text after the span name: model and tokens for LLM calls, tool name otherwise. */
export function spanDetail(span: AgentSpan): string {
  const parts: string[] = [];
  const model = spanModel(span);
  if (span.kind === "model" && model) parts.push(model);
  const tool = span.attributes["gen_ai.tool.name"];
  if (typeof tool === "string" && !span.name.includes(tool)) parts.push(tool);
  if (spanTokens(span) > 0) parts.push(`${formatTokens(spanTokens(span))} tok`);
  return parts.join(" · ");
}

export function spanCost(span: AgentSpan): number | null {
  const cost = span.attributes["gen_ai.usage.cost_usd"];
  return typeof cost === "number" ? cost : null;
}

export type FilterId = "all" | KindGroup | "errors";

export function filterCounts(spans: AgentSpan[]): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: spans.length, agent: 0, model: 0, tool: 0, gate: 0, guardrail: 0, internal: 0, errors: 0 };
  for (const span of spans) {
    counts[kindGroup(span)] += 1;
    if (span.status === "error") counts.errors += 1;
  }
  return counts;
}

export function matchesFilter(span: AgentSpan, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return span.status === "error";
  return kindGroup(span) === filter;
}

/** The span to show first: the first failure, else the first tool call, else the root. */
export function defaultSpanId(spans: AgentSpan[]): string | null {
  const rows = orderSpans(spans);
  return (rows.find((r) => r.span.status === "error") ?? rows.find((r) => r.span.kind === "tool") ?? rows[0])?.span.id ?? null;
}

type TimeSlice = { id: string; label: string; ms: number; percent: number; color: string };

export function timeBreakdown(run: RunView): TimeSlice[] {
  const sum = (kind: string) => run.spans.filter((s) => s.kind === kind).reduce((total, s) => total + (s.durationMs ?? 0), 0);
  const llm = sum("model");
  const tool = sum("tool") + sum("sub_agent");
  const human = run.waitingMs;
  const other = Math.max(0, run.elapsedMs - llm - tool - human);
  const total = Math.max(1, llm + tool + human + other);
  return [
    { id: "llm", label: "LLM", ms: llm, color: "var(--sf-running)" },
    { id: "tool", label: "Tool", ms: tool, color: "#2dd4bf" },
    { id: "human", label: "Human wait", ms: human, color: "var(--sf-needs)" },
    { id: "other", label: "Other", ms: other, color: "#5b5f68" },
  ]
    .filter((slice) => slice.ms > 0)
    .map((slice) => ({ ...slice, percent: Math.round((slice.ms / total) * 100) }));
}

/** The longest chain of top-level work, e.g. "chat → execute_tool search ×2 → chat". */
export function criticalPath(spans: AgentSpan[]): string {
  const rows = orderSpans(spans).filter((r) => r.depth === 1 || (r.depth === 0 && spans.length === 1));
  const names: Array<{ name: string; count: number }> = [];
  for (const { span } of rows) {
    const name = span.name.split(" ")[0] === "execute_tool" ? span.name.replace("execute_tool ", "") : span.name.split(" ")[0]!;
    const last = names[names.length - 1];
    if (last?.name === name) last.count += 1;
    else names.push({ name, count: 1 });
  }
  return names.map((n) => (n.count > 1 ? `${n.name} ×${n.count}` : n.name)).join(" → ");
}

export type LogLevel = "INFO" | "WARN" | "ERROR";
export type LogRecord = { id: string; offsetMs: number; level: LogLevel; source: string; message: string; spanId: string | null };

function outcomeText(span: AgentSpan): string {
  const message = span.attributes["error.message"] ?? span.attributes["exception.message"];
  if (typeof message === "string") return message;
  return span.status === "error" ? "failed" : span.status === "cancelled" ? "stopped" : "ok";
}

/**
 * Log records are not stored separately, so the Logs tab narrates what the run
 * recorded: one line per finished span plus approvals and the final reply.
 */
export function runLogs(run: RunView): LogRecord[] {
  const start = Date.parse(run.turn.startedAt);
  const at = (iso: string) => Math.max(0, Date.parse(iso) - start);
  const records: LogRecord[] = [{ id: "start", offsetMs: 0, level: "INFO", source: "run", message: `Run #${run.turn.seq} started on revision v${run.turn.revision}`, spanId: null }];
  for (const span of run.spans) {
    const name = span.name.split(" ")[0]!;
    const detail = spanDetail(span);
    const level: LogLevel = span.status === "error" ? "ERROR" : span.status === "cancelled" ? "WARN" : "INFO";
    const message =
      span.kind === "model"
        ? `${detail || "model call"} · finished in ${formatDuration(span.durationMs)}`
        : span.kind === "agent"
          ? `${span.name} ${outcomeText(span)} · ${formatDuration(span.durationMs)}`
          : `${span.name} ${outcomeText(span)} · ${formatDuration(span.durationMs)}`;
    records.push({ id: `span-${span.id}`, offsetMs: at(span.endedAt ?? span.startedAt), level, source: name, message, spanId: span.id });
  }
  for (const approval of run.approvals) {
    records.push({ id: `ask-${approval.id}`, offsetMs: at(approval.createdAt), level: "WARN", source: "approval", message: `Waiting for approval to run ${approval.tool}`, spanId: null });
    if (approval.decidedAt) {
      records.push({ id: `decide-${approval.id}`, offsetMs: at(approval.decidedAt), level: approval.status === "approved" ? "INFO" : "WARN", source: "approval", message: `${approval.tool} ${approval.status}`, spanId: null });
    }
  }
  if (run.turn.errorCode) {
    records.push({ id: "error", offsetMs: at(run.turn.endedAt ?? run.turn.startedAt), level: "ERROR", source: "run", message: run.turn.errorCode, spanId: null });
  }
  return records.sort((a, b) => a.offsetMs - b.offsetMs);
}

export type StepState = "done" | "failed" | "waiting" | "queued" | "pending";
export type StepKind = "message" | "model" | "tool" | "agent" | "guardrail" | "gate" | "final";
export type Step = {
  id: string;
  kind: StepKind;
  state: StepState;
  title: string;
  tag: string | null;
  detail: string | null;
  at: string | null;
  durationMs: number | null;
  tokens: number;
  cost: number | null;
  spanId: string | null;
  approval: AgentApproval | null;
};

function snippet(text: string | null | undefined, max = 220): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toolName(span: AgentSpan): string {
  const tool = span.attributes["gen_ai.tool.name"];
  return typeof tool === "string" ? tool : span.name.replace(/^(execute_tool|invoke_agent) /, "");
}

/** The run as a readable story: what came in, what the agent did, what is still ahead. */
export function runSteps(run: RunView): Step[] {
  const steps: Step[] = [];
  const spans = orderSpans(run.spans).map((r) => r.span);
  const root = spans.find((s) => s.parentSpanId === null && s.kind === "agent") ?? null;
  const work = spans.filter((s) => s.id !== root?.id);

  if (run.prompt) {
    steps.push({ id: "prompt", kind: "message", state: "done", title: "Received a message", tag: null, detail: snippet(run.prompt.text), at: run.prompt.createdAt, durationMs: null, tokens: 0, cost: null, spanId: null, approval: null });
  }

  for (const span of work) {
    const failed = span.status === "error";
    const base = { state: (failed ? "failed" : "done") as StepState, at: span.startedAt, durationMs: span.durationMs, tokens: spanTokens(span), cost: spanCost(span), spanId: span.id, approval: null };
    switch (span.kind) {
      case "model":
        steps.push({ ...base, id: span.id, kind: "model", title: "Thought and answered", tag: spanModel(span), detail: snippet(span.outputText) ?? (spanTokens(span) > 0 ? `${formatTokens(span.inputTokens ?? 0)} in · ${formatTokens(span.outputTokens ?? 0)} out` : null) });
        break;
      case "tool":
        steps.push({ ...base, id: span.id, kind: "tool", title: `Used ${toolName(span)}`, tag: toolName(span), detail: snippet(span.inputText) ?? (failed ? "The tool call failed" : null) });
        break;
      case "sub_agent":
        steps.push({ ...base, id: span.id, kind: "agent", title: `Asked ${toolName(span).replace(/^agent:/, "")} for help`, tag: "sub-agent", detail: snippet(span.outputText) ?? snippet(span.inputText) });
        break;
      case "guardrail":
        steps.push({ ...base, id: span.id, kind: "guardrail", title: failed ? "Blocked by a guardrail" : span.name.startsWith("eval") ? "Scored the reply" : "Checked against policy", tag: failed ? "blocked" : "passed", detail: span.attributes["stageflow.guardrail.pattern"] ? `matched ${String(span.attributes["stageflow.guardrail.pattern"])}` : null });
        break;
      case "gate": {
        const tool = toolName(span);
        steps.push({ ...base, id: span.id, kind: "gate", state: failed ? "failed" : "done", title: failed ? `${tool} was not approved` : `${tool} was approved`, tag: "human gate", detail: `Waited ${formatDuration(span.durationMs)} for a person` });
        break;
      }
      default:
        steps.push({ ...base, id: span.id, kind: "tool", title: span.name, tag: null, detail: snippet(span.outputText) });
    }
  }

  const pending = run.approvals.find((a) => a.status === "pending") ?? null;
  if (pending) {
    steps.push({ id: `ask-${pending.id}`, kind: "gate", state: "waiting", title: "Waiting for your approval", tag: "human gate", detail: `Run ${pending.tool}`, at: pending.createdAt, durationMs: null, tokens: 0, cost: null, spanId: null, approval: pending });
    steps.push({ id: `after-${pending.id}`, kind: "tool", state: "queued", title: `Run ${pending.tool}`, tag: pending.tool, detail: "Runs after you approve", at: null, durationMs: null, tokens: 0, cost: null, spanId: null, approval: null });
  }
  if (run.reply) {
    steps.push({ id: "reply", kind: "final", state: "done", title: "Replied", tag: null, detail: snippet(run.reply.text, 400), at: run.reply.createdAt, durationMs: null, tokens: 0, cost: null, spanId: null, approval: null });
  } else if (run.turn.status === "running" || run.turn.status === "waiting") {
    steps.push({ id: "reply", kind: "final", state: "pending", title: "Final answer", tag: null, detail: "Appears when the run finishes", at: null, durationMs: null, tokens: 0, cost: null, spanId: null, approval: null });
  }
  return steps;
}
