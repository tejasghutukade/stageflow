import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRequiredAssuranceOverridesForTests, setRequiredAssuranceForTests } from "../src/identity/assurance.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter, type InboundConnections } from "../src/agents/communications/inbound.js";
import { AgentService } from "../src/agents/service.js";
import { admitEmbeddedConsumer } from "../src/identity/handoff.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createOrderApiAdapter } from "../src/identity/orders.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { CHANNEL_SENDER_CACHE_MS, type OwnedResource } from "../src/identity/types.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const stores: ConsumerIdentityStore[] = [];
const fixtures: AgentsFixture[] = [];
const STEP_UP_ENV = "STAGEFLOW_PUBLIC_CHAT_URL";
let savedStepUpUrl: string | undefined;

beforeEach(() => {
  savedStepUpUrl = process.env[STEP_UP_ENV];
  process.env[STEP_UP_ENV] = "https://chat.test/";
});

afterEach(async () => {
  clearRequiredAssuranceOverridesForTests();
  if (savedStepUpUrl === undefined) delete process.env[STEP_UP_ENV];
  else process.env[STEP_UP_ENV] = savedStepUpUrl;
  for (const store of stores.splice(0)) store.close();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const REPLY = "We couldn't match this number to an account. Sign in at acme.com/help.";
const JANE = "+14155550123";

import { orderCustomerStub } from "./helpers/customerAdapterStub.js";

function ordersFor(lookup: (sender: string) => { status: number; body?: unknown } | { throw: true }) {
  const resources = new Map<string, OwnedResource>([
    ["ord_jane", { id: "ord_jane", workspaceId: "w", ownerAccountId: "cus_881", assignedAccountIds: [], version: "1" }],
    ["ord_other", { id: "ord_other", workspaceId: "w", ownerAccountId: "cus_other", assignedAccountIds: [], version: "1" }],
  ]);
  const calls: string[] = [];
  return {
    calls,
    adapter: orderCustomerStub({
      resources,
      resolveSender: async (_workspaceId: string, _channel: string, sender: string) => {
        calls.push(sender);
        const result = lookup(sender);
        if ("throw" in result) throw new Error("down");
        if (result.status === 404) return { status: "not_found" as const };
        if (result.status !== 200) return { status: "failed" as const };
        const body = result.body;
        if (typeof body !== "object" || body === null || typeof (body as { accountId?: unknown }).accountId !== "string") return { status: "failed" as const };
        return { status: "found" as const, accountId: (body as { accountId: string }).accountId };
      },
    }),
  };
}

function host(lookup: Parameters<typeof ordersFor>[0], now = () => Date.now()) {
  const store = new ConsumerIdentityStore(":memory:", "w", now);
  stores.push(store);
  const orders = ordersFor(lookup);
  const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), orders.adapter, "consumer_v1");
  auth.registerChannel({
    id: "sms-id", channelConnectionId: "sms", agentId: "help", provider: "imessage", unmappedReply: REPLY,
    permission: { scope: "own", agents: ["help"], actions: ["conversation:use", "order:read"] },
  });
  return { store, auth, calls: orders.calls };
}

