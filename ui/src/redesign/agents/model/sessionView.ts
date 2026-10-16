import type { AgentApproval, AgentMessage, AgentSessionDetail, AgentSpan, AgentTurn } from "../../../api/agents";

/** One run (turn) of a session with everything recorded against it. */
export type RunView = {
  turn: AgentTurn;
  prompt: AgentMessage | null;
  reply: AgentMessage | null;
  spans: AgentSpan[];
  approvals: AgentApproval[];
  /** Wall time from start to end (or now while running/waiting). */
  elapsedMs: number;
  /** Elapsed minus time spent waiting on people. */
  workingMs: number;
  waitingMs: number;
  tokens: number;
};

function ms(iso: string | null | undefined, fallback: number): number {
  return iso ? Date.parse(iso) : fallback;
}

function approvalWaitMs(approval: AgentApproval, now: number): number {
  return Math.max(0, ms(approval.decidedAt, now) - Date.parse(approval.createdAt));
}

export function runViews(detail: AgentSessionDetail, now: number = Date.now()): RunView[] {
  return detail.turns.map((turn) => {
    const messages = detail.messages.filter((message) => message.turnId === turn.id);
    const approvals = detail.approvals.filter((approval) => approval.turnId === turn.id);
    const elapsedMs = Math.max(0, ms(turn.endedAt, now) - Date.parse(turn.startedAt));
    const waitingMs = approvals.reduce((sum, approval) => sum + approvalWaitMs(approval, now), 0);
    return {
      turn,
      prompt: messages.find((message) => message.role === "user") ?? null,
      reply: [...messages].reverse().find((message) => message.role === "assistant") ?? null,
      spans: detail.spans.filter((span) => span.turnId === turn.id),
      approvals,
      elapsedMs,
      waitingMs,
      workingMs: Math.max(0, elapsedMs - waitingMs),
      tokens: (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
    };
  });
}

export type SessionRollups = {
  runs: number;
  runsDone: number;
  runsWaiting: number;
  runsFailed: number;
  evalAverage: number | null;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  workingMs: number;
  waitingMs: number;
  sessionMs: number;
};

export function sessionRollups(detail: AgentSessionDetail, now: number = Date.now()): SessionRollups {
  const runs = runViews(detail, now);
  const tools = detail.spans.filter((span) => span.kind === "tool");
  const costs = detail.turns.map((turn) => turn.costUsd).filter((cost): cost is number => cost !== null);
  const scores = detail.evalScores.map((score) => score.score);
  return {
    runs: runs.length,
    runsDone: runs.filter((run) => run.turn.status === "succeeded").length,
    runsWaiting: runs.filter((run) => run.turn.status === "waiting").length,
    runsFailed: runs.filter((run) => run.turn.status === "failed").length,
    evalAverage: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    toolCalls: tools.length,
    toolErrors: tools.filter((span) => span.status === "error").length,
    inputTokens: detail.turns.reduce((sum, turn) => sum + (turn.inputTokens ?? 0), 0),
    outputTokens: detail.turns.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0),
    cost: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    workingMs: runs.reduce((sum, run) => sum + run.workingMs, 0),
    waitingMs: runs.reduce((sum, run) => sum + run.waitingMs, 0),
    sessionMs: Math.max(0, now - Date.parse(detail.session.createdAt)),
  };
}

export type TimelineView = {
  messages: Array<{ at: number; user: boolean }>;
  agent: Array<{ at: number; width: number; live: boolean; failed: boolean }>;
  gates: Array<{ at: number; width: number; open: boolean }>;
  ticks: string[];
};

/** Positions (0–100%) of messages, runs and human gates across the session's lifetime. */
export function sessionTimeline(detail: AgentSessionDetail, now: number = Date.now(), tickCount = 5): TimelineView | null {
  if (detail.turns.length === 0) return null;
  const start = Date.parse(detail.session.createdAt);
  const end = Math.max(now, start + 1000);
  const span = end - start;
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - start) / span) * 100));
  const minWidth = 0.6;
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const at = new Date(start + (span * index) / (tickCount - 1));
    const label = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    return index === tickCount - 1 ? `${label} now` : label;
  });
  return {
    messages: detail.messages.map((message) => ({ at: pct(Date.parse(message.createdAt)), user: message.role === "user" })),
    agent: detail.turns.map((turn) => {
      const from = pct(Date.parse(turn.startedAt));
      const to = pct(ms(turn.endedAt, now));
      return { at: from, width: Math.max(minWidth, to - from), live: turn.status === "running", failed: turn.status === "failed" };
    }),
    gates: detail.approvals.map((approval) => {
      const from = pct(Date.parse(approval.createdAt));
      const to = pct(ms(approval.decidedAt, now));
      return { at: from, width: Math.max(minWidth, to - from), open: approval.status === "pending" };
    }),
    ticks,
  };
}

export const SPAN_COLOR: Record<string, string> = {
  agent: "bg-[#a78bfa]",
  sub_agent: "bg-[#a78bfa]",
  model: "bg-[var(--sf-running)]",
  tool: "bg-[#2dd4bf]",
  guardrail: "bg-[#f472b6]",
  gate: "bg-[var(--sf-needs)]",
  internal: "bg-[#5b5f68]",
};

export function spanColor(span: Pick<AgentSpan, "kind" | "status">): string {
  if (span.status === "error") return "bg-[var(--sf-fail)]";
  return SPAN_COLOR[span.kind] ?? "bg-[var(--sf-text-3)]";
}
