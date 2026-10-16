import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter } from "../src/agents/communications/inbound.js";
import { createIMessageListener, toInbound, type IMessageTransport, type SpectrumInbound, type SpectrumStream } from "../src/agents/communications/imessageListener.js";
import type { ChannelListener, ListenerState } from "../src/agents/communications/listener.js";
import type { AgentInboundMessage } from "../src/agents/communications/port.js";
import { ChannelSupervisor, type ListenerFactory } from "../src/agents/communications/supervisor.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const text = (id: string, body: string, over: Partial<SpectrumInbound> = {}): SpectrumInbound => ({ id, direction: "inbound", content: { type: "text", text: body }, sender: { id: "+1 (415) 555-0123" }, space: { id: "s1", type: "dm" }, ...over });

describe("iMessage messages", () => {
  it("keeps inbound one-to-one text and ignores the rest", () => {
    expect(toInbound("line", text("m1", " hi "))).toEqual({ provider: "imessage", connectionId: "line", eventId: "imessage:m1", threadId: "+14155550123", text: "hi", from: "+14155550123", replyTo: "+14155550123" });
    expect(toInbound("line", text("m2", "x", { direction: "outbound" }))).toBeUndefined();
    expect(toInbound("line", text("m3", "x", { content: { type: "reaction" } }))).toBeUndefined();
    expect(toInbound("line", text("m4", "  "))).toBeUndefined();
    expect(toInbound("line", text("m5", "x", { space: { id: "g", type: "group" } }))).toBeUndefined();
    expect(toInbound("line", text("m6", "x", { sender: undefined }))).toBeUndefined();
  });
});

describe("iMessage listener", () => {
  function streamOf(messages: SpectrumInbound[], endWith?: Error): SpectrumStream & { stopped: boolean } {
    const stream = {
      stopped: false,
      stop: async () => void (stream.stopped = true),
      messages: (async function* () {
        for (const message of messages) yield [undefined, message] as [unknown, SpectrumInbound];
        if (endWith) throw endWith;
      })(),
    };
    return stream;
  }

  it("hands messages to the agent and reopens the stream when it ends", async () => {
    const streams = [streamOf([text("m1", "one")], new Error("network")), streamOf([text("m2", "two")])];
    let blocker: (() => void) | undefined;
    const transport: IMessageTransport = {
      open: async () => {
        const next = streams.shift();
        if (next) return next;
        // The third open waits forever, like a healthy idle stream.
        return { stop: async () => void blocker?.(), messages: (async function* () { await new Promise<void>((resolve) => (blocker = resolve)); })() } as SpectrumStream;
      },
    };
    const delivered: AgentInboundMessage[] = [];
    const listener = createIMessageListener({ connectionId: "line" }, transport, { onMessage: async (m) => void delivered.push(m), log: () => undefined, sleep: async () => undefined });
    await listener.start();
    await vi.waitFor(() => expect(delivered.map((m) => m.text)).toEqual(["one", "two"]));
    await vi.waitFor(() => expect(listener.state().status).toBe("connected"));
    expect(listener.state().received).toBe(2);
    await listener.stop();
    expect(listener.state().status).toBe("stopped");
  });
});

describe("channel supervisor", () => {
  type Summary = { id: string; enabled: boolean; channelConnection: string | null };
  function setup(agents: Summary[], connections: Record<string, { provider: string; config?: unknown }>) {
    const started: string[] = [];
    const stopped: string[] = [];
    let changed: (() => void) | undefined;
    const states = new Map<string, ListenerState>();
    const factory: ListenerFactory = (connection) => {
      const state: ListenerState = { status: "connected", since: "now", received: 0 };
      states.set(connection.id, state);
      const listener: ChannelListener = {
        start: async () => void started.push(connection.id),
        stop: async () => void stopped.push(connection.id),
        state: () => state,
      };
      return listener;
    };
    const supervisor = new ChannelSupervisor({
      service: { list: async () => agents as never, onChange: (listener) => void (changed = listener) },
      projectRoot: "/p",
      resolve: (id) => (connections[id] ? { id, provider: connections[id]!.provider, config: connections[id]!.config ?? {}, secrets: {} } : undefined),
      deliver: async () => undefined,
      log: () => undefined,
      factories: { agentmail: factory, imessage: factory },
    });
    return { supervisor, started, stopped, agents, connections, fire: () => changed?.() };
  }

  it("listens only for enabled agents on providers it can stream, and follows changes", async () => {
    const { supervisor, started, stopped, agents, fire } = setup(
      [
        { id: "a", enabled: true, channelConnection: "mail" },
        { id: "b", enabled: false, channelConnection: "line" },
        { id: "c", enabled: true, channelConnection: "slack-main" },
        { id: "d", enabled: true, channelConnection: null },
      ],
      { mail: { provider: "agentmail" }, line: { provider: "imessage" }, "slack-main": { provider: "slack" } },
    );
    supervisor.start();
    await supervisor.reconcile();
    expect(started).toEqual(["mail"]);
    expect(supervisor.status("mail")?.status).toBe("connected");
    expect(supervisor.status("slack-main")).toBeUndefined();
    agents[1]!.enabled = true;
    fire();
    await supervisor.reconcile();
    expect(started).toEqual(["mail", "line"]);
    agents[0]!.enabled = false;
    await supervisor.reconcile();
    expect(stopped).toEqual(["mail"]);
    expect(supervisor.status("mail")).toBeUndefined();
    await supervisor.stop();
    expect(stopped).toEqual(["mail", "line"]);
  });

  it("restarts a listener when its connection settings change, and starts once for repeated reconciles", async () => {
    const { supervisor, started, stopped, connections } = setup([{ id: "a", enabled: true, channelConnection: "mail" }], { mail: { provider: "agentmail", config: { inbox: "one@x" } } });
    await supervisor.reconcile();
    await supervisor.reconcile();
    expect(started).toEqual(["mail"]);
    connections.mail = { provider: "agentmail", config: { inbox: "two@x" } };
    await supervisor.reconcile();
    expect(stopped).toEqual(["mail"]);
    expect(started).toEqual(["mail", "mail"]);
    await supervisor.stop();
  });
});

