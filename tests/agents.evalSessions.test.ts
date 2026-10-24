import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createEvalGate, EvalGateRegistry } from "../src/agents/evalGate.js";
import { EVAL_SESSION_SOURCE } from "../src/agents/evalSession.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";
import { agentProjectKey } from "../src/agents/store.js";
import type { ConversationBackend } from "../src/agents/sessions.js";

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

async function bump(fixture: AgentsFixture, agentId: string, instructions: string) {
  const current = (await fixture.service.get(fixture.project, agentId)).agent.revision;
  const detail = await fixture.service.get(fixture.project, agentId);
  await fixture.service.save(fixture.project, agentId, { baseRevision: current, definition: { ...detail.definition!, instructions } }, { source: "console" });
}

function capturing() {
  const seen: Array<Parameters<ConversationBackend["complete"]>[0]> = [];
  const inner = scriptedBackend();
  const backend: ConversationBackend & { seen: typeof seen } = {
    id: "pi",
    seen,
    async complete(input) {
      seen.push(input);
      return inner.complete(input);
    },
  };
  return backend;
}

describe("eval sessions: opening", () => {
  it("opens the pinned revision after the agent file changes; omitted eval behaves as before", async () => {
    const fx = await setup({ helper: { instructions: "v-original" } });
    const pinned = (await fx.service.get(fx.project, "helper")).agent.revision;
    await bump(fx, "helper", "v-two");
    await bump(fx, "helper", "v-three");
    await bump(fx, "helper", "v-four");
    const current = (await fx.service.get(fx.project, "helper")).agent.revision;
    expect(current).toBe(pinned + 3);
    const eval_ = await fx.service.openSession(fx.project, "helper", { source: EVAL_SESSION_SOURCE, sourceRef: "evr_1", eval: { revision: pinned } });
    expect(eval_).toMatchObject({ revision: pinned, source: "eval", sourceRef: "evr_1" });
    const real = await fx.service.openSession(fx.project, "helper", { source: "console" });
    expect(real.revision).toBe(current);
    const backend = capturing();
    const chat = new AgentChatController({ service: fx.service, backend });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: eval_.id, text: "hi", source: "eval" });
    expect(backend.seen[0]!.definition.instructions).toBe("v-original");
  });

  it("rejects an unknown revision and eval overrides on a real session", async () => {
    const fx = await setup({ helper: {} });
    await expect(fx.service.openSession(fx.project, "helper", { source: "eval", eval: { revision: 99 } })).rejects.toMatchObject({ code: "agent.revision_not_found" });
    await expect(fx.service.openSession(fx.project, "helper", { source: "console", eval: { limits: { max_turns: 5 } } })).rejects.toMatchObject({ code: "agent.invalid" });
  });

  it("bypasses enabled for eval sessions but still refuses an archived agent", async () => {
    const fx = await setup({ helper: {}, other: {} });
    await fx.service.setEnabled(fx.project, "helper", false, { source: "console" });
    await expect(fx.service.openSession(fx.project, "helper", { source: "console" })).rejects.toMatchObject({ code: "agent.disabled" });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: {} });
    const chat = new AgentChatController({ service: fx.service, backend: scriptedBackend() });
    const detail = await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: session.id, text: "hi", source: "eval" });
    expect(detail.turns[0]!.status).toBe("succeeded");
    await expect(chat.send({ projectRoot: fx.project, agentId: "helper", text: "hi" })).rejects.toMatchObject({ code: "agent.disabled" });
    await fx.service.archive(fx.project, "other");
    await expect(fx.service.openSession(fx.project, "other", { source: "eval", eval: {} })).rejects.toMatchObject({ code: "agent.archived" });
  });
});

