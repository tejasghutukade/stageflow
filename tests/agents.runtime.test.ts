import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { fitHistory } from "../src/agents/historyFit.js";
import { otlpSinkFromEnv } from "../src/agents/otlpSink.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function setup(agents: Record<string, Record<string, unknown>>) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  for (const [id, overrides] of Object.entries(agents)) {
    await fixture.service.create(fixture.project, agentInput(id, overrides), { source: "console" });
    await fixture.service.setEnabled(fixture.project, id, true, { source: "console" });
  }
  return fixture;
}

const askFirst = {
  tools: { builtin: ["read"], mcp: { web: ["fetch"] } },
  approvals: { ask_first: ["web.fetch"], timeout_minutes: 30, on_timeout: "skip" },
};

describe("tool gate", () => {
  it("blocks tools the revision does not grant and records granted ones as spans", async () => {
    const { service, project } = await setup({ helper: { tools: { builtin: ["read"] }, observability: { capture: "full" } } });
    let blocked = "";
    const backend = scriptedBackend(async (_m, ctx) => {
      expect((await ctx.tool("read", { path: "a.md" }, () => "file body")).ran).toBe(true);
      blocked = (await ctx.tool("bash", { command: "ls" })).output;
      return "done";
    });
    const detail = await new AgentChatController({ service, backend }).send({ projectRoot: project, agentId: "helper", text: "go" });
    expect(blocked).toMatch(/not granted/);
    const tool = detail.spans.find((span) => span.kind === "tool")!;
    expect(tool).toMatchObject({ name: "execute_tool read", status: "ok", outputText: "file body" });
    const root = detail.spans.find((span) => span.kind === "agent")!;
    expect(tool.parentSpanId).toBe(root.id);
    expect(detail.spans.find((span) => span.kind === "model")!.parentSpanId).toBe(root.id);
  });
});

