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
import { ConsumerStepUpRequired } from "../src/identity/stepUp.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { startHostedOidcProvider, HOSTED_TEST_IDP_NAME } from "./helpers/hostedOidcProvider.js";
import type { LocalOidcProvider } from "./helpers/localOidcProvider.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { provider?: LocalOidcProvider; workspace?: string; subject?: string; deny?: boolean } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-hosted-oidc-"));
  const workspace = options.workspace ?? "business-a";
  const identities = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), workspace);
  const provider = options.provider ?? await startHostedOidcProvider({ subject: options.subject, deny: options.deny });
  const ownsProvider = options.provider === undefined;
  let reads = 0;
  const auth = new ConsumerAuthorization(identities, createScopeAuthorizationEngine(), {
    ownership: async (_workspace, id) => {
      if (id === "alice-order") return { id, workspaceId: workspace, ownerAccountId: "alice", assignedAccountIds: [], version: "v1" };
      if (id === "bob-order") return { id, workspaceId: workspace, ownerAccountId: "bob", assignedAccountIds: [], version: "v1" };
      throw new Error("not found");
    },
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
  cleanups.push(async () => {
    await closeServer(host.server);
    await runtimeStore.close();
    identities.close();
    if (ownsProvider) await provider.close();
    await rm(home, { recursive: true, force: true });
  });
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
  if (!options.deny) {
    await prepareOidcConnection(identities, "directory", true);
    expect(identities.oidcTested("directory")).toBe(false);
    identities.activateOidc("directory");
  }
  const pub = (suffix: string, init: RequestInit = {}) => fetch(`${base}/api/public/chat/${slug}${suffix}`, init);
  return { identities, auth, provider, pub, base, slug, redirectUri, reads: () => reads };
}

async function login(host: Awaited<ReturnType<typeof fixture>>, cookie?: string) {
  const started = await host.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) });
  const startBody = await started.json() as { authorizationUrl?: string };
  const stateCookie = started.headers.get("set-cookie")?.split(";")[0];
  const authorized = await fetch(startBody.authorizationUrl!, { redirect: "manual" });
  const completed = await fetch(authorized.headers.get("location")!, { headers: { Cookie: cookie ?? stateCookie ?? "" }, redirect: "manual" });
  const text = await completed.text();
  return { started, startBody, stateCookie, authorized, completed, text, body: text.startsWith("{") ? JSON.parse(text) as { token?: string } : {} };
}