describe("eval sessions: overrides", () => {
  it("reaches the backend: model, capture full, no otlp, no groundedness", async () => {
    const fx = await setup({ helper: { observability: { capture: "off", otlp: true }, evals: { groundedness: true }, limits: { always_on: true } } });
    const session = await fx.service.openSession(fx.project, "helper", {
      source: "eval",
      eval: { definition: { model: { id: "openrouter/some-model" } } },
    });
    const backend = capturing();
    const detail = await new AgentChatController({ service: fx.service, backend }).send({ projectRoot: fx.project, agentId: "helper", sessionId: session.id, text: "hi", source: "eval" });
    const definition = backend.seen[0]!.definition;
    expect(definition.model.id).toBe("openrouter/some-model");
    expect(definition.observability).toMatchObject({ capture: "full", otlp: false });
    expect(definition.evals.groundedness).toBe(false);
    expect(definition.limits.always_on).toBe(false);
    expect(detail.spans.find((span) => span.kind === "agent")!.inputText).toBe("hi");
    const stored = await fx.service.definitionAt(fx.project, "helper", session.revision);
    expect(stored.observability.capture).toBe("off");
    expect(stored.model.id).not.toBe("openrouter/some-model");
  });

  it("capture: full stores tool arguments and results without editing the agent file", async () => {
    const fx = await setup({ helper: { tools: { builtin: ["read"] }, observability: { capture: "metadata" } } });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: { capture: "full" } });
    const backend = scriptedBackend(async (_m, ctx) => (await ctx.tool("read", { path: "a.md" }, () => "file body")).output);
    const evalGates = new EvalGateRegistry();
    evalGates.set(session.id, createEvalGate({ policy: { tools: "read_only", approvals: "record_only", readOnlyTools: [], mocks: {} }, definition: (await fx.service.get(fx.project, "helper")).definition! }));
    const detail = await new AgentChatController({ service: fx.service, backend, evalGates }).send({ projectRoot: fx.project, agentId: "helper", sessionId: session.id, text: "go", source: "eval" });
    const tool = detail.spans.find((span) => span.kind === "tool")!;
    expect(tool).toMatchObject({ outputText: "file body" });
    expect(tool.inputText).toContain("a.md");
    expect(tool.attributes["gen_ai.tool.call.id"]).toBeTruthy();
  });

  it("enforces eval max_turns and session_minutes instead of the agent's, and leaves real sessions alone", async () => {
    const fx = await setup({ helper: { limits: { max_turns: 1, session_minutes: 1 } } });
    const chat = new AgentChatController({ service: fx.service, backend: scriptedBackend() });
    const roomy = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: { limits: { max_turns: 3, session_minutes: 30 } } });
    for (let i = 0; i < 3; i += 1) await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: roomy.id, text: `t${i}`, source: "eval" });
    await expect(chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: roomy.id, text: "t3", source: "eval" })).rejects.toMatchObject({ code: "agent.limit_reached" });
    const slow = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: { limits: { max_turns: 10, session_minutes: 2 } } });
    fx.clock.advance(3 * 60_000);
    await expect(chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: slow.id, text: "late", source: "eval" })).rejects.toMatchObject({ code: "agent.limit_reached" });
    const real = await fx.service.openSession(fx.project, "helper", { source: "console" });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: real.id, text: "one", source: "eval" });
    await expect(chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: real.id, text: "two", source: "eval" })).rejects.toMatchObject({ code: "agent.limit_reached" });
  });

  it("enforces eval cost_usd only when given; null lifts the agent's cost limit", async () => {
    const fx = await setup({ helper: { limits: { cost_usd: 0.0005 } } });
    const chat = new AgentChatController({ service: fx.service, backend: scriptedBackend() });
    const lifted = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: { limits: { max_turns: 5, session_minutes: 10, cost_usd: null } } });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: lifted.id, text: "a", source: "eval" });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: lifted.id, text: "b", source: "eval" });
    const capped = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: { limits: { max_turns: 5, session_minutes: 10, cost_usd: 0.0015 } } });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: capped.id, text: "a", source: "eval" });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: capped.id, text: "b", source: "eval" });
    await expect(chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: capped.id, text: "c", source: "eval" })).rejects.toMatchObject({ code: "agent.limit_reached" });
  });
});