describe("channel sender admission", () => {
  it("binds a resolved sender to their account and refuses someone else's order", async () => {
    const { store, auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: "+1 (415) 555-0123", signal: AbortSignal.timeout(3_000),
    });
    expect(admitted).toMatchObject({ outcome: "admitted", accountId: "cus_881", assurance: "provider_verified" });
    if (admitted.outcome !== "admitted") return;
    expect(store.sessionProtection(admitted.sessionId).assurance).toBe("provider_verified");
    auth.bind("conv", admitted.sessionId, "help", 1);
    await auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    await expect(auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_other" }, AbortSignal.timeout(3_000))).rejects.toThrow("identity.not_available");
    const audit = store.listAudit(20);
    expect(audit.some((event) => event.outcome === "allow" && event.reason === "order_read")).toBe(true);
    expect(audit.some((event) => event.outcome === "deny")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("where is my order");
  });

  it("keeps provider_verified assurance on a narrowed channel grant", async () => {
    const store = new ConsumerIdentityStore(":memory:", "w");
    stores.push(store);
    const orders = ordersFor(() => ({ status: 200, body: { accountId: "cus_881" } }));
    const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), orders.adapter, "consumer_v1");
    auth.registerChannel({
      id: "sms-id", channelConnectionId: "sms", agentId: "help", provider: "imessage", unmappedReply: REPLY,
      permission: { scope: "own", agents: ["help", "helper"], actions: ["conversation:use", "order:read"] },
    });
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    if (admitted.outcome !== "admitted") throw new Error("expected admission");
    auth.bind("conv", admitted.sessionId, "help", 1);
    const parent = store.conversation("conv", admitted.sessionId, "help", 1);
    const child = auth.narrowAuthority(parent, "helper", {});
    expect(store.sessionProtection(parent.sessionId).assurance).toBe("provider_verified");
    expect(store.sessionProtection(child.sessionId).assurance).toBe("provider_verified");
  });

  it("answers an unmapped, malformed or failed lookup with the fixed reply and no session", async () => {
    const unmapped = host(() => ({ status: 404 }));
    expect(await unmapped.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toEqual({ outcome: "unmapped", reply: REPLY, reason: "sender_unmapped" });

    const malformed = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    expect(await malformed.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: "not-a-phone", signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "sender_malformed" });
    expect(malformed.calls).toEqual([]);

    const failed = host(() => ({ throw: true }));
    expect(await failed.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "lookup_failed" });
    expect(failed.store.listAssignments()).toEqual([]);
  });

  it("lets an explicit revoke beat a lookup allow, and drops a sender the lookup stops returning", async () => {
    let now = 1_000_000;
    let found = true;
    const { store, auth, calls } = host(() => found ? { status: 200, body: { accountId: "cus_881" } } : { status: 404 }, () => now);
    const first = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    expect(first.outcome).toBe("admitted");
    const person = store.listAssignments().find((row) => row.subject === JANE);
    store.revoke("principal", person!.id);
    const revoked = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    expect(revoked).toMatchObject({ outcome: "unmapped", reason: "sender_revoked" });
    expect(calls).toEqual([JANE]);

    found = false;
    now += CHANNEL_SENDER_CACHE_MS + 1;
    store.assign("sms-id", "+14155550100", "cus_100", "import", { scope: "own", agents: ["help"], actions: ["conversation:use", "order:read"] });
    const imported = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: "+14155550100", signal: AbortSignal.timeout(3_000),
    });
    expect(imported).toMatchObject({ outcome: "admitted", accountId: "cus_100" });
  });

  it("stops the next message after the grant or the connection is revoked, and after the lookup cache ends", async () => {
    let now = 5_000_000;
    let found = true;
    const { store, auth } = host(() => found ? { status: 200, body: { accountId: "cus_881" } } : { status: 404 }, () => now);
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    if (admitted.outcome !== "admitted") throw new Error(admitted.reason);
    store.revoke("grant", store.resolve(admitted.sessionId, "help").grantId);
    expect(await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "grant_revoked" });

    const other = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    await other.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    other.store.disableConnection("sms-id");
    expect(await other.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "connection_inactive" });

    let clock = 5_000_000;
    let listed = true;
    const cached = host(() => listed ? { status: 200, body: { accountId: "cus_881" } } : { status: 404 }, () => clock);
    expect((await cached.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).outcome).toBe("admitted");
    listed = false;
    clock += CHANNEL_SENDER_CACHE_MS + 1;
    expect(await cached.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "sender_unmapped" });
  });

  it("refuses a channel bearer on web admission and a handoff connection on a channel", async () => {
    const { store, auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "sms", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    });
    const opened = store.openChannelSession("sms-id", "help", JANE, Date.now() + 60_000, "provider_verified");
    expect(() => store.authenticate(opened.token, "help")).toThrow("identity.verification_required");
    await expect(admitEmbeddedConsumer(store, "sms-id", "help", "not-a-jwt")).rejects.toThrow("identity.verification_required");
    store.registerHandoff({
      id: "app", issuer: "https://issuer.example", agentId: "help", audience: "stageflow", algorithms: ["ES256"],
      publicJwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] },
    });
    expect(await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "app", provider: "imessage", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toEqual({ outcome: "not_required" });
  });

  it("does not run a turn for an unmatched sender", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("help", { channel: { connection_id: "sms", allow_from: [JANE] } }), { source: "console" });
    await service.setEnabled(project, "help", true, { source: "console" });
    const { auth } = host(() => ({ status: 404 }));
    const replies: string[] = [];
    const seen: string[] = [];
    const connections: InboundConnections = {
      find: () => ({ provider: "imessage", secret: "x" }),
      reply: async (_id, _to, text) => { replies.push(text); },
    };
    const chat = new AgentChatController({
      service,
      backend: scriptedBackend((messages) => {
        seen.push(messages.at(-1)!.text);
        return "secret order status";
      }),
    });
    const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project, consumerAuthorization: auth });
    const response = await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m1", threadId: JANE, text: "where is my order?", from: JANE, replyTo: JANE,
    });
    expect(response).toEqual({ status: 200, body: { unmatched: true } });
    expect(replies).toEqual([REPLY]);
    expect(seen).toEqual([]);
    expect((await service.listSessions(project, "help", { limit: 10 })).sessions).toEqual([]);
  });
});