describe("delivering messages", () => {
  it("answers on the connection and ignores a sender who sends too much", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("pal", { channel: { connection_id: "line", allow_from: ["+14155550123"] }, limits: { always_on: true } }), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });
    const replies: Array<{ to: string; text: string }> = [];
    const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `re: ${m.at(-1)!.text}`) });
    const router = new AgentInboundRouter({ service, chat, connections: { find: () => undefined, reply: async (_c, to, text) => void replies.push({ to, text }) }, projectRoot: project, senderLimitPerMinute: 2 });
    const message = (id: string, from = "+14155550123"): AgentInboundMessage => ({ provider: "imessage", connectionId: "line", eventId: `imessage:${id}`, threadId: from, text: `hello ${id}`, from, replyTo: from });
    await router.deliver(message("1"));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router.deliver(message("2"));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect((await router.deliver(message("3"))).body).toEqual({ ignored: true });
    expect((await router.deliver(message("4", "+19998887777"))).body).toEqual({ ignored: true });
    const sessions = (await service.listSessions(project, "pal", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ source: "imessage", turnCount: 2 });
    expect(replies.map((r) => r.text)).toEqual(["re: hello 1", "re: hello 2"]);
  });
});

describe("resuming an always-on conversation", () => {
  it("retries the turn a restart cut off, once, without asking the question twice", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("pal", { channel: { connection_id: "line", allow_from: ["*"] }, limits: { always_on: true } }), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });
    const inbound: AgentInboundMessage = { provider: "imessage", connectionId: "line", eventId: "imessage:1", threadId: "+14155550123", text: "are you there?", from: "+14155550123", replyTo: "+14155550123" };
    const routed = await service.receive(project, inbound);
    // The Host went down while this turn was running.
    await service.beginTurn(project, routed.sessionId, { text: inbound.text, author: inbound.from ?? null });
    expect(service.recoverInterruptedTurns()).toBe(1);

    const replies: string[] = [];
    const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `yes, ${m.length} message(s)`) });
    const router = new AgentInboundRouter({ service, chat, connections: { find: () => undefined, reply: async (_c, _to, text) => void replies.push(text) }, projectRoot: project });
    expect(await router.resumeInterrupted()).toBe(1);
    await vi.waitFor(() => expect(replies).toEqual(["yes, 1 message(s)"]));
    const detail = await service.getSession(project, routed.sessionId);
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([["user", "are you there?"], ["assistant", "yes, 1 message(s)"]]);
    expect(detail.turns.map((t) => t.status)).toEqual(["failed", "succeeded"]);
    expect(await router.resumeInterrupted()).toBe(0);
  });

  it("leaves a normal agent's cut-off turn alone", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("brief", { channel: { connection_id: "line", allow_from: ["*"] } }), { source: "console" });
    await service.setEnabled(project, "brief", true, { source: "console" });
    const routed = await service.receive(project, { provider: "imessage", connectionId: "line", eventId: "imessage:9", threadId: "+1", text: "hi", from: "+14155550123", replyTo: "+14155550123" });
    await service.beginTurn(project, routed.sessionId, { text: "hi" });
    service.recoverInterruptedTurns();
    expect(await service.resumableTurns(project)).toEqual([]);
  });
});
