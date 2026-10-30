import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AgentConversation } from "../src/agents/sessions.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { PublicWebChat } from "../src/agents/webChat/publicChat.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import type { ConsumerAuthority, OwnedResource } from "../src/identity/types.js";
import { agentInput, agentsFixture, scriptedBackend } from "./helpers/agentsHarness.js";
import { closeServer } from "./helpers/closeServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const agents = await agentsFixture();
  const home = await mkdtemp(path.join(tmpdir(), "sf-identity-service-"));
  const identities = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), "business-a");
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  identities.registerHandoff({ id: "app", issuer: "https://business.example", agentId: "support", audience: "stageflow:business-a:support",
    publicJwks: { keys: [{ ...await exportJWK(publicKey), kid: "app-key" }] }, algorithms: ["ES256"] });
  identities.assign("app", "alice", "alice", "business-directory:v1", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  identities.assign("app", "bob", "bob", "business-directory:v1", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  identities.registerService("nightly", "alice", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  const records = new Map<string, OwnedResource>([
    ["alice-order", { id: "alice-order", workspaceId: "business-a", ownerAccountId: "alice", assignedAccountIds: [], version: "v1" }],
    ["bob-order", { id: "bob-order", workspaceId: "business-a", ownerAccountId: "bob", assignedAccountIds: [], version: "v1" }],
  ]);
  let reads = 0;
  const seen: ConsumerAuthority[] = [];
  const auth = new ConsumerAuthorization(identities, createScopeAuthorizationEngine(), {
    ownership: async (_workspace, id) => {
      const record = records.get(id);
      if (!record) throw new Error("not found");
      return record;
    },
    read: async (authority, resource) => {
      seen.push(authority);
      reads += 1;
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1");
  const released: string[] = [];
  const backend = scriptedBackend(async (messages, ctx) => (await ctx.tool("orders.status", { orderId: messages.at(-1)!.text })).output);
  backend.release = async (sessionId) => { released.push(sessionId); };
  await agents.service.create(agents.project, agentInput("support", { instructions: "Help with order status.",
    tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 120 } }), { source: "console" });
  await agents.service.setEnabled(agents.project, "support", true, { source: "console" });
  await agents.service.create(agents.project, agentInput("other", { instructions: "No service grant.",
    tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 30 } }), { source: "console" });
  await agents.service.setEnabled(agents.project, "other", true, { source: "console" });
  const definition = (await agents.service.get(agents.project, "support")).definition!;
  const conversation = new AgentConversation({ service: agents.service, backend, consumerAuthorization: auth });
  const chat = new PublicWebChat({ service: agents.service, chat: new AgentChatController({ service: agents.service, backend, consumerAuthorization: auth }),
    projectRoot: agents.project, consumerAuthorization: auth });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void chat.handle(req, res, req.method ?? "GET", url.pathname);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { await closeServer(server); identities.close(); await agents.cleanup(); await rm(home, { recursive: true, force: true }); });
  const assertion = (subject: string) => new SignJWT({ workspace: "business-a", agent: "support" })
    .setProtectedHeader({ alg: "ES256", kid: "app-key", typ: "stageflow-agent-handoff+jwt" })
    .setIssuer("https://business.example").setAudience("stageflow:business-a:support").setSubject(subject)
    .setIssuedAt().setExpirationTime("4m").setJti(randomUUID()).sign(privateKey);
  return { identities, auth, agents, conversation, backend, definition, base, seen: () => seen, reads: () => reads, released: () => released, assertion,
    servicePrincipal: identities.listAssignments().find((row) => row.subject === "service:nightly")!.id };
}

describe("service identity for scheduled consumer turns", () => {
  it("runs a schedule turn under the service principal and hides it from public chat", async () => {
    const host = await fixture();
    const customerToken = await host.auth.admit("app", "support", await host.assertion("bob"));
    const customer = host.identities.authenticate(customerToken, "support");
    const customerSession = await host.agents.service.openSession(host.agents.project, "support", { source: "web_consumer", sourceRef: customer.sessionId });
    host.identities.bind(customerSession.id, customer.sessionId, "support", customerSession.revision);
    const detail = await host.conversation.send({ projectRoot: host.agents.project, agentId: "support", text: "alice-order", source: "schedule" });
    expect(detail.session.source).toBe("schedule");
    expect(host.released()).toEqual([detail.session.id]);
    expect(detail.messages.at(-1)!.text).toContain("private-alice-order");
    expect(host.seen()[0]!.principal.subject).toBe("service:nightly");
    expect(host.seen()[0]!.sessionId).not.toBe(customer.sessionId);
    expect(host.reads()).toBe(1);
    const listed = await fetch(`${host.base}/api/public/chat/${host.definition.web_chat.slug}/threads`, { headers: { Authorization: `Bearer ${customerToken}` } });
    const body = await listed.json() as { threads: Array<{ id: string }> };
    expect(listed.status).toBe(200);
    expect(body.threads.map((thread) => thread.id)).toEqual([customerSession.id]);
    expect(host.agents.service.listSessionsForRef(host.agents.project, "support", "web_consumer", customer.sessionId, 20).map((session) => session.id)).toEqual([customerSession.id]);
  });

  it("rejects a service source, a service bearer, and a schedule with no active grant before any tool runs", async () => {
    const host = await fixture();
    const calls = host.backend.calls;
    await expect(host.conversation.send({ projectRoot: host.agents.project, agentId: "support", text: "alice-order", source: "service" }))
      .rejects.toThrow("identity.verification_required");
    await expect(host.conversation.send({ projectRoot: host.agents.project, agentId: "other", text: "alice-order", source: "schedule" }))
      .rejects.toThrow("identity.not_available");
    const minted = host.identities.establishSession("nightly", "support", "service:nightly", `service:${randomUUID()}`, Date.now() + 60_000);
    expect(() => host.identities.authenticate(minted, "support")).toThrow("identity.verification_required");
    const rejected = await fetch(`${host.base}/api/public/chat/${host.definition.web_chat.slug}/threads`, { headers: { Authorization: `Bearer ${minted}` } });
    expect(rejected.status).toBe(401);
    expect(host.backend.calls).toBe(calls);
    expect(host.reads()).toBe(0);
    host.identities.revoke("principal", host.servicePrincipal);
    await expect(host.conversation.send({ projectRoot: host.agents.project, agentId: "support", text: "alice-order", source: "schedule" }))
      .rejects.toThrow("identity.not_available");
    host.identities.registerService("morning", "alice", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
    const first = await host.conversation.send({ projectRoot: host.agents.project, agentId: "support", text: "alice-order", source: "schedule" });
    expect(first.messages.at(-1)!.text).toContain("private-alice-order");
    host.identities.disableConnection("morning");
    const reads = host.reads();
    const after = host.backend.calls;
    await expect(host.conversation.send({ projectRoot: host.agents.project, agentId: "support", text: "alice-order", source: "schedule" }))
      .rejects.toThrow("identity.not_available");
    expect(host.backend.calls).toBe(after);
    expect(host.reads()).toBe(reads);
    expect(first.session.source).toBe("schedule");
  });
});
