import { describe, expect, it } from "vitest";
import type { AgentSessionDetail } from "../../../api/agents";
import { composerMode, isRunActive, runViews, sessionRollups, sessionTimeline } from "./sessionView";

const t = (seconds: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + seconds * 1000).toISOString();

const detail: AgentSessionDetail = {
  session: {
    id: "ses_1",
    agentId: "a",
    revision: 1,
    backend: "pi",
    status: "waiting",
    source: "console",
    sourceRef: null,
    threadKey: null,
    title: "hi",
    createdAt: t(0),
    updatedAt: t(30),
  },
  messages: [
    { id: "m1", sessionId: "ses_1", seq: 1, turnId: "t1", role: "user", author: null, text: "hi", createdAt: t(0) },
    { id: "m2", sessionId: "ses_1", seq: 2, turnId: "t1", role: "assistant", author: "a", text: "hello", createdAt: t(10) },
    { id: "m3", sessionId: "ses_1", seq: 3, turnId: "t2", role: "user", author: null, text: "post it", createdAt: t(50) },
  ],
  turns: [
    { id: "t1", sessionId: "ses_1", seq: 1, revision: 1, traceId: "x", status: "succeeded", errorCode: null, inputTokens: 10, outputTokens: 5, costUsd: 0.01, startedAt: t(0), endedAt: t(10) },
    { id: "t2", sessionId: "ses_1", seq: 2, revision: 1, traceId: "y", status: "waiting", errorCode: null, inputTokens: 4, outputTokens: null, costUsd: null, startedAt: t(50), endedAt: null },
  ],
  spans: [
    { id: "s1", turnId: "t1", parentSpanId: null, name: "chat", kind: "model", status: "ok", startedAt: t(0), endedAt: t(9), durationMs: 9000, inputTokens: 10, outputTokens: 5, attributes: {}, inputText: null, outputText: null },
    { id: "s2", turnId: "t2", parentSpanId: null, name: "slack.post_message", kind: "tool", status: "error", startedAt: t(52), endedAt: t(53), durationMs: 1000, inputTokens: null, outputTokens: null, attributes: {}, inputText: null, outputText: null },
  ],
  approvals: [
    { id: "ap", sessionId: "ses_1", turnId: "t2", tool: "slack.post_message", payload: {}, payloadHash: "h", status: "pending", createdAt: t(60), expiresAt: t(1860), decidedAt: null, actor: null },
  ],
  pendingApproval: null,
  evalScores: [],
  deliveries: [],
};

describe("session view model", () => {
  const now = Date.parse(t(100));

  it("groups messages, spans and approvals by run and splits working from waiting time", () => {
    const [first, second] = runViews(detail, now);
    expect(first).toMatchObject({ prompt: { text: "hi" }, reply: { text: "hello" }, elapsedMs: 10_000, waitingMs: 0, tokens: 15 });
    expect(second).toMatchObject({ reply: null, elapsedMs: 50_000, waitingMs: 40_000, workingMs: 10_000 });
    expect(second!.spans.map((span) => span.id)).toEqual(["s2"]);
  });

  it("rolls the session up", () => {
    expect(sessionRollups(detail, now)).toMatchObject({
      runs: 2,
      runsDone: 1,
      runsWaiting: 1,
      toolCalls: 1,
      toolErrors: 1,
      inputTokens: 14,
      outputTokens: 5,
      cost: 0.01,
      workingMs: 20_000,
      waitingMs: 40_000,
      sessionMs: 100_000,
      evalAverage: null,
    });
  });

  it("places runs and gates on a 0–100% timeline", () => {
    const timeline = sessionTimeline(detail, now)!;
    expect(timeline.agent).toEqual([
      { at: 0, width: 10, live: false, failed: false },
      { at: 50, width: 50, live: false, failed: false },
    ]);
    expect(timeline.gates).toEqual([{ at: 60, width: 40, open: true }]);
    expect(timeline.messages.map((m) => m.at)).toEqual([0, 10, 50]);
    expect(timeline.ticks).toHaveLength(5);
    expect(timeline.ticks.at(-1)).toMatch(/now$/);
  });
});

describe("isRunActive", () => {
  it("is true for running or waiting runs, false for settled or unknown ones", () => {
    expect(isRunActive(detail, "2")).toBe(true);
    expect(isRunActive(detail, "1")).toBe(false);
    expect(isRunActive(detail, "9")).toBe(false);
  });
  it("stays active while a delivery of a settled run is in flight or retryable", () => {
    const delivery = { turnId: "t1", state: "sending", retryable: false } as unknown as AgentSessionDetail["deliveries"][number];
    expect(isRunActive({ ...detail, deliveries: [delivery] }, "1")).toBe(true);
    expect(isRunActive({ ...detail, deliveries: [{ ...delivery, state: "failed", retryable: true } as typeof delivery] }, "1")).toBe(true);
    expect(isRunActive({ ...detail, deliveries: [{ ...delivery, state: "failed", retryable: false } as typeof delivery] }, "1")).toBe(false);
    expect(isRunActive({ ...detail, deliveries: [{ ...delivery, state: "delivered" } as typeof delivery] }, "1")).toBe(false);
  });
});

describe("composerMode", () => {
  it("is read only for eval sessions, even when the agent is disabled", () => {
    expect(composerMode("eval", true)).toBe("eval_readonly");
    expect(composerMode("eval", false)).toBe("eval_readonly");
  });
  it("follows whether the agent is enabled for other sessions", () => {
    expect(composerMode("console", true)).toBe("open");
    expect(composerMode(undefined, true)).toBe("open");
    expect(composerMode("console", false)).toBe("disabled");
  });
});
