import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { prepareOidcConnection } from "../src/identity/oidc.js";
import { ConsumerAccessError } from "../src/identity/types.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { startLocalOidcProvider, startRequestSink } from "./helpers/localOidcProvider.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { subject?: string; jwksUri?: string; corruptSignature?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-oidc-"));
  const identities = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), "business-a");
  const provider = await startLocalOidcProvider(options);
  let reads = 0;
  const records = new Map([
    ["alice-order", { id: "alice-order", workspaceId: "business-a", ownerAccountId: "alice", assignedAccountIds: [], version: "v1" }],
    ["bob-order", { id: "bob-order", workspaceId: "business-a", ownerAccountId: "bob", assignedAccountIds: [], version: "v1" }],
  ]);
  const auth = new ConsumerAuthorization(identities, createScopeAuthorizationEngine(), {
    ownership: async (_workspace, id) => {
      const record = records.get(id);
      if (!record) throw new Error("not found");
      return record;
    },
    read: async (_authority, resource) => {
      reads += 1;
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1", true);
  const backend = scriptedBackend(async (messages, ctx) => {
    const text = messages.at(-1)!.text;
    const result = await ctx.tool("orders.status", { orderId: text });
    return result.output;
  });
  bindStageflowHomeForTests(home);
  const runtimeStore = createRunStore({ rootDir: home });
  const host = await startUiServer({ agent: scriptedFakeAgent([]), cwd: home, rootDir: home, store: runtimeStore, port: 0,
    uiDistDir: path.join(home, "missing"), controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: "d".repeat(32) }),
    agentConversationBackend: backend, consumerAuthorization: auth });
  cleanups.push(async () => { await closeServer(host.server); await runtimeStore.close(); identities.close(); await provider.close(); await rm(home, { recursive: true, force: true }); });
  const address = host.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, endpoint: string, body?: unknown) => {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${"d".repeat(32)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as { definition?: { web_chat: { slug: string } } } };
  };
  const made = await admin("POST", "/api/agents", { definition: { id: "support", name: "Support", instructions: "Help with order status.", enabled: true,
    tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 120 } } });
  expect(made.response.status).toBe(201);
  await admin("POST", "/api/agents/support/enable");
  const slug = made.body.definition!.web_chat.slug;
  const redirectUri = `${base}/api/public/chat/${slug}/oidc/callback`;
  identities.registerOidc({ id: "directory", issuer: provider.issuer, clientId: provider.clientId, agentId: "support", redirectUri, algorithms: ["ES256"] }, provider.clientSecret, true);
  identities.assign("directory", "alice", "alice", "business-directory:v1", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  const pub = (suffix: string, init: RequestInit = {}) => fetch(`${base}/api/public/chat/${slug}${suffix}`, init);
  return { identities, provider, pub, redirectUri, reads: () => reads };
}

async function login(host: Awaited<ReturnType<typeof fixture>>, cookie?: string) {
  const started = await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) });
  const startBody = await started.json() as { authorizationUrl?: string };
  const stateCookie = started.headers.get("set-cookie")?.split(";")[0];
  const authorized = await fetch(startBody.authorizationUrl!, { redirect: "manual" });
  const completed = await fetch(authorized.headers.get("location")!, { headers: { Cookie: cookie ?? stateCookie ?? "" } });
  return { started, startBody, stateCookie, authorized, completed, body: await completed.json() as { token?: string; expiresIn?: number } };
}

