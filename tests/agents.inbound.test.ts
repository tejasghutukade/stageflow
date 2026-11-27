import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter, type InboundConnections } from "../src/agents/communications/inbound.js";
import { PRESENT_UI_TOOL_NAME } from "../src/agents/presentUi.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { AgentService } from "../src/agents/service.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { CHANNEL_SENDER_CACHE_MS } from "../src/identity/types.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";
import { orderCustomerStub } from "./helpers/customerAdapterStub.js";

const fixtures: AgentsFixture[] = [];
const identityStores: ConsumerIdentityStore[] = [];
afterEach(async () => {
  for (const store of identityStores.splice(0)) store.close();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const JANE_PHONE = "+14155550123";
const UNMAPPED_REPLY = "We couldn't match this number to an account.";

function consumerInboundFixture(resolve: () => { status: "found"; accountId: string } | { status: "not_found" }) {
  const fixturePromise = agentsFixture().then(async (fixture) => {
    fixtures.push(fixture);
    const store = new ConsumerIdentityStore(":memory:", "w", () => fixture.clock.now.getTime());
    identityStores.push(store);
    const customer = orderCustomerStub({
      resources: new Map(),
      resolveSender: async () => resolve(),
    });
    const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), customer, "consumer_v1");
    auth.registerChannel({
      id: "sms-id",
      channelConnectionId: "line",
      agentId: "support",
      provider: "imessage",
      unmappedReply: UNMAPPED_REPLY,
      permission: { scope: "own", agents: ["support"], actions: ["conversation:use"] },
    });
    const service = new AgentService({
      store: fixture.store,
      now: () => fixture.clock.now,
      getConsumerPublication: () => ({
        identityEnabled: true,
        hasChannelConnection: (agentId, connectionId) => auth.hasChannelConnection(agentId, connectionId),
      }),
    });
    const { project } = fixture;
    await service.create(project, agentInput("support", { channel: { access: "authenticated", connection_id: "line", allow_from: [JANE_PHONE] } }), { source: "console" });
    await service.setEnabled(project, "support", true, { source: "console" });
    const replies: string[] = [];
    const seen: string[][] = [];
    const connections: InboundConnections = {
      find: () => ({ provider: "imessage", secret: "x" }),
      reply: async (_id, _to, text) => { replies.push(text); },
    };
    const chat = new AgentChatController({
      service,
      backend: scriptedBackend((messages) => {
        seen.push(messages.map((message) => message.text));
        return `re: ${messages.at(-1)!.text}`;
      }),
      consumerAuthorization: auth,
    });
    const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project, consumerAuthorization: auth });
    return { ...fixture, service, project, router, chat, connections, replies, seen, store, auth };
  });
  return fixturePromise;
}

async function setup(overrides: Record<string, unknown> = {}) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(project, agentInput("support", { channel: { connection_id: "ops-slack", allow_from: ["*"] }, ...overrides }), { source: "console" });
  await service.setEnabled(project, "support", true, { source: "console" });
  await service.create(project, agentInput("telegram_support", { channel: { connection_id: "tg", allow_from: ["*"] } }), { source: "console" });
  await service.setEnabled(project, "telegram_support", true, { source: "console" });
  const replies: Array<{ connectionId: string; to: string; text: string; key: string }> = [];
  const connections: InboundConnections = {
    find: (id) => ({ "ops-slack": { provider: "slack", secret: "sign" }, tg: { provider: "telegram", secret: "tok" }, mail: { provider: "agentmail", secret: "whsec" }, "no-secret": { provider: "slack", secret: undefined } })[id],
    reply: async (connectionId, to, text, key) => void replies.push({ connectionId, to, text, key }),
  };
  const seen: string[][] = [];
  const chat = new AgentChatController({
    service,
    backend: scriptedBackend((m) => {
      seen.push(m.map((message) => message.text));
      return `re: ${m.at(-1)!.text}`;
    }),
  });
  const logs: string[] = [];
  const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project, logError: (line) => logs.push(line) });
  return { ...fixture, router, replies, seen, logs };
}

