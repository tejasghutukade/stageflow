import { describe, expect, it } from "vitest";
import type { AgentSpan } from "../../../api/agents";
import type { RunView } from "../model/sessionView";
import { criticalPath, defaultSpanId, filterCounts, orderSpans, runLogs, runSteps, timeBreakdown } from "./runModel";

const t = (s: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + s * 1000).toISOString();
const span = (id: string, parent: string | null, name: string, kind: string, from: number, to: number, extra: Partial<AgentSpan> = {}): AgentSpan => ({
  id, turnId: "t1", parentSpanId: parent, name, kind, status: "ok", startedAt: t(from), endedAt: t(to), durationMs: (to - from) * 1000,
  inputTokens: null, outputTokens: null, attributes: {}, inputText: null, outputText: null, ...extra,
});

const spans = [
  span("root", null, "invoke_agent a", "agent", 0, 16),
  span("m1", "root", "chat", "model", 0, 4, { inputTokens: 10, outputTokens: 5, attributes: { "gen_ai.request.model": "gpt" } }),
  span("x1", "root", "execute_tool search", "tool", 4, 5, { status: "error", attributes: { "gen_ai.tool.name": "search" }, inputText: '{"q":1}' }),
  span("x2", "root", "execute_tool search", "tool", 6, 9, { attributes: { "gen_ai.tool.name": "search" } }),
  span("m2", "root", "chat", "model", 9, 16),
];

const run: RunView = {
  turn: { id: "t1", sessionId: "s", seq: 3, revision: 2, traceId: "tr", status: "succeeded", errorCode: null, inputTokens: 10, outputTokens: 5, costUsd: 0.01, startedAt: t(0), endedAt: t(16) },
  prompt: { id: "p", sessionId: "s", seq: 1, turnId: "t1", role: "user", author: null, text: "hi", createdAt: t(0) },
  reply: { id: "r", sessionId: "s", seq: 2, turnId: "t1", role: "assistant", author: "a", text: "done", createdAt: t(16) },
  spans, approvals: [], elapsedMs: 16000, workingMs: 16000, waitingMs: 0, tokens: 15,
};

describe("run inspector model", () => {
  it("orders spans parent-first and indents children", () => {
    expect(orderSpans(spans).map((r) => `${r.depth}:${r.span.id}`)).toEqual(["0:root", "1:m1", "1:x1", "1:x2", "1:m2"]);
  });
  it("counts by kind and errors", () => {
    expect(filterCounts(spans)).toMatchObject({ all: 5, agent: 1, model: 2, tool: 2, errors: 1 });
  });
  it("selects the first error span by default", () => {
    expect(defaultSpanId(spans)).toBe("x1");
  });
  it("splits time into llm, tool and other", () => {
    const slices = timeBreakdown(run);
    expect(slices.find((s) => s.id === "llm")?.ms).toBe(11000);
    expect(slices.find((s) => s.id === "tool")?.ms).toBe(4000);
    expect(slices.reduce((n, s) => n + s.ms, 0)).toBe(16000);
  });
  it("summarises the critical path", () => {
    expect(criticalPath(spans)).toBe("chat → search ×2 → chat");
  });
  it("narrates logs in time order including failures", () => {
    const logs = runLogs(run);
    expect(logs[0]!.message).toContain("Run #3 started");
    expect(logs.some((l) => l.level === "ERROR" && l.source === "execute_tool")).toBe(true);
    expect(logs.map((l) => l.offsetMs)).toEqual([...logs.map((l) => l.offsetMs)].sort((a, b) => a - b));
  });
  it("builds readable steps with a pending approval gate", () => {
    const waiting: RunView = {
      ...run,
      reply: null,
      turn: { ...run.turn, status: "waiting", endedAt: null },
      approvals: [{ id: "ap", sessionId: "s", turnId: "t1", tool: "slack.post", payload: {}, payloadHash: "h", status: "pending", createdAt: t(10), expiresAt: t(99), decidedAt: null, actor: null }],
    };
    const steps = runSteps(waiting);
    expect(steps[0]!.title).toBe("Received a message");
    expect(steps.find((s) => s.state === "waiting")?.approval?.tool).toBe("slack.post");
    expect(steps.at(-1)!.state).toBe("pending");
    expect(steps.some((s) => s.state === "failed" && s.title === "Used search")).toBe(true);
  });
});
