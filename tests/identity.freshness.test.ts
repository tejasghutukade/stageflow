import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { ConsumerIdentityStore, DEFAULT_OIDC_FRESHNESS_MS } from "../src/identity/store.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine, scopeAllows } from "../src/identity/scope.js";
import type { AuthorizationEngine } from "../src/identity/types.js";
import { prepareOidcConnection } from "../src/identity/oidc.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { startLocalOidcProvider } from "./helpers/localOidcProvider.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const LOCAL_NOTE = "Local revoke is immediate. Upstream removal is not detected.";
const CONNECTED_NOTE = "Upstream removal blocks the next protected action.";

async function fixture(options: { issueRefresh?: boolean; freshnessMs?: number; agents?: string[] } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-identity-fresh-"));
  const clock = { now: Date.now() };
  const identities = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), "business-a", () => clock.now);
  const provider = await startLocalOidcProvider({ issueRefresh: options.issueRefresh, trackAccess: true });
  let reads = 0;
  const auth = new ConsumerAuthorization(identities, createScopeAuthorizationEngine(), {
    ownership: async () => ({ id: "alice-order", workspaceId: "business-a", ownerAccountId: "alice", assignedAccountIds: [], version: "v1" }),
    read: async (_authority, resource) => {
      reads += 1;
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1", true);
  const backend = scriptedBackend(async (messages, ctx) => (await ctx.tool("orders.status", { orderId: messages.at(-1)!.text })).output);
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
  identities.registerOidc({ id: "directory", issuer: provider.issuer, clientId: provider.clientId, agentId: "support", redirectUri, algorithms: ["ES256"],
    ...(options.freshnessMs ? { freshnessMs: options.freshnessMs } : {}) }, provider.clientSecret, true);
  identities.assign("directory", "alice", "alice", "business-directory:v1", { scope: "own", agents: options.agents ?? ["support"], actions: ["conversation:use", "order:read"] });
  await prepareOidcConnection(identities, "directory", true);
  identities.activateOidc("directory");
  const pub = (suffix: string, init: RequestInit = {}) => fetch(`${base}/api/public/chat/${slug}${suffix}`, init);
  return { identities, auth, provider, pub, clock, reads: () => reads, slug };
}

async function login(host: Awaited<ReturnType<typeof fixture>>) {
  const started = await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) });
  const authorizationUrl = ((await started.json()) as { authorizationUrl: string }).authorizationUrl;
  const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const authorized = await fetch(authorizationUrl, { redirect: "manual" });
  const completed = await fetch(authorized.headers.get("location")!, { headers: { Cookie: cookie } });
  const body = await completed.json() as { token: string };
  expect(completed.status).toBe(201);
  const authority = host.identities.authenticate(body.token, "support");
  return { token: body.token, authority, evidenceAt: host.identities.evidenceAt(authority.sessionId) };
}

async function readOrder(host: Awaited<ReturnType<typeof fixture>>, token: string) {
  const opened = await host.pub("/threads", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
  const conversation = ((await opened.json()) as { thread: { id: string } }).thread.id;
  const response = await host.pub(`/threads/${conversation}/messages`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "alice-order" }) });
  return response.text();
}