function consumerService(fixture: AgentsFixture, auth: ConsumerAuthorization): AgentService {
  return new AgentService({
    store: fixture.store,
    now: () => fixture.clock.now,
    getConsumerPublication: () => ({ identityEnabled: true, hasChannelConnection: (agentId, connectionId) => auth.hasChannelConnection(agentId, connectionId) }),
  });
}

async function consumerHelpRouter(fixture: AgentsFixture, auth: ConsumerAuthorization, backend: ReturnType<typeof scriptedBackend>, allowFrom: string[] = [JANE]) {
  const service = consumerService(fixture, auth);
  const { project } = fixture;
  await service.create(project, agentInput("help", {
    channel: { access: "authenticated", connection_id: "sms", allow_from: allowFrom },
    tools: { mcp: { orders: ["status"] } },
  }), { source: "console" });
  await service.setEnabled(project, "help", true, { source: "console" });
  const replies: string[] = [];
  const connections: InboundConnections = {
    find: () => ({ provider: "imessage", secret: "x" }),
    reply: async (_id, _to, text) => { replies.push(text); },
  };
  const chat = new AgentChatController({ service, backend, consumerAuthorization: auth });
  const router = new AgentInboundRouter({ service, chat, connections, projectRoot: project, consumerAuthorization: auth });
  return { service, project, router, replies };
}