function slackRequest(body: Record<string, unknown>, secret = "sign") {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return { raw, headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp } };
}
const slackEvent = { event: { type: "message", text: "where is my order?", channel: "C0123ABCD", ts: "1700000000.0001", event_ts: "1700000000.0001", user: "U1" } };

describe("agent inbound webhooks", () => {
  it("delivers present_ui as a readable link on the channel, not raw JSON", async () => {
    const uiPart = {
      v: UI_PART_SCHEMA_VERSION,
      kind: UI_PART_KIND_ARTIFACT_REF,
      key: "agent:helper/weekly",
      title: "Weekly",
      fallback: { text: "Weekly", url: "http://127.0.0.1:3847/#/artifacts/agent%3Ahelper/weekly" },
    };
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(
      project,
      agentInput("support", {
        channel: { connection_id: "ops-slack", allow_from: ["*"] },
        ui: { present: true, kinds: ["static.markdown"], functions: [] },
      }),
      { source: "console" },
    );
    await service.setEnabled(project, "support", true, { source: "console" });
    const replies: Array<{ text: string }> = [];
    const connections: InboundConnections = {
      find: (id) => (id === "ops-slack" ? { provider: "slack", secret: "sign" } : undefined),
      reply: async (_connectionId, _to, text) => void replies.push({ text }),
    };
    const chat = new AgentChatController({
      service,
      backend: scriptedBackend(async (_messages, ctx) => {
        await ctx.tool(PRESENT_UI_TOOL_NAME, { key: uiPart.key }, () => JSON.stringify({ type: "ui", ui: uiPart }));
        return "Shown";
      }),
    });
    const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project });
    const req = slackRequest(slackEvent);
    await router.handle("ops-slack", req.headers, req.raw);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]!.text).toContain("Shown");
    expect(replies[0]!.text).toContain("Weekly");
    expect(replies[0]!.text).not.toContain(uiPart.fallback.url);
    expect(replies[0]!.text).not.toContain('"type":"ui"');
  });

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
    const { router, replies } = await setup({ channel: undefined });
    const unbound = slackRequest(slackEvent);
    expect(await router.handle("ops-slack", unbound.headers, unbound.raw)).toEqual({ status: 200, body: { ignored: true } });
    const bot = slackRequest({ event: { ...slackEvent.event, bot_id: "B1" } });
    expect(await router.handle("ops-slack", bot.headers, bot.raw)).toEqual({ status: 200, body: { ignored: true } });
    expect(replies).toHaveLength(0);
  });

  it("verifies the Telegram secret header and replies to the chat", async () => {
    const { router, replies } = await setup();
    const body = JSON.stringify({ message: { message_id: 5, text: "hi", chat: { id: 77, type: "private" }, from: { id: 77, username: "sam" } } });
    expect((await router.handle("tg", { "x-telegram-bot-api-secret-token": "nope" }, body)).status).toBe(401);
    expect((await router.handle("tg", { "x-telegram-bot-api-secret-token": "tok" }, body)).status).toBe(200);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ to: "77", text: "re: hi" });
  });

  const telegram = (message: Record<string, unknown>) => ({ headers: { "x-telegram-bot-api-secret-token": "tok" }, raw: JSON.stringify({ message: { message_id: 9, text: "hi", ...message } }) });

  it("ignores Telegram groups and messages with no user id", async () => {
    const { router, replies } = await setup();
    for (const type of ["group", "supergroup", "channel"]) {
      const request = telegram({ chat: { id: -100, type }, from: { id: 7700001, username: "sammy" } });
      expect(await router.handle("tg", request.headers, request.raw)).toEqual({ status: 200, body: { ignored: true } });
    }
    const anonymous = telegram({ chat: { id: 7700001, type: "private" }, from: { username: "sammy" } });
    expect(await router.handle("tg", anonymous.headers, anonymous.raw)).toEqual({ status: 200, body: { ignored: true } });
    expect(replies).toHaveLength(0);
  });

  it("matches a Telegram sender by user id, so a renamed user stays in and a taken username gets in only by a username entry", async () => {
    const { router, replies, service, project, logs } = await setup();
    const save = async (allow_from: string[]) => {
      const current = await service.get(project, "telegram_support");
      await service.save(project, "telegram_support", { baseRevision: current.agent.revision, definition: agentInput("telegram_support", { enabled: true, channel: { connection_id: "tg", allow_from } }) }, { source: "console" });
    };
    await save(["7700001"]);
    const renamed = telegram({ message_id: 1, chat: { id: 7700001, type: "private" }, from: { id: 7700001, username: "sammy_new" } });
    expect(await router.handle("tg", renamed.headers, renamed.raw)).toEqual({ status: 200, body: { ok: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    // Someone else now holds the old username: the id entry does not let them in, and the log names their id.
    const taker = telegram({ message_id: 2, chat: { id: 8800001, type: "private" }, from: { id: 8800001, username: "sammy" } });
    expect(await router.handle("tg", taker.headers, taker.raw)).toEqual({ status: 200, body: { ignored: true } });
    expect(logs.some((line) => line.includes("user id 8800001 (@sammy)"))).toBe(true);
    await save(["@sammy"]);
    const again = telegram({ message_id: 3, chat: { id: 8800001, type: "private" }, from: { id: 8800001, username: "sammy" } });
    expect(await router.handle("tg", again.headers, again.raw)).toEqual({ status: 200, body: { ok: true } });
    const usernameOnly = await service.validate(project, agentInput("other", { channel: { connection_id: "tg2", allow_from: ["@sammy"] } }));
    expect(usernameOnly.warnings.map((w) => w.code)).toContain("agent.channel_username_entry");
  });

  it("does not take AgentMail webhooks: mail arrives on the stream the Host opens", async () => {
    const { router } = await setup();
    const body = JSON.stringify({ event_type: "message.received", event_id: "e1", message: { inbox_id: "a@agentmail.to", thread_id: "t", message_id: "m", from_: ["x@y.com"], text: "hi" } });
    expect((await router.handle("mail", { "svix-id": "1", "svix-timestamp": "1", "svix-signature": "v1,abc", "x-agentmail-signature": "abc" }, body)).status).toBe(404);
  });

  it("keeps a Slack direct message in one session per person and a channel thread shared", async () => {
    const { router, service, project, replies } = await setup();
    const dm = (ts: string, user: string) => slackRequest({ event: { type: "message", channel_type: "im", text: `hi ${ts}`, channel: "D0AAA", ts, event_ts: ts, user } });
    for (const [ts, user] of [["1.1", "U1"], ["2.2", "U1"]] as const) {
      const request = dm(ts, user);
      await router.handle("ops-slack", request.headers, request.raw);
    }
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect((await service.listSessions(project, "support", { limit: 50 })).sessions).toHaveLength(1);
    const thread = (ts: string, user: string) => slackRequest({ event: { type: "message", channel_type: "channel", text: `hey ${ts}`, channel: "C0BBB", thread_ts: "9.9", ts, event_ts: ts, user } });
    for (const [ts, user] of [["9.9", "U1"], ["10.1", "U2"]] as const) {
      const request = thread(ts, user);
      await router.handle("ops-slack", request.headers, request.raw);
    }
    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect((await service.listSessions(project, "support", { limit: 50 })).sessions).toHaveLength(2);
  });

  it("opens a new session when the thread is past its turn limit", async () => {
    const { router, replies, service, project } = await setup({ limits: { max_turns: 1 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toBe("re: where is my order?");
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
  });

  it("opens a new session when the thread is past its minute limit", async () => {
    const { router, replies, service, project, clock } = await setup({ limits: { session_minutes: 5 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "still there?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    clock.advance(5 * 60_000);
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toBe("re: still there?");
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
  });

  it("keeps the session and tells the sender when the thread is past its cost limit", async () => {
    const { router, replies, service, project } = await setup({ limits: { cost_usd: 0.001 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "and the refund?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]!.text).toBe("re: where is my order?");
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toMatchObject({ connectionId: "ops-slack", to: "C0123ABCD", text: "This session reached its cost limit of $0.001." });
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.turnCount).toBe(1);
  });

  it("does not roll a cost-capped thread when the session is also past its minutes", async () => {
    const { router, replies, service, project, clock } = await setup({ limits: { cost_usd: 0.001 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "and the refund?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    clock.advance(11 * 60_000);
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toMatch(/cost limit/);
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(1);
  });

  it("starts a rolled-over session with the previous session's last messages as context", async () => {
    const { router, replies, service, project, seen } = await setup({ limits: { max_turns: 1 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "and the refund?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(seen[1]).toEqual(["where is my order?", "re: where is my order?", "and the refund?"]);
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
    const details = await Promise.all(sessions.map((item) => service.getSession(project, item.id)));
    const rolled = details.find((detail) => detail.session.rolledFromSessionId !== undefined)!;
    const original = details.find((detail) => detail.session.rolledFromSessionId === undefined)!;
    expect(rolled.session.rolledFromSessionId).toBe(original.session.id);
    expect(rolled.messages.map((m) => m.text)).toEqual(["and the refund?", "re: and the refund?"]);
  });

  it("carries spend across a turn-limit rollover and then refuses the thread", async () => {
    const { router, replies, service, project } = await setup({ limits: { max_turns: 1, cost_usd: 0.002 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "again", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    const third = slackRequest({ event: { ...slackEvent.event, text: "once more", ts: "3.0", event_ts: "3.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toBe("re: again");
    let sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
    await router_handle(router, third);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[2]!.text).toMatch(/cost limit/);
    expect(replies[2]!.text).not.toBe("re: once more");
    sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
  });

  it("rolls a cost-capped thread onto a new session once the 24-hour window passes", async () => {
    const { router, replies, service, project, clock } = await setup({ limits: { cost_usd: 0.001 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "and the refund?", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    const third = slackRequest({ event: { ...slackEvent.event, text: "next day", ts: "3.0", event_ts: "3.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toMatch(/cost limit/);
    clock.advance(25 * 60 * 60_000);
    await router_handle(router, third);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(replies[2]!.text).toBe("re: next day");
    const sessions = (await service.listSessions(project, "support", { limit: 10 })).sessions;
    expect(sessions).toHaveLength(2);
  });

  it("accepts a message on an always-on agent a day after the cost cap", async () => {
    const { router, replies, clock } = await setup({ limits: { always_on: true, cost_usd: 0.001 } });
    const first = slackRequest({ event: { ...slackEvent.event, ts: "1.0", event_ts: "1.0", thread_ts: "1.0" } });
    const second = slackRequest({ event: { ...slackEvent.event, text: "next day", ts: "2.0", event_ts: "2.0", thread_ts: "1.0" } });
    await router_handle(router, first);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    clock.advance(25 * 60 * 60_000);
    await router_handle(router, second);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]!.text).toBe("re: next day");
  });

  it("does not carry prior session messages when lookup resolves a different account", async () => {
    let accountId = "cus_a";
    const { router, replies, seen, service, project, clock } = await consumerInboundFixture(() => ({ status: "found", accountId }));
    const inbound = (eventId: string, text: string) => ({
      provider: "imessage" as const,
      connectionId: "line",
      eventId,
      threadId: JANE_PHONE,
      text,
      from: JANE_PHONE,
      replyTo: JANE_PHONE,
    });
    await router.deliver(inbound("m1", "first question"));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    accountId = "cus_b";
    clock.advance(CHANNEL_SENDER_CACHE_MS + 1);
    await router.deliver(inbound("m2", "follow-up"));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(seen[1]).toEqual(["follow-up"]);
    expect((await service.listSessions(project, "support", { limit: 10 })).sessions).toHaveLength(2);
  });

  it("ignores authenticated channel mail when admission is not required", async () => {
    const { service, project, seen, auth, chat, connections } = await consumerInboundFixture(() => ({ status: "found", accountId: "cus_881" }));
    const logs: string[] = [];
    const spyRouter = new AgentInboundRouter({
      service,
      chat,
      connections,
      projectRoot: project,
      consumerAuthorization: auth,
      logError: (line) => logs.push(line),
    });
    vi.spyOn(auth, "admitChannelSender").mockResolvedValue({ outcome: "not_required" });
    const inbound = {
      provider: "imessage" as const,
      connectionId: "line",
      eventId: "imessage:noreq",
      threadId: JANE_PHONE,
      text: "where is my order?",
      from: JANE_PHONE,
      replyTo: JANE_PHONE,
    };
    expect(await spyRouter.deliver(inbound)).toEqual({ status: 200, body: { ignored: true } });
    expect(seen).toEqual([]);
    expect((await service.listSessions(project, "support", { limit: 10 })).sessions).toEqual([]);
    expect(logs.some((line) => line.includes("imessage") && line.includes("not admitted"))).toBe(true);
    expect(logs.join("\n")).not.toMatch(/where is my order|14155550123/);
  });

  it("still converses on allow_list Slack when admission is not required", async () => {
    const { router, replies, seen } = await setup();
    const req = slackRequest(slackEvent);
    expect(await router.handle("ops-slack", req.headers, req.raw)).toEqual({ status: 200, body: { ok: true } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(seen).toHaveLength(1);
  });

  it("finishes resume as verification_required when authenticated admission is refused", async () => {
    const { service, project } = await consumerInboundFixture(() => ({ status: "found", accountId: "cus_881" }));
    const current = await service.get(project, "support");
    await service.save(project, "support", {
      baseRevision: current.agent.revision,
      definition: agentInput("support", {
        enabled: true,
        limits: { always_on: true },
        channel: { access: "authenticated", connection_id: "line", allow_from: [JANE_PHONE] },
      }),
    }, { source: "console" });
    const inbound = {
      provider: "imessage" as const,
      connectionId: "line",
      eventId: "imessage:resume",
      threadId: JANE_PHONE,
      text: "stuck turn",
      from: JANE_PHONE,
      replyTo: JANE_PHONE,
    };
    const routed = await service.receive(project, inbound);
    await service.beginTurn(project, routed.sessionId, { text: inbound.text, author: inbound.from });
    service.recoverInterruptedTurns();
    const unauthRouter = new AgentInboundRouter({
      service,
      chat: new AgentChatController({ service, backend: scriptedBackend(() => "no") }),
      connections: { find: () => ({ provider: "imessage", secret: "x" }), reply: async () => {} },
      projectRoot: project,
    });
    expect(await unauthRouter.resumeInterrupted()).toBe(1);
    const detail = await service.getSession(project, routed.sessionId);
    expect(detail.turns).toMatchObject([{ status: "failed", errorCode: "identity.verification_required" }]);
  });

  it("finishes a resumable turn as failed when the sender no longer maps to an account", async () => {
    let mapped = true;
    const { router, replies, service, project } = await consumerInboundFixture(() =>
      mapped ? { status: "found", accountId: "cus_881" } : { status: "not_found" },
    );
    const current = await service.get(project, "support");
    await service.save(project, "support", {
      baseRevision: current.agent.revision,
      definition: agentInput("support", { enabled: true, limits: { always_on: true }, channel: { access: "authenticated", connection_id: "line", allow_from: [JANE_PHONE] } }),
    }, { source: "console" });
    const inbound = {
      provider: "imessage" as const,
      connectionId: "line",
      eventId: "imessage:1",
      threadId: JANE_PHONE,
      text: "are you there?",
      from: JANE_PHONE,
      replyTo: JANE_PHONE,
    };
    const routed = await service.receive(project, inbound);
    await service.beginTurn(project, routed.sessionId, { text: inbound.text, author: inbound.from });
    expect(service.recoverInterruptedTurns()).toBe(0);
    mapped = false;
    expect(await router.resumeInterrupted()).toBe(1);
    const detail = await service.getSession(project, routed.sessionId);
    expect(detail.turns).toMatchObject([{ status: "failed", errorCode: "identity.sender_unmapped" }]);
  });
});

function router_handle(router: AgentInboundRouter, req: { raw: string; headers: Record<string, string> }) {
  return router.handle("ops-slack", req.headers, req.raw);
}