describe("eval sessions: hidden from operators", () => {
  it("is absent from every list, count, stat and pending approval, present with includeEval", async () => {
    const fx = await setup({ helper: { tools: { builtin: ["read"], mcp: { web: ["fetch"] } }, approvals: { ask_first: ["web.fetch"], timeout_minutes: 30, on_timeout: "skip" } } });
    const chat = new AgentChatController({ service: fx.service, backend: scriptedBackend() });
    const real = await chat.send({ projectRoot: fx.project, agentId: "helper", text: "real" });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", sourceRef: "evr_1", eval: {} });
    await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: session.id, text: "eval", source: "eval" });

    const own = await fx.service.listSessions(fx.project, "helper", { limit: 10 });
    expect(own.sessions.map((s) => s.id)).toEqual([real.session.id]);
    expect(own.stats.total).toBe(1);
    const all = await fx.service.listAllSessions(fx.project, { limit: 10 });
    expect(all.sessions.map((s) => s.id)).toEqual([real.session.id]);
    expect(all.stats).toMatchObject({ total: 1, turnsFinished7d: 1, cost7d: 0.001, costTotal: 0.001 });
    expect((await fx.service.listAllSessions(fx.project, { limit: 10, source: "eval" })).sessions).toEqual([]);
    const summary = (await fx.service.list(fx.project)).find((agent) => agent.id === "helper")!;
    expect(summary.stats.total).toBe(1);
    expect((await fx.service.get(fx.project, "helper")).agent.stats.total).toBe(1);

    const withEval = await fx.service.listAllSessions(fx.project, { limit: 10, includeEval: true });
    expect(withEval.sessions.map((s) => s.id).sort()).toEqual([real.session.id, session.id].sort());
    expect(withEval.stats.total).toBe(2);
    expect((await fx.service.listSessions(fx.project, "helper", { limit: 10, includeEval: true })).sessions).toHaveLength(2);
    expect(fx.service.listSessionsForRef(fx.project, "helper", "eval", "evr_1", 10)).toEqual([]);
    expect(fx.service.listSessionsForRef(fx.project, "helper", "eval", "evr_1", 10, true)).toHaveLength(1);
    expect((await fx.service.getSession(fx.project, session.id)).messages).toHaveLength(2);
  });

  it("never lists an eval session's pending approval", async () => {
    const fx = await setup({ helper: { tools: { builtin: ["read"], mcp: { web: ["fetch"] } }, approvals: { ask_first: ["web.fetch"], timeout_minutes: 30, on_timeout: "skip" } } });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: {} });
    await fx.service.requestApproval(fx.project, session.id, { tool: "web.fetch", payload: { url: "x" } });
    expect((await fx.service.pendingApprovals(fx.project, { includeEval: true })).length).toBe(1);
    expect(await fx.service.pendingApprovals(fx.project)).toEqual([]);
    expect((await fx.service.list(fx.project))[0]!.pendingApprovals).toBe(0);
  });

  it("keeps boot recovery and by-id reads working", async () => {
    const fx = await setup({ helper: {} });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: {} });
    expect(fx.store.sessionIdsOf(agentProjectKey(fx.project), "helper")).toContain(session.id);
    expect(fx.service.recoverInterruptedTurns()).toBe(0);
    expect((await fx.service.getSession(fx.project, session.id)).session.source).toBe("eval");
    expect(await fx.service.resumableTurns(fx.project)).toEqual([]);
    expect(await fx.service.scheduledAgents(fx.project)).toEqual([]);
  });
});