describe("ask-first approvals", () => {
  async function runAskFirst(decide: (ctx: { service: AgentsFixture["service"]; project: string; sessionId: string; clock: AgentsFixture["clock"] }) => Promise<void>, agent = askFirst) {
    const { service, project, clock } = await setup({ helper: agent });
    let outcome = { ran: true, output: "" };
    const backend = scriptedBackend(async (_m, ctx) => {
      outcome = await ctx.tool("web.fetch", { url: "https://example.com" }, () => "page");
      return `result: ${outcome.output}`;
    });
    const chat = new AgentChatController({ service, backend });
    let sessionId = "";
    const turn = chat.send({ projectRoot: project, agentId: "helper", text: "go", onSessionOpened: (id) => (sessionId = id) });
    await vi.waitFor(async () => expect((await service.getSession(project, sessionId)).turns[0]?.status).toBe("waiting"));
    expect((await service.getSession(project, sessionId)).session.status).toBe("waiting");
    expect((await service.pendingApprovals(project)).length).toBe(1);
    await decide({ service, project, sessionId, clock });
    const detail = await turn.catch((error) => error);
    return { service, project, sessionId, detail, outcome, clock };
  }

  it("pauses the turn and runs the tool once approved", async () => {
    const run = await runAskFirst(async ({ service, project, sessionId }) => {
      await service.decideApproval(project, sessionId, "approve", { kind: "operator" });
    });
    expect(run.outcome).toEqual({ ran: true, output: "page" });
    expect(run.detail.turns[0]).toMatchObject({ status: "succeeded" });
    expect(run.detail.session.status).toBe("open");
    expect(run.detail.spans.some((span: { kind: string; status: string }) => span.kind === "gate" && span.status === "ok")).toBe(true);
  });

  it("tells the agent when the operator denies and lets it continue", async () => {
    const run = await runAskFirst(async ({ service, project, sessionId }) => {
      await service.decideApproval(project, sessionId, "deny", { kind: "operator" });
    });
    expect(run.outcome.ran).toBe(false);
    expect(run.outcome.output).toMatch(/denied/);
    expect(run.detail.turns[0]).toMatchObject({ status: "succeeded" });
  });

  it("skips the action when the approval times out (on_timeout: skip)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const run = await runAskFirst(async ({ clock }) => {
        clock.advance(31 * 60_000);
        await vi.advanceTimersByTimeAsync(31 * 60_000);
      });
      expect(run.outcome.ran).toBe(false);
      expect(run.outcome.output).toMatch(/timed out/);
      expect(run.detail.turns[0]).toMatchObject({ status: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the turn when the approval times out (on_timeout: deny)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const run = await runAskFirst(
        async ({ clock }) => {
          clock.advance(31 * 60_000);
          await vi.advanceTimersByTimeAsync(31 * 60_000);
        },
        { ...askFirst, approvals: { ...askFirst.approvals, on_timeout: "deny" } },
      );
      expect(run.detail.turns.at(-1)).toMatchObject({ status: "failed", errorCode: "agent.approval_expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a waiting turn on host restart and expires its approval", async () => {
    const { service, project, store } = await setup({ helper: askFirst }).then((f) => ({ ...f, store: f.store }));
    const backend = scriptedBackend(async (_m, ctx) => (await ctx.tool("web.fetch", { url: "x" })).output);
    const controller = new AbortController();
    void controller;
    const chat = new AgentChatController({ service, backend });
    let sessionId = "";
    void chat.send({ projectRoot: project, agentId: "helper", text: "go", onSessionOpened: (id) => (sessionId = id) }).catch(() => undefined);
    await vi.waitFor(async () => expect((await service.pendingApprovals(project)).length).toBe(1));
    await vi.waitFor(async () => expect((await service.getSession(project, sessionId)).turns[0]?.status).toBe("waiting"));
    expect(service.recoverInterruptedTurns()).toBe(1);
    const detail = await service.getSession(project, sessionId);
    expect(detail.turns[0]).toMatchObject({ status: "failed", errorCode: "agent.host_restarted" });
    expect(detail.session.status).toBe("open");
    expect(store.getPendingApproval(sessionId)).toBeUndefined();
  });
});

describe("sub-agents", () => {
  it("runs a granted sub-agent in its own session and returns its reply", async () => {
    const { service, project } = await setup({
      boss: { sub_agents: ["worker"], sub_agent_depth: 1 },
      worker: { instructions: "Work." },
    });
    const backend = scriptedBackend(async (messages, ctx) => {
      if (messages.at(-1)!.text === "do the thing") {
        return `worker said: ${await ctx.hooks.delegate("worker", "subtask")}`;
      }
      return `done ${messages.at(-1)!.text}`;
    });
    const detail = await new AgentChatController({ service, backend }).send({ projectRoot: project, agentId: "boss", text: "do the thing" });
    expect(detail.messages.at(-1)!.text).toBe("worker said: done subtask");
    const child = (await service.listSessions(project, "worker", { limit: 10 })).sessions;
    expect(child).toHaveLength(1);
    expect(child[0]).toMatchObject({ source: "agent" });
  });

  it("refuses an agent that is not granted and reports it to the caller", async () => {
    const { service, project } = await setup({ boss: {}, worker: {} });
    const backend = scriptedBackend(async (_m, ctx) => ctx.hooks.delegate("worker", "x").catch((error) => `err ${error.code}`));
    const detail = await new AgentChatController({ service, backend }).send({ projectRoot: project, agentId: "boss", text: "go" });
    expect(detail.messages.at(-1)!.text).toBe("err agent.delegate_not_allowed");
  });

  it("stops nesting at sub_agent_depth", async () => {
    const { service, project } = await setup({
      a: { sub_agents: ["b"], sub_agent_depth: 1 },
      b: { sub_agents: ["c"], sub_agent_depth: 1 },
      c: {},
    });
    const backend = scriptedBackend(async (messages, ctx) => {
      const text = messages.at(-1)!.text;
      if (text === "start") return ctx.hooks.delegate("b", "mid").catch((e) => `a:${e.code}`);
      if (text === "mid") return `b got: ${await ctx.hooks.delegate("c", "leaf").catch((e: { code: string }) => e.code)}`;
      return "leaf";
    });
    const detail = await new AgentChatController({ service, backend }).send({ projectRoot: project, agentId: "a", text: "start" });
    expect(detail.messages.at(-1)!.text).toMatch(/agent\.delegate_depth_exceeded/);
  });
});

describe("limits", () => {
  it("refuses a new turn once max_turns, session_minutes or cost_usd is reached", async () => {
    const { service, project, clock } = await setup({
      turns: { limits: { max_turns: 1 } },
      timed: { limits: { session_minutes: 5 } },
      costly: { limits: { cost_usd: 0.0005 } },
    });
    const chat = new AgentChatController({ service, backend: scriptedBackend() });
    for (const agentId of ["turns", "timed", "costly"]) {
      const first = await chat.send({ projectRoot: project, agentId, text: "one" });
      if (agentId === "timed") clock.advance(6 * 60_000);
      await expect(chat.send({ projectRoot: project, agentId, sessionId: first.session.id, text: "two" })).rejects.toMatchObject({ code: "agent.limit_reached" });
    }
  });
});

describe("telemetry and evals", () => {
  it("records cost on the turn and scores groundedness from tool output", async () => {
    const { service, project } = await setup({ helper: { tools: { builtin: ["read"] }, evals: { groundedness: true } } });
    const judge = vi.fn().mockResolvedValue("0.8");
    const backend = scriptedBackend(async (_m, ctx) => `answer from ${(await ctx.tool("read", { path: "a" }, () => "facts")).output}`, undefined, { judge });
    const detail = await new AgentChatController({ service, backend }).send({ projectRoot: project, agentId: "helper", text: "q" });
    expect(detail.turns[0]!.costUsd).toBeCloseTo(0.001);
    expect(detail.evalScores).toMatchObject([{ metric: "groundedness", score: 0.8 }]);
    expect(judge.mock.calls[0]![0].prompt).toContain("facts");
  });

  it("does not score a reply that used no tools", async () => {
    const { service, project } = await setup({ helper: { evals: { groundedness: true } } });
    const judge = vi.fn();
    const detail = await new AgentChatController({ service, backend: scriptedBackend(undefined, undefined, { judge }) }).send({ projectRoot: project, agentId: "helper", text: "q" });
    expect(judge).not.toHaveBeenCalled();
    expect(detail.evalScores).toEqual([]);
  });

  it("pushes the finished turn to the collector only when observability.otlp is on", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const { service, project } = await setup({ on: { observability: { capture: "metadata", otlp: true } }, off: {} });
    const chat = new AgentChatController({ service, backend: scriptedBackend(), otlpSink: sink });
    await chat.send({ projectRoot: project, agentId: "off", text: "x" });
    expect(sink).not.toHaveBeenCalled();
    await chat.send({ projectRoot: project, agentId: "on", text: "x" });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
    expect(JSON.stringify(sink.mock.calls[0]![0])).toContain("invoke_agent on");
  });

  it("a collector outage never fails the turn", async () => {
    const errors: string[] = [];
    const { service, project } = await setup({ on: { observability: { otlp: true } } });
    const chat = new AgentChatController({ service, backend: scriptedBackend(), otlpSink: async () => Promise.reject(new Error("down")), logError: (m) => errors.push(m) });
    const detail = await chat.send({ projectRoot: project, agentId: "on", text: "x" });
    expect(detail.turns[0]!.status).toBe("succeeded");
    await vi.waitFor(() => expect(errors[0]).toMatch(/OTLP export failed: down/));
  });
});

describe("otlp sink from env", () => {
  it("posts to the traces endpoint with parsed headers, and is absent without an endpoint", async () => {
    expect(otlpSinkFromEnv({})).toBeUndefined();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sink = otlpSinkFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/", OTEL_EXPORTER_OTLP_HEADERS: "x-key=abc, y=1" }, fetchImpl as never)!;
    await sink({ resourceSpans: [] });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://c:4318/v1/traces");
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ "x-key": "abc", y: "1" });
  });
});