describe("OIDC evidence freshness and upstream revocation", () => {
  it("denies a protected read after the freshness window even while the provider access token is unexpired", async () => {
    const host = await fixture();
    expect(DEFAULT_OIDC_FRESHNESS_MS).toBe(300_000);
    const session = await login(host);
    expect(() => host.identities.authenticate(host.provider.accessToken()!, "support")).toThrow("identity.verification_required");
    host.clock.now += DEFAULT_OIDC_FRESHNESS_MS;
    expect((await readOrder(host, session.token))).toContain("private-alice-order");
    host.clock.now += 1;
    const denied = await readOrder(host, session.token);
    expect(denied).toContain("identity.not_available");
    expect(denied).not.toContain("private-alice-order");
    expect(host.identities.listAudit(20).some((row) => row.reason === "evidence_stale" && row.outcome === "deny")).toBe(true);
    expect(host.identities.evidenceAt(session.authority.sessionId)).toBe(session.evidenceAt);
    expect(host.provider.refreshCalls()).toBe(0);
    expect(host.reads()).toBe(1);
  });

  it("refreshes stale evidence once without widening the grant, and denies when refresh fails", async () => {
    const host = await fixture({ issueRefresh: true, freshnessMs: 1_000 });
    const session = await login(host);
    host.clock.now += 1_001;
    const allowed = await readOrder(host, session.token);
    expect(allowed).toContain("private-alice-order");
    expect(host.provider.refreshCalls()).toBe(1);
    const after = host.identities.authenticate(session.token, "support");
    expect(after.grantId).toBe(session.authority.grantId);
    expect(after.actions).toEqual(session.authority.actions);
    expect(after.resources).toEqual(session.authority.resources);
    expect(after.expiresAt).toBe(session.authority.expiresAt);
    expect(after.principal.revision).toBe(session.authority.principal.revision);
    expect(host.identities.evidenceAt(after.sessionId)).toBe(host.clock.now);
    const reads = host.reads();
    host.provider.setRefreshMode("deny");
    host.clock.now += 1_001;
    const denied = await readOrder(host, session.token);
    expect(denied).toContain("identity.not_available");
    expect(denied).not.toContain("private");
    expect(host.provider.refreshCalls()).toBe(2);
    expect(host.reads()).toBe(reads);
    expect(host.identities.listAudit(20).some((row) => row.reason === "evidence_stale")).toBe(true);
  });

  it("refreshes a narrowed child from the parent token and leaves that token on the parent", async () => {
    const host = await fixture({ issueRefresh: true, freshnessMs: 1_000, agents: ["support", "helper"] });
    const session = await login(host);
    const child = host.identities.narrowAuthority(session.authority, "helper", {});
    expect(host.identities.refreshSecret(child.sessionId)).toBeNull();
    expect(host.identities.sessionProtection(child.sessionId).hasRefresh).toBe(true);
    host.clock.now += 1_001;
    host.identities.bind("child-conversation", child.sessionId, "helper", 1);
    await host.auth.check("child-conversation", child.sessionId, "helper", "orders.status", { orderId: "alice-order" }, AbortSignal.timeout(3_000));
    expect(host.provider.refreshCalls()).toBe(1);
    expect(host.identities.evidenceAt(child.sessionId)).toBe(host.clock.now);
    expect(host.identities.evidenceAt(session.authority.sessionId)).toBe(host.clock.now);
    expect(host.identities.refreshSecret(child.sessionId)).toBeNull();
    expect(host.identities.refreshSecret(session.authority.sessionId)).toEqual(expect.any(String));
  });

  it("reports local-only revocation until a same-origin source is configured, then fails closed", async () => {
    const host = await fixture({ issueRefresh: true });
    const listed = host.identities.listConnections().find((row) => row.id === "directory");
    expect(listed).toMatchObject({ kind: "oidc", upstreamRevocation: "local_only", upstreamNote: LOCAL_NOTE, issuerChecks: [
      "HTTPS issuer",
      "Discovery, keys, and token URLs stay on the issuer origin",
      "ID token signature is verified",
      "Subject claim must be sub",
      "Callback must be this Host's /api/public/chat/:slug/oidc/callback",
    ] });
    expect(JSON.stringify(host.identities.listConnections())).not.toContain(host.provider.clientSecret);
    host.identities.setRevocationSource("directory", `${host.provider.issuer}/active`);
    expect(host.identities.listConnections().find((row) => row.id === "directory")).toMatchObject({
      upstreamRevocation: "connected", upstreamNote: CONNECTED_NOTE,
    });
    const seen: string[] = [];
    host.provider.setRevocation((subject) => { seen.push(subject); return { status: 200, body: { active: true } }; });
    const session = await login(host);
    expect(await readOrder(host, session.token)).toContain("private-alice-order");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((subject) => subject === "alice")).toBe(true);
    host.provider.setRevocation(() => ({ status: 500, body: { detail: "SECRET-UPSTREAM" } }));
    const broken = await readOrder(host, session.token);
    expect(broken).toContain("identity.not_available");
    expect(broken).not.toContain("SECRET-UPSTREAM");
    expect(host.identities.listAudit(20).some((row) => row.reason.includes("SECRET"))).toBe(false);
    host.provider.setRevocation(() => ({ status: 200, body: { active: false, note: "SECRET-UPSTREAM" } }));
    const reads = host.reads();
    const revoked = await readOrder(host, session.token);
    expect(revoked).toContain("identity.not_available");
    expect(revoked).not.toContain("SECRET-UPSTREAM");
    expect(revoked).not.toContain("private");
    expect(host.reads()).toBe(reads);
  });
});