describe("hosted test identity provider", () => {
  it("signs in on a separate loopback origin and records issuer, audience, signature, nonce, and pkce", async () => {
    const host = await fixture();
    expect(new URL(host.provider.issuer).origin).not.toBe(new URL(host.base).origin);
    expect(host.provider.name).toBe(HOSTED_TEST_IDP_NAME);
    const session = await login(host);
    expect(session.completed.status).toBe(201);
    const audits = host.identities.listAudit(20);
    const checks = host.provider.checks();
    expect({
      provider: host.provider.name,
      reason: audits.find((row) => row.reason === "oidc_verified")?.reason,
      issuer: checks?.issuer,
      audience: checks?.audience,
      signature: checks?.signature,
      nonce: checks?.nonce,
      pkce: checks?.pkce,
    }).toEqual({
      provider: "stageflow-hosted-test-idp",
      reason: "oidc_verified",
      issuer: host.provider.issuer,
      audience: host.provider.clientId,
      signature: "ES256",
      nonce: true,
      pkce: "S256",
    });
    expect(audits.every((row) => row.reason !== "oidc_verified" || row.reason === "oidc_verified")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(session.body.token);
    expect(JSON.stringify(audits)).not.toContain("access_token");
    expect(audits.some((row) => row.reason.includes("."))).toBe(false);
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

  it("does not create a session for a cancelled, replayed, or cross-workspace callback", async () => {
    const cancelled = await fixture({ deny: true });
    await prepareOidcConnection(cancelled.identities, "directory", true);
    cancelled.identities.activateOidc("directory");
    const denied = await login(cancelled);
    expect(denied.authorized.status).toBe(302);
    expect(denied.authorized.headers.get("location")).toContain("error=access_denied");
    expect(denied.completed.status).not.toBe(201);
    expect(denied.body.token).toBeUndefined();
    expect(cancelled.identities.listAudit(20).some((row) => row.reason === "oidc_verified")).toBe(false);
    expect(cancelled.reads()).toBe(0);

    const host = await fixture();
    const first = await login(host);
    expect(first.completed.status).toBe(201);
    const replay = await fetch(first.authorized.headers.get("location")!, { headers: { Cookie: first.stateCookie! }, redirect: "manual" });
    expect(replay.status).not.toBe(201);
    expect(host.identities.listAudit(20).filter((row) => row.reason === "oidc_verified")).toHaveLength(1);

    const provider = await startHostedOidcProvider();
    cleanups.push(() => provider.close());
    const left = await fixture({ provider, workspace: "business-a" });
    const right = await fixture({ provider, workspace: "business-b" });
    const started = await left.pub("/oidc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: "directory" }) });
    const authorizationUrl = ((await started.json()) as { authorizationUrl: string }).authorizationUrl;
    const authorized = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = new URL(authorized.headers.get("location")!);
    const presented = new URL(`${right.base}/api/public/chat/${right.slug}/oidc/callback`);
    presented.search = callback.search;
    const foreign = await fetch(presented, { headers: { Cookie: started.headers.get("set-cookie")!.split(";")[0]! }, redirect: "manual" });
    expect(foreign.status).not.toBe(201);
    expect(left.identities.listAudit(20).some((row) => row.reason === "oidc_verified")).toBe(false);
    expect(right.identities.listAudit(20).some((row) => row.reason === "oidc_verified")).toBe(false);
    expect(left.reads()).toBe(0);
    expect(right.reads()).toBe(0);
  });

  it("turns an email step-up link into a sign-in that raises the conversation, with pages instead of JSON", async () => {
    const saved = process.env.STAGEFLOW_PUBLIC_CHAT_URL;
    cleanups.push(async () => {
      if (saved === undefined) delete process.env.STAGEFLOW_PUBLIC_CHAT_URL;
      else process.env.STAGEFLOW_PUBLIC_CHAT_URL = saved;
    });
    const stepUpFor = async (host: Awaited<ReturnType<typeof fixture>>, account: string) => {
      process.env.STAGEFLOW_PUBLIC_CHAT_URL = host.base;
      host.identities.registerChannel({ id: "mail", channelConnectionId: "inbox", agentId: "support", provider: "agentmail", unmappedReply: "no match",
        permission: { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] } });
      host.identities.assign("mail", "jane@acme.com", account, "import", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
      const admitted = await host.auth.admitChannelSender({ agentId: "support", channelConnectionId: "inbox", provider: "agentmail", sender: "jane@acme.com", dmarcPass: true, signal: AbortSignal.timeout(3_000) });
      if (admitted.outcome !== "admitted") throw new Error("not admitted");
      host.auth.bind("mail-conv", admitted.sessionId, "support", 1);
      const failure = await host.auth.check("mail-conv", admitted.sessionId, "support", "orders.status", { orderId: "alice-order" }, AbortSignal.timeout(3_000)).catch((error) => error);
      expect(failure).toBeInstanceOf(ConsumerStepUpRequired);
      const link = /https?:\/\/\S+/.exec((failure as ConsumerStepUpRequired).reply)![0];
      expect(link).toContain(`/api/public/chat/${host.slug}/step-up?token=`);
      return { sessionId: admitted.sessionId, link };
    };
    const follow = async (link: string) => {
      const opened = await fetch(link, { redirect: "manual" });
      expect(opened.status).toBe(302);
      const cookies = opened.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
      expect(cookies).toContain("sf_step_up=");
      expect(cookies).toContain("sf_oidc=");
      const authorized = await fetch(opened.headers.get("location")!, { redirect: "manual" });
      const completed = await fetch(authorized.headers.get("location")!, { headers: { Cookie: cookies }, redirect: "manual" });
      return { completed, html: await completed.text() };
    };

    const host = await fixture();
    const { sessionId, link } = await stepUpFor(host, "alice");
    expect(host.identities.sessionAssurance(sessionId)).toBe("address_only");
    const done = await follow(link);
    expect(done.completed.status).toBe(200);
    expect(done.completed.headers.get("content-type")).toContain("text/html");
    expect(done.html).toContain("You're signed in");
    expect(done.html).not.toContain("token");
    expect(host.identities.sessionAssurance(sessionId)).toBe("signed_in");
    await host.auth.check("mail-conv", sessionId, "support", "orders.status", { orderId: "alice-order" }, AbortSignal.timeout(3_000));

    const reused = await fetch(link, { redirect: "manual" });
    expect(reused.status).toBe(401);
    expect(reused.headers.get("content-type")).toContain("text/html");
    expect(await reused.text()).toContain("This link has expired");
    const forged = await host.pub("/step-up?token=" + "x".repeat(43), { redirect: "manual" });
    expect(forged.status).toBe(401);

    const other = await fixture({ subject: "bob" });
    other.identities.assign("directory", "bob", "bob", "business-directory:v1", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
    const mismatch = await stepUpFor(other, "alice");
    const wrong = await follow(mismatch.link);
    expect(wrong.completed.status).toBe(403);
    expect(wrong.html).toContain("different account");
    expect(other.identities.sessionAssurance(mismatch.sessionId)).toBe("address_only");
  });
});