describe("history fitting", () => {
  const long = (n: number) => "x".repeat(n);
  const messages = [
    { role: "user" as const, text: long(40) },
    { role: "assistant" as const, text: long(40) },
    { role: "user" as const, text: "latest" },
  ];
  it("keeps everything under budget", () => {
    expect(fitHistory(messages, "truncate", 1000)).toEqual(messages);
  });
  it("truncate drops the oldest, summarize condenses them, newest is always kept", () => {
    expect(fitHistory(messages, "truncate", 45).map((m) => m.text)).toEqual(["latest"]);
    const summarized = fitHistory(messages, "summarize", 45);
    expect(summarized[0]!.text).toMatch(/condensed/);
    expect(summarized.at(-1)!.text).toBe("latest");
  });
});

describe("review fixes", () => {
  it("refuses a second turn while the session waits on an approval", async () => {
    const { service, project } = await setup({ helper: askFirst });
    const backend = scriptedBackend(async (_m, ctx) => (await ctx.tool("web.fetch", { url: "x" })).output);
    const chat = new AgentChatController({ service, backend });
    let sessionId = "";
    void chat.send({ projectRoot: project, agentId: "helper", text: "go", onSessionOpened: (id) => (sessionId = id) }).catch(() => undefined);
    await vi.waitFor(async () => expect((await service.getSession(project, sessionId)).turns[0]?.status).toBe("waiting"));
    await expect(service.beginTurn(project, sessionId, { text: "again" })).rejects.toMatchObject({ code: "agent.session_busy" });
  });

  it("only returns a pending approval for the same call", async () => {
    const { service, project } = await setup({ helper: { tools: { builtin: ["read"], mcp: { web: ["fetch", "post"] } }, approvals: { ask_first: ["web.fetch", "web.post"] } } });
    const session = await service.openSession(project, "helper", { source: "console" });
    const first = await service.requestApproval(project, session.id, { tool: "web.fetch", payload: { a: 1 } });
    expect(await service.requestApproval(project, session.id, { tool: "web.fetch", payload: { a: 1 } })).toMatchObject({ id: first.id });
    await expect(service.requestApproval(project, session.id, { tool: "web.post", payload: { a: 1 } })).rejects.toMatchObject({ code: "agent.session_busy" });
  });

  it("fails the turn instead of leaving the session running when storage throws mid-turn", async () => {
    const { service, project } = await setup({ helper: {} });
    vi.spyOn(service, "recordSpan").mockImplementation(() => {
      throw new Error("disk");
    });
    const chat = new AgentChatController({ service, backend: scriptedBackend() });
    let sessionId = "";
    await expect(chat.send({ projectRoot: project, agentId: "helper", text: "x", onSessionOpened: (id) => (sessionId = id) })).rejects.toThrow("disk");
    const detail = await service.getSession(project, sessionId);
    expect(detail.session.status).toBe("open");
    expect(detail.turns[0]!.status).toBe("failed");
  });
});