describe("consumer identity operator store", () => {
  it("previews scope, conflicts on a stale revision, and keeps secrets out of lists", async () => {
    const store = new ConsumerIdentityStore(":memory:", "business-a");
    cleanups.push(async () => store.close());
    const order = { id: "alice-order", workspaceId: "business-a", ownerAccountId: "alice", assignedAccountIds: ["sam"], version: "v1" };
    const allow = (accountId: string, scope: "own" | "assigned" | "selected" | "workspace", resources: string[] | null, sample = order) =>
      scopeAllows({ workspaceId: "business-a", accountId, scope, resources, order: sample });
    expect(allow("alice", "own", null)).toBe(true);
    expect(allow("sam", "assigned", null)).toBe(true);
    expect(allow("alice", "assigned", null)).toBe(false);
    expect(allow("other", "assigned", null)).toBe(false);
    expect(allow("alice", "selected", ["alice-order"])).toBe(true);
    expect(allow("alice", "selected", null)).toBe(false);
    expect(allow("stranger", "workspace", null)).toBe(true);
    expect(allow("alice", "workspace", null, { ...order, workspaceId: "other" })).toBe(false);
    const { publicKey } = await generateKeyPair("ES256");
    store.registerHandoff({ id: "app", issuer: "https://business.example", agentId: "support", audience: "stageflow:business-a:support",
      publicJwks: { keys: [{ ...await exportJWK(publicKey), kid: "app-key" }] }, algorithms: ["ES256"] });
    const permission = { scope: "own" as const, agents: ["support"], actions: ["conversation:use", "order:read"] };
    const created = store.assign("app", "alice", "alice", "directory:v1", permission, 0);
    expect(() => store.assign("app", "alice", "alice", "directory:v2", permission, 0)).toThrow("identity.conflict");
    expect(store.listAssignments().find((row) => row.id === created)?.revision).toBe(1);
    expect(store.assign("app", "alice", "moved", "directory:v2", permission, 1)).toBe(created);
    expect(() => store.assign("app", "carol", "carol", "directory:v1", permission, 4)).toThrow("identity.conflict");
    expect(store.listAssignments().some((row) => row.subject === "carol")).toBe(false);
    expect(store.listAssignments()).toEqual([expect.objectContaining({ id: created, accountId: "moved", revision: 2, resources: null })]);
    for (let index = 0; index < 205; index += 1) store.audit(null, null, "deny", "order_not_available");
    expect(store.listAudit(500)).toHaveLength(200);
    expect(JSON.stringify(store.listAudit(5))).not.toContain("refresh_secret");
    const provider = await startLocalOidcProvider();
    cleanups.push(() => provider.close());
    store.registerOidc({ id: "directory", issuer: provider.issuer, clientId: provider.clientId, agentId: "support",
      redirectUri: "http://127.0.0.1:9/api/public/chat/slug/oidc/callback", algorithms: ["ES256"] }, provider.clientSecret, true);
    await prepareOidcConnection(store, "directory", true);
    expect(store.oidcTested("directory")).toBe(false);
    expect(() => store.activateOidc("directory")).not.toThrow();
    store.markOidcTested("directory");
    expect(store.oidcTested("directory")).toBe(true);
    const before = store.listAssignments().find((row) => row.id === created)!;
    store.rotateOidcSecret("directory", "r".repeat(24));
    expect(store.oidcClientSecret("directory")).toBe("r".repeat(24));
    expect(store.listAssignments().find((row) => row.id === created)).toEqual(before);
    store.disableConnection("directory");
    expect(store.listConnections().find((row) => row.id === "directory")).toMatchObject({ active: false, status: "disabled" });
    expect(store.oidcClientSecret("directory")).toBe("r".repeat(24));
    expect(store.listConnections().find((row) => row.id === "app")).toMatchObject({ kind: "handoff", upstreamRevocation: "local_only", upstreamNote: LOCAL_NOTE });
  });
});

describe("scope stays in front of the authorization engine", () => {
  it("denies an order the relation refuses when the engine allows every check", async () => {
    const store = new ConsumerIdentityStore(":memory:", "business-a");
    cleanups.push(async () => store.close());
    const { publicKey } = await generateKeyPair("ES256");
    store.registerHandoff({ id: "app", issuer: "https://business.example", agentId: "support", audience: "stageflow:business-a:support",
      publicJwks: { keys: [{ ...await exportJWK(publicKey), kid: "app-key" }] }, algorithms: ["ES256"] });
    store.assign("app", "alice", "alice", "directory:v1", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
    const token = store.establishSession("app", "support", "alice", "assert-1", Date.now() + 60_000);
    const authority = store.authenticate(token, "support");
    store.bind("conversation", authority.sessionId, "support", 1);
    const alice = { id: "alice-order", workspaceId: "business-a", ownerAccountId: "alice", assignedAccountIds: [], version: "v1" };
    const bob = { id: "bob-order", workspaceId: "business-a", ownerAccountId: "bob", assignedAccountIds: [], version: "v1" };
    let checks = 0;
    const engine: AuthorizationEngine = { check: async () => { checks += 1; return true; } };
    const auth = new ConsumerAuthorization(store, engine, {
      ownership: async (_workspace, id) => (id === alice.id ? alice : bob),
      read: async () => { throw new Error("private payload"); },
    }, "consumer_v1");
    await expect(auth.check("conversation", authority.sessionId, "support", "orders.status", { orderId: "bob-order" }, AbortSignal.timeout(3_000))).rejects.toThrow("identity.not_available");
    expect(await auth.preview("alice", "own", null, bob, AbortSignal.timeout(3_000))).toBe(false);
    expect(checks).toBe(0);
    expect(await auth.preview("alice", "own", null, alice, AbortSignal.timeout(3_000))).toBe(true);
    await auth.check("conversation", authority.sessionId, "support", "orders.status", { orderId: "alice-order" }, AbortSignal.timeout(3_000));
    expect(checks).toBe(2);
  });
});