describe("protected channel consumer turns", () => {
  it("refuses another customer's order and allows their own", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store, auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    const backend = scriptedBackend(async (messages, ctx) => {
      const orderId = messages.at(-1)!.text.includes("other") ? "ord_other" : "ord_jane";
      const result = await ctx.tool("orders.status", { orderId });
      return result.output;
    });
    const { router, replies } = await consumerHelpRouter(fixture, auth, backend);
    await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m-own", threadId: JANE, text: "my order", from: JANE, replyTo: JANE,
    });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    expect(replies[0]).toContain("private-ord_jane");
    expect(replies[0]).not.toContain("identity.not_available");

    replies.length = 0;
    await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m-other", threadId: JANE, text: "other order", from: JANE, replyTo: JANE,
    });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    expect(replies[0]).not.toContain("ord_other");
    expect(replies[0]).not.toMatch(/private|shipped|SECRET/i);
    const audit = store.listAudit(30);
    expect(audit.some((event) => event.outcome === "deny")).toBe(true);
  });

  it("stores step-up reply on the assistant message when disclosure recheck requires sign-in", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store, auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    auth.resolveStepUpSlug = () => "helpslug";
    const backend = scriptedBackend(async (messages, ctx) => {
      const result = await ctx.tool("orders.status", { orderId: "ord_jane" });
      return result.output;
    });
    const { router, replies, service, project } = await consumerHelpRouter(fixture, auth, backend);
    await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m-one", threadId: JANE, text: "status", from: JANE, replyTo: JANE,
    });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    const sessions = (await service.listSessions(project, "help", { limit: 1 })).sessions;
    expect(sessions).toHaveLength(1);
    setRequiredAssuranceForTests("orders.status", "signed_in");
    await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m-two", threadId: JANE, text: "again", from: JANE, replyTo: JANE,
    });
    await vi.waitFor(async () => {
      const detail = await service.getSession(project, sessions[0]!.id);
      expect(detail.turns).toHaveLength(2);
    });
    const detail = await service.getSession(project, sessions[0]!.id);
    const turn = detail.turns.at(-1)!;
    expect(turn).toMatchObject({ status: "failed", errorCode: "identity.step_up_required" });
    const assistant = [...detail.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turn.id);
    expect(assistant?.text).toContain("https://chat.test/api/public/chat/helpslug/step-up?token=");
    expect(backend.calls).toBe(1);
  });

  it("sends nothing when permission is revoked before delivery", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { store, auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    let revoke = () => {};
    const backend = scriptedBackend(async (messages, ctx) => {
      const result = await ctx.tool("orders.status", { orderId: "ord_jane" });
      revoke();
      return `leak: ${result.output}`;
    });
    const { router, replies } = await consumerHelpRouter(fixture, auth, backend);
    revoke = () => {
      const person = store.listAssignments().find((row) => row.subject === JANE);
      if (person) store.revoke("principal", person.id);
    };
    await router.deliver({
      provider: "imessage", connectionId: "sms", eventId: "m-revoke", threadId: JANE, text: "status?", from: JANE, replyTo: JANE,
    });
    await vi.waitFor(() => expect(replies.length).toBe(0), { timeout: 3_000 }).catch(() => undefined);
    expect(replies).toEqual([]);
  });

  it("may be open to every customer, answering each one only with their own data", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const BOB = "+14155550999";
    const { auth } = host((sender) => sender === JANE ? { status: 200, body: { accountId: "cus_881" } } : { status: 404 });
    const backend = scriptedBackend(async (_messages, ctx) => (await ctx.tool("orders.status", { orderId: "ord_jane" })).output);
    const { router, replies, service, project } = await consumerHelpRouter(fixture, auth, backend, ["*"]);
    expect((await service.get(project, "help")).agent.issues).toEqual([]);
    await router.deliver({ provider: "imessage", connectionId: "sms", eventId: "m-jane", threadId: JANE, text: "my order", from: JANE, replyTo: JANE });
    await vi.waitFor(() => expect(replies.length).toBe(1));
    expect(replies[0]).toContain("private-ord_jane");
    const stranger = await router.deliver({ provider: "imessage", connectionId: "sms", eventId: "m-bob", threadId: BOB, text: "show me order ord_jane", from: BOB, replyTo: BOB });
    expect(stranger).toEqual({ status: 200, body: { unmatched: true } });
    expect(replies).toEqual([replies[0], REPLY]);
    expect(backend.calls).toBe(1);
  });

  it("still refuses an allow-list channel open to anyone with tools", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    const service = consumerService(fixture, auth);
    await service.create(fixture.project, agentInput("help", { channel: { connection_id: "sms", allow_from: ["*"] }, tools: { mcp: { orders: ["status"] } } }), { source: "console" });
    await expect(service.setEnabled(fixture.project, "help", true, { source: "console" })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "agent.channel_open_with_tools" })],
    });
  });

  it("cannot enable an authenticated channel agent with a generic MCP tool", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { auth } = host(() => ({ status: 200, body: { accountId: "cus_881" } }));
    const service = consumerService(fixture, auth);
    await service.create(fixture.project, agentInput("help", {
      channel: { access: "authenticated", connection_id: "sms", allow_from: [JANE] },
      tools: { mcp: { orders: ["status"], other: ["browse"] } },
    }), { source: "console" });
    await expect(service.setEnabled(fixture.project, "help", true, { source: "console" })).rejects.toMatchObject({
      code: "agent.invalid",
      issues: [expect.objectContaining({ path: "channel.access", code: "identity.setup_required" })],
    });
  });
});

describe("resolve-sender", () => {
  it("posts the workspace, channel and sender and fails closed on anything but an account id", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), body: String(init?.body) });
      const sender = JSON.parse(String(init?.body)).sender as string;
      if (sender === "missing") return new Response(JSON.stringify({ error: "no" }), { status: 404 });
      if (sender === "extra") return new Response(JSON.stringify({ accountId: "cus_881", name: "Jane" }), { status: 200 });
      return new Response(JSON.stringify({ accountId: "cus_881" }), { status: 200 });
    });
    const adapter = createOrderApiAdapter({
      endpoint: "https://orders.example", audience: "orders", credential: async () => "downstream-key",
      signContext: async () => "signed", fetch: fetch as typeof globalThis.fetch, allowLoopback: false,
    });
    expect(await adapter.resolveSender!("acme", "imessage", JANE, AbortSignal.timeout(3_000))).toEqual({ status: "found", accountId: "cus_881" });
    expect(seen[0]).toEqual({ url: "https://orders.example/stageflow/resolve-sender", body: JSON.stringify({ workspaceId: "acme", channel: "imessage", sender: JANE }) });
    expect(await adapter.resolveSender!("acme", "imessage", "missing", AbortSignal.timeout(3_000))).toEqual({ status: "not_found" });
    expect(await adapter.resolveSender!("acme", "imessage", "extra", AbortSignal.timeout(3_000))).toEqual({ status: "failed" });
  });
});