describe("OIDC admission through public chat", () => {
  it("rejects issuers that would make discovery a private-network fetch", () => {
    const store = new ConsumerIdentityStore(":memory:", "business-a");
    cleanups.push(async () => store.close());
    const secret = "c".repeat(16);
    const redirectUri = "https://chat.example/api/public/chat/slug/oidc/callback";
    for (const issuer of ["http://169.254.169.254", "https://169.254.169.254", "https://metadata.google.internal", "http://example.com", "https://example.com/path"]) {
      expect(() => store.registerOidc({ id: "directory", issuer, clientId: "orders-app", agentId: "support", redirectUri, algorithms: ["ES256"] }, secret)).toThrow(ConsumerAccessError);
    }
    expect(() => store.registerOidc({ id: "public-idp", issuer: "https://feedback.example.com", clientId: "orders-app", agentId: "support", redirectUri, algorithms: ["ES256"] }, secret)).not.toThrow();
  });

  it("keeps the client secret out of connection reads and signs in only after validation", async () => {
    const host = await fixture();
    expect(JSON.stringify(host.identities.oidcSetup("directory"))).not.toContain(host.provider.clientSecret);
    expect(() => host.identities.connection("directory")).toThrow("identity.verification_required");
    expect((await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) })).status).toBe(503);
    await prepareOidcConnection(host.identities, "directory", true);
    expect(() => host.identities.activateOidc("directory")).not.toThrow();
    const session = await login(host);
    expect(session.started.status).toBe(200);
    expect(session.startBody.authorizationUrl).not.toContain(host.provider.clientSecret);
    expect(session.authorized.status).toBe(302);
    expect(session.completed.status).toBe(201);
    expect(session.body.token).not.toContain(".");
    expect(JSON.stringify(session.body)).not.toContain("idp-access-token-should-not-leak");
    expect(session.body.expiresIn).toBeGreaterThan(3500);
    const opened = await host.pub("/threads", { method: "POST", headers: { Authorization: `Bearer ${session.body.token}`, "Content-Type": "application/json" }, body: "{}" });
    const conversation = ((await opened.json()) as { thread: { id: string } }).thread.id;
    const allowed = await host.pub(`/threads/${conversation}/messages`, { method: "POST", headers: { Authorization: `Bearer ${session.body.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "alice-order" }) });
    expect(await allowed.text()).toContain("private-alice-order");
    const denied = await host.pub(`/threads/${conversation}/messages`, { method: "POST", headers: { Authorization: `Bearer ${session.body.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "bob-order" }) });
    const deniedText = await denied.text();
    expect(deniedText).toContain("identity.not_available");
    expect(deniedText).not.toContain("private-bob-order");
    expect(host.reads()).toBe(1);
  });

  it("consumes login state once and ignores a callback without the browser cookie", async () => {
    const host = await fixture();
    await prepareOidcConnection(host.identities, "directory", true);
    host.identities.activateOidc("directory");
    const first = await login(host);
    expect(first.completed.status).toBe(201);
    const replay = await fetch(first.authorized.headers.get("location")!, { headers: { Cookie: first.stateCookie! } });
    expect(replay.status).toBe(401);
    const second = await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) });
    const authorizationUrl = ((await second.json()) as { authorizationUrl: string }).authorizationUrl;
    const authorized = await fetch(authorizationUrl, { redirect: "manual" });
    expect((await fetch(authorized.headers.get("location")!)).status).toBe(401);
    const recovered = await fetch(authorized.headers.get("location")!, { headers: { Cookie: second.headers.get("set-cookie")!.split(";")[0]! } });
    expect(recovered.status).toBe(201);
    expect(host.reads()).toBe(0);
  });

  it("rejects a token signed by a key that is not in the provider JWKS", async () => {
    const host = await fixture({ corruptSignature: true });
    await prepareOidcConnection(host.identities, "directory", true);
    host.identities.activateOidc("directory");
    expect((await login(host)).completed.status).toBe(401);
    expect(host.reads()).toBe(0);
  });

  it("rejects an unmapped provider subject before any order read", async () => {
    const host = await fixture({ subject: "stranger" });
    await prepareOidcConnection(host.identities, "directory", true);
    host.identities.activateOidc("directory");
    expect((await login(host)).completed.status).toBe(401);
    expect(host.reads()).toBe(0);
  });

  it("does not fetch a key set outside the issuer origin", async () => {
    const sink = await startRequestSink();
    cleanups.push(() => sink.close());
    const host = await fixture({ jwksUri: sink.url });
    await expect(prepareOidcConnection(host.identities, "directory", true)).rejects.toThrow("identity.setup_required");
    expect(sink.hits()).toBe(0);
    expect(host.identities.oidcSetup("directory").status).toBe("draft");
  });

  it("rejects a sign-in start from a foreign origin", async () => {
    const host = await fixture();
    await prepareOidcConnection(host.identities, "directory", true);
    host.identities.activateOidc("directory");
    expect((await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ connectionId: "directory" }) })).status).toBe(403);
  });
});
