import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import type { ConversationBackend } from "../src/agents/sessions.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function enabledAgent(overrides: Record<string, unknown> = {}) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  await fixture.service.create(fixture.project, agentInput("helper", overrides), { source: "console" });
  await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
  return fixture;
}

describe("agent chat turns", () => {
  it("opens a session, streams the reply, and stores the transcript with the prior history", async () => {
    const { service, project } = await enabledAgent();
    const backend = scriptedBackend((messages) => `seen ${messages.length}`);
    const chat = new AgentChatController({ service, backend });
    const deltas: string[] = [];
    let opened = "";
    const first = await chat.send({
      projectRoot: project,
      agentId: "helper",
      text: "hello",
      onDelta: (text) => deltas.push(text),
      onSessionOpened: (id) => (opened = id),
    });
    expect(first.session).toMatchObject({ id: opened, status: "open", source: "console", title: "hello" });
    expect(deltas.join("")).toBe("seen 1");
    const second = await chat.send({ projectRoot: project, agentId: "helper", sessionId: opened, text: "again" });
    expect(second.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "seen 1"],
      ["user", "again"],
      ["assistant", "seen 3"],
    ]);
    expect(second.turns.map((turn) => [turn.seq, turn.status, turn.inputTokens, turn.outputTokens])).toEqual([
      [1, "succeeded", 10, 5],
      [2, "succeeded", 10, 5],
    ]);
  });

  it("stores span bodies only when capture is full, and no spans when capture is off (AE4)", async () => {
    for (const [capture, expectBody, expectSpan] of [
      ["metadata", false, true],
      ["full", true, true],
      ["off", false, false],
    ] as const) {
      const { service, project } = await enabledAgent({ observability: { capture } });
      const chat = new AgentChatController({ service, backend: scriptedBackend(() => "token sk-ant-api03-SECRETSECRETSECRETSECRET") });
      const detail = await chat.send({ projectRoot: project, agentId: "helper", text: "hi" });
      const spans = service.listSpans(project, detail.session.id);
      expect(spans.length > 0).toBe(expectSpan);
      if (!expectSpan) continue;
      const root = spans.find((span) => span.kind === "agent")!;
      expect(root).toMatchObject({ status: "ok", inputTokens: 10, outputTokens: 5, parentSpanId: null });
      expect(root.inputText !== null).toBe(expectBody);
      if (expectBody) expect(root.outputText).not.toContain("SECRETSECRET");
    }
  });

  it("blocks a reply that matches a guardrail and records the failed turn", async () => {
    const { service, project } = await enabledAgent({ guardrails: { block_patterns: ["internal-only"] } });
    const chat = new AgentChatController({ service, backend: scriptedBackend(() => "this is internal-only data") });
    let sessionId = "";
    await expect(
      chat.send({ projectRoot: project, agentId: "helper", text: "hi", onSessionOpened: (id) => (sessionId = id) }),
    ).rejects.toMatchObject({ code: "agent.guardrail_blocked" });
    const detail = await service.getSession(project, sessionId);
    expect(detail.messages.map((message) => message.role)).toEqual(["user"]);
    expect(detail.turns[0]).toMatchObject({ status: "failed", errorCode: "agent.guardrail_blocked" });
    expect(detail.session.status).toBe("open");
  });

  it("records a failed turn when the backend throws, and the session can continue", async () => {
    const { service, project } = await enabledAgent();
    let fail = true;
    const backend: ConversationBackend = {
      id: "pi",
      async complete() {
        if (fail) throw new Error("provider down");
        return { text: "recovered" };
      },
    };
    const chat = new AgentChatController({ service, backend });
    let sessionId = "";
    await expect(
      chat.send({ projectRoot: project, agentId: "helper", text: "hi", onSessionOpened: (id) => (sessionId = id) }),
    ).rejects.toThrow("provider down");
    fail = false;
    const detail = await chat.send({ projectRoot: project, agentId: "helper", sessionId, text: "retry" });
    expect(detail.turns.map((turn) => [turn.status, turn.errorCode])).toEqual([
      ["failed", "agent.backend_failed"],
      ["succeeded", null],
    ]);
  });

  it("stops a running turn and records it as cancelled with the partial reply", async () => {
    const { service, project } = await enabledAgent();
    let release: () => void = () => undefined;
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        input.onDelta("partial");
        await new Promise<void>((resolve) => {
          release = resolve;
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "partial" };
      },
    };
    const chat = new AgentChatController({ service, backend });
    let sessionId = "";
    const pending = chat.send({ projectRoot: project, agentId: "helper", text: "go", onSessionOpened: (id) => (sessionId = id) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chat.stop(sessionId)).toBe(true);
    const detail = await pending;
    expect(detail.turns[0]).toMatchObject({ status: "cancelled" });
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", text: "partial" });
    release();
  });

  it("serializes turns on one session", async () => {
    const { service, project } = await enabledAgent();
    const order: string[] = [];
    const backend: ConversationBackend = {
      id: "pi",
      async complete(input) {
        const text = input.messages.at(-1)!.text;
        order.push(`start ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end ${text}`);
        return { text };
      },
    };
    const chat = new AgentChatController({ service, backend });
    const opened = await chat.send({ projectRoot: project, agentId: "helper", text: "a" });
    order.length = 0;
    await Promise.all([
      chat.send({ projectRoot: project, agentId: "helper", sessionId: opened.session.id, text: "b" }),
      chat.send({ projectRoot: project, agentId: "helper", sessionId: opened.session.id, text: "c" }),
    ]);
    expect(order).toEqual(["start b", "end b", "start c", "end c"]);
  });
});