describe("eval sessions: side effects", () => {
  it("never pushes OTLP or calls the groundedness judge", async () => {
    const fx = await setup({ helper: { tools: { builtin: ["read"] }, observability: { capture: "full", otlp: true }, evals: { groundedness: true } } });
    const judge = vi.fn().mockResolvedValue("0.8");
    const sink = vi.fn().mockResolvedValue(undefined);
    const backend = scriptedBackend(async (_m, ctx) => `answer ${(await ctx.tool("read", { path: "a" }, () => "facts")).output}`, undefined, { judge });
    const chat = new AgentChatController({ service: fx.service, backend, otlpSink: sink });
    const session = await fx.service.openSession(fx.project, "helper", { source: "eval", eval: {} });
    const detail = await chat.send({ projectRoot: fx.project, agentId: "helper", sessionId: session.id, text: "q", source: "eval" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(judge).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(detail.evalScores).toEqual([]);

    const real = await chat.send({ projectRoot: fx.project, agentId: "helper", text: "q" });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(judge).toHaveBeenCalledTimes(1);
    expect(real.evalScores.map((score) => score.metric)).toEqual(["groundedness"]);
  });
});

describe("eval sessions: sub-agents", () => {
  it("marks a delegated child as an eval session under its parent, inherits overrides, and links the span", async () => {
    const fx = await setup({
      boss: { sub_agents: ["worker"], sub_agent_depth: 2, observability: { capture: "off" } },
      worker: { observability: { capture: "off" }, evals: { groundedness: true } },
    });
    const backend = capturing();
    const inner = scriptedBackend(() => "child reply");
    backend.complete = async (input) => {
      backend.seen.push(input);
      if (input.messages.at(-1)!.text === "go") {
        const call = { id: "call_x", tool: "agent:worker", input: { message: "sub" } };
        input.hooks.toolStarted(call);
        const reply = await input.hooks.delegate("worker", "sub", "call_x");
        input.hooks.toolFinished(call, { ok: true, output: reply });
        return { text: `got ${reply}`, toolOutputs: [reply], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
      }
      return inner.complete(input);
    };
    const chat = new AgentChatController({ service: fx.service, backend });
    const session = await fx.service.openSession(fx.project, "boss", { source: "eval", sourceRef: "evr_9", eval: { definition: { model: { id: "openrouter/x" } } } });
    const detail = await chat.send({ projectRoot: fx.project, agentId: "boss", sessionId: session.id, text: "go", source: "eval" });
    expect(detail.messages.at(-1)!.text).toBe("got child reply");

    const children = fx.service.listChildSessions(session.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ agentId: "worker", source: "eval", sourceRef: session.id });
    expect(fx.service.listChildSessions("evr_9").map((s) => s.id).sort()).toEqual([session.id, children[0]!.id].sort());
    expect(backend.seen.at(-1)!.definition.model.id).toBe("openrouter/x");
    expect(backend.seen.at(-1)!.definition.evals.groundedness).toBe(false);
    expect((await fx.service.listSessions(fx.project, "worker", { limit: 10 })).sessions).toEqual([]);
  });

  it("records the child session id and call id on the sub-agent span when capture is on", async () => {
    const fx = await setup({
      boss: { sub_agents: ["worker"], sub_agent_depth: 1, observability: { capture: "full" } },
      worker: {},
    });
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        if (input.messages.at(-1)!.text === "go") {
          const call = { id: "call_x", tool: "agent:worker", input: { message: "sub" } };
          input.hooks.toolStarted(call);
          const reply = await input.hooks.delegate("worker", "sub", "call_x");
          input.hooks.toolFinished(call, { ok: true, output: reply });
          return { text: reply, toolOutputs: [reply] };
        }
        return { text: "child reply", toolOutputs: [] };
      },
    };
    const chat = new AgentChatController({ service: fx.service, backend });
    const session = await fx.service.openSession(fx.project, "boss", { source: "eval", sourceRef: "evr_9", eval: {} });
    const detail = await chat.send({ projectRoot: fx.project, agentId: "boss", sessionId: session.id, text: "go", source: "eval" });
    const child = fx.service.listChildSessions(session.id)[0]!;
    const span = detail.spans.find((s) => s.kind === "sub_agent")!;
    expect(span.attributes).toMatchObject({ "stageflow.sub_agent.session_id": child.id, "gen_ai.tool.call.id": "call_x" });
  });

  it("keeps real sub-agent sessions exactly as before", async () => {
    const fx = await setup({ boss: { sub_agents: ["worker"], sub_agent_depth: 1, observability: { capture: "full" } }, worker: {} });
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        if (input.messages.at(-1)!.text === "go") {
          const call = { id: "call_x", tool: "agent:worker", input: { message: "sub" } };
          input.hooks.toolStarted(call);
          const reply = await input.hooks.delegate("worker", "sub");
          input.hooks.toolFinished(call, { ok: true, output: reply });
          return { text: reply, toolOutputs: [] };
        }
        return { text: "child reply", toolOutputs: [] };
      },
    };
    const detail = await new AgentChatController({ service: fx.service, backend }).send({ projectRoot: fx.project, agentId: "boss", text: "go" });
    const children = (await fx.service.listSessions(fx.project, "worker", { limit: 10 })).sessions;
    expect(children[0]).toMatchObject({ source: "agent", sourceRef: "boss" });
    const span = detail.spans.find((s) => s.kind === "sub_agent")!;
    expect(span.attributes).toEqual({ "gen_ai.tool.name": "agent:worker" });
  });
});

