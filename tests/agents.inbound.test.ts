import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter, type InboundConnections } from "../src/agents/communications/inbound.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function setup(overrides: Record<string, unknown> = {}) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(project, agentInput("support", { channels: [{ connection_id: "ops-slack" }, { connection_id: "tg" }], ...overrides }), { source: "console" });
  await service.setEnabled(project, "support", true, { source: "console" });
  const replies: Array<{ connectionId: string; to: string; text: string; key: string }> = [];
  const connections: InboundConnections = {
    find: (id) => ({ "ops-slack": { provider: "slack", secret: "sign" }, tg: { provider: "telegram", secret: "tok" }, "no-secret": { provider: "slack", secret: undefined } })[id],
    reply: async (connectionId, to, text, key) => void replies.push({ connectionId, to, text, key }),
  };
  const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `re: ${m.at(-1)!.text}`) });
  const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project });
  return { ...fixture, router, replies };
}

function slackRequest(body: Record<string, unknown>, secret = "sign") {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return { raw, headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp } };
}
const slackEvent = { event: { type: "message", text: "where is my order?", channel: "C0123ABCD", ts: "1700000000.0001", event_ts: "1700000000.0001", user: "U1" } };

describe("agent inbound webhooks", () => {
  it("runs a turn for a signed Slack message and replies on the same channel", async () => {
    const { router, replies, service, project } = await setup();
    const req = slackRequest(slackEvent);
    expect(await router.handle("ops-slack", req.headers, req.raw)).toEqual({ status: 200, body: { ok: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ connectionId: "ops-slack", to: "C0123ABCD", text: "re: where is my order?" });
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toMatchObject([{ source: "slack", turnCount: 1 }]);
  });

  it("answers Slack's URL verification challenge after verifying the signature", async () => {
    const { router } = await setup();
    const req = slackRequest({ type: "url_verification", challenge: "abc" });
    expect(await router.handle("ops-slack", req.headers, req.raw)).toEqual({ status: 200, body: { challenge: "abc" } });
  });

  it("refuses bad signatures, unknown connections and connections without an inbound secret", async () => {
    const { router } = await setup();
    const bad = slackRequest(slackEvent, "wrong");
    expect((await router.handle("ops-slack", bad.headers, bad.raw)).status).toBe(401);
    expect((await router.handle("missing", {}, "{}")).status).toBe(404);
    expect((await router.handle("no-secret", {}, "{}")).status).toBe(404);
  });

  it("does not start a second turn for a redelivered event", async () => {
    const { router, replies } = await setup();
    const req = slackRequest(slackEvent);
    await router.handle("ops-slack", req.headers, req.raw);
    expect(await router.handle("ops-slack", req.headers, req.raw)).toEqual({ status: 200, body: { duplicate: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
  });

  it("keeps one session per Slack thread across messages", async () => {
    const { router, replies, service, project } = await setup();
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "and the refund?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.turnCount).toBe(2);
  });

  it("ignores bot messages and messages for a connection no agent is bound to", async () => {
    const { router, replies } = await setup({ channels: [] });
    const unbound = slackRequest(slackEvent);
    expect(await router.handle("ops-slack", unbound.headers, unbound.raw)).toEqual({ status: 200, body: { ignored: true } });
    const bot = slackRequest({ event: { ...slackEvent.event, bot_id: "B1" } });
    expect(await router.handle("ops-slack", bot.headers, bot.raw)).toEqual({ status: 200, body: { ignored: true } });
    expect(replies).toHaveLength(0);
  });

  it("verifies the Telegram secret header and replies to the chat", async () => {
    const { router, replies } = await setup();
    const body = JSON.stringify({ message: { message_id: 5, text: "hi", chat: { id: 77 }, from: { username: "sam" } } });
    expect((await router.handle("tg", { "x-telegram-bot-api-secret-token": "nope" }, body)).status).toBe(401);
    expect((await router.handle("tg", { "x-telegram-bot-api-secret-token": "tok" }, body)).status).toBe(200);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ to: "77", text: "re: hi" });
  });

  it("tells the sender when the session hit a limit", async () => {
    const { router, replies } = await setup({ limits: { max_turns: 1 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toMatch(/limit of 1 turns/);
  });
});

function router_handle(router: AgentInboundRouter, req: { raw: string; headers: Record<string, string> }) {
  return router.handle("ops-slack", req.headers, req.raw);
}