describe("eval sessions: real sessions unchanged", () => {
  it("runs a real session on its pinned definition untouched", async () => {
    const fx = await setup({ helper: { limits: { max_turns: 7 }, observability: { capture: "metadata" } } });
    const backend = capturing();
    const chat = new AgentChatController({ service: fx.service, backend });
    const detail = await chat.send({ projectRoot: fx.project, agentId: "helper", text: "hi" });
    const pinned = await fx.service.definitionAt(fx.project, "helper", detail.session.revision);
    expect(backend.seen[0]!.definition).toEqual(pinned);
    expect(fx.service.evalOverridesOf(detail.session.id)).toBeUndefined();
  });

  it("still pushes OTLP and runs the judge for real sessions on a mixed workload", async () => {
    const fx = await setup({ helper: { tools: { builtin: ["read"] }, observability: { capture: "full", otlp: true }, evals: { groundedness: true } } });
    const judge = vi.fn().mockResolvedValue("0.5");
    const sink = vi.fn().mockResolvedValue(undefined);
    const backend = scriptedBackend(async (_m, ctx) => (await ctx.tool("read", { path: "a" }, () => "facts")).output, undefined, { judge });
    await new AgentChatController({ service: fx.service, backend, otlpSink: sink }).send({ projectRoot: fx.project, agentId: "helper", text: "q" });
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
    expect(judge).toHaveBeenCalledTimes(1);
  });
});

describe("eval sessions: cleanup", () => {
  it("deletes the sessions, their descendants and everything under them; refuses real sessions", async () => {
    const fx = await setup({ boss: { sub_agents: ["worker"], sub_agent_depth: 1, observability: { capture: "full" } }, worker: {} });
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        if (input.messages.at(-1)!.text === "go") {
          const reply = await input.hooks.delegate("worker", "sub", "c1");
          return { text: reply, toolOutputs: [] };
        }
        return { text: "child", toolOutputs: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      },
    };
    const release = vi.fn();
    const chat = new AgentChatController({ service: fx.service, backend: { ...backend, release } });
    const real = await chat.send({ projectRoot: fx.project, agentId: "worker", text: "real" });
    const session = await fx.service.openSession(fx.project, "boss", { source: "eval", sourceRef: "evr_1", eval: {} });
    await chat.send({ projectRoot: fx.project, agentId: "boss", sessionId: session.id, text: "go", source: "eval" });
    const child = fx.service.listChildSessions(session.id)[0]!;

    await expect(fx.service.deleteEvalSessions(fx.project, [real.session.id])).rejects.toMatchObject({ code: "agent.invalid" });
    await expect(chat.closeEvalSession(fx.project, real.session.id)).rejects.toMatchObject({ code: "agent.invalid" });
    expect((await fx.service.getSession(fx.project, real.session.id)).messages).toHaveLength(2);

    await chat.closeEvalSession(fx.project, session.id);
    expect(release).toHaveBeenCalledWith(session.id);
    expect(fx.service.evalOverridesOf(session.id)).toBeUndefined();

    const deleted = await fx.service.deleteEvalSessions(fx.project, [session.id]);
    expect(deleted.sort()).toEqual([session.id, child.id].sort());
    await expect(fx.service.getSession(fx.project, session.id)).rejects.toMatchObject({ code: "agent.session_not_found" });
    await expect(fx.service.getSession(fx.project, child.id)).rejects.toMatchObject({ code: "agent.session_not_found" });
    const counts = fx.connection
      .prepare(`SELECT (SELECT COUNT(*) FROM agent_messages WHERE session_id IN (?, ?)) AS m, (SELECT COUNT(*) FROM agent_turns WHERE session_id IN (?, ?)) AS t, (SELECT COUNT(*) FROM agent_spans) AS s`)
      .get(session.id, child.id, session.id, child.id) as { m: number; t: number; s: number };
    expect(counts.m).toBe(0);
    expect(counts.t).toBe(0);
    expect((await fx.service.getSession(fx.project, real.session.id)).turns).toHaveLength(1);
  });
});
