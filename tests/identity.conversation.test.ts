import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createCerbosAuthorizationEngine } from "../src/identity/cerbos.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import type { AuthorizationEngine, ConsumerScope, OwnedResource } from "../src/identity/types.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { workspace?: string; engine?: AuthorizationEngine; askFirst?: boolean;
  beforeRead?: () => void; beforeReply?: () => void } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-identity-"));
  const workspace = options.workspace ?? "business-a";
  const storePath = path.join(home, "consumers.sqlite");
  let identities = new ConsumerIdentityStore(storePath, workspace);
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  identities.registerHandoff({ id: "app", issuer: "https://business.example", agentId: "support", audience: `stageflow:${workspace}:support`,
    publicJwks: { keys: [{ ...await exportJWK(publicKey), kid: "app-key" }] }, algorithms: ["ES256"] });
  const assign = (subject: string, account = subject, scope: ConsumerScope = "own", resources?: string[]) => identities.assign("app", subject, account, "business-directory:v1", {
    scope, agents: ["support"], actions: ["conversation:use", "order:read"], ...(resources ? { resources } : {}),
  });
  const alice = assign("alice");
  assign("bob");
  assign("supporter", "supporter", "assigned");
  assign("supervisor", "supervisor", "workspace");
  assign("selected", "selected", "selected", ["alice-order"]);
  const records = new Map<string, OwnedResource>([
    ["alice-order", { id: "alice-order", workspaceId: workspace, ownerAccountId: "alice", assignedAccountIds: ["supporter"], version: "v1" }],
    ["bob-order", { id: "bob-order", workspaceId: workspace, ownerAccountId: "bob", assignedAccountIds: [], version: "v1" }],
    ["other-business", { id: "other-business", workspaceId: "other-business", ownerAccountId: "alice", assignedAccountIds: [], version: "v1" }],
  ]);
  let reads = 0;
  let metadataReads = 0;
  const defaultEngine = process.env.IDENTITY_CERBOS_SMOKE === "1"
    ? createCerbosAuthorizationEngine({ endpoint: "http://127.0.0.1:3592", allowLoopback: true }) : createScopeAuthorizationEngine();
  const createAuthorization = () => new ConsumerAuthorization(identities, options.engine ?? defaultEngine, {
    ownership: async (_workspace, id) => {
      metadataReads += 1;
      const record = records.get(id);
      if (!record) throw new Error("not found: private endpoint");
      return structuredClone(record);
    },
    read: async (_authority, resource) => {
      options.beforeRead?.();
      reads += 1;
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1");
  let auth = createAuthorization();
  const backend = scriptedBackend(async (messages, ctx) => {
    const text = messages.at(-1)!.text;
    if (text === "delegate") return ctx.hooks.delegate("child", "get private orders");
    const args = text.startsWith("{") ? JSON.parse(text) : { orderId: text };
    const result = await ctx.tool("orders.status", args);
    options.beforeReply?.();
    return result.output;
  });
  bindStageflowHomeForTests(home);
  let runtimeStore = createRunStore({ rootDir: home });
  const start = () => startUiServer({ agent: scriptedFakeAgent([]), cwd: home, rootDir: home,
    store: runtimeStore, port: 0, uiDistDir: path.join(home, "missing"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: "d".repeat(32) }),
    agentConversationBackend: backend, consumerAuthorization: auth });
  let host = await start();
  cleanups.push(async () => { await closeServer(host.server); await runtimeStore.close(); identities.close(); await rm(home, { recursive: true, force: true }); });
  const address = host.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  let base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, endpoint: string, body?: unknown) => {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${"d".repeat(32)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as any };
  };
  const made = await admin("POST", "/api/agents", { definition: { id: "support", name: "Support", instructions: "Help with order status.", enabled: true,
    tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 120 },
    ...(options.askFirst ? { approvals: { ask_first: ["orders.status"] } } : {}) } });
  expect(made.response.status).toBe(201);
  await admin("POST", "/api/agents/support/enable");
  const slug = made.body.definition.web_chat.slug as string;
  const pub = async (suffix: string, token?: string, body?: unknown, extraHeaders?: Record<string, string>) => fetch(`${base}/api/public/chat/${slug}${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "x-visitor-id": "same_browser_visitor_123", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const assertion = async (subject = "alice", overrides: Record<string, unknown> = {}) => new SignJWT({ workspace, agent: "support", ...overrides })
    .setProtectedHeader({ alg: "ES256", kid: "app-key", typ: "stageflow-agent-handoff+jwt" })
    .setIssuer("https://business.example").setAudience(`stageflow:${workspace}:support`).setSubject(subject)
    .setIssuedAt().setExpirationTime("4m").setJti(randomUUID()).sign(privateKey);
  const login = async (subject = "alice") => {
    const response = await pub("/admission", undefined, { connectionId: "app", assertion: await assertion(subject) });
    expect(response.status).toBe(201);
    return (await response.json()).token as string;
  };
  const open = async (token: string) => {
    const response = await pub("/threads", token, {});
    expect(response.status).toBe(201);
    return (await response.json()).thread.id as string;
  };
  const send = async (token: string, conversation: string, text: string) => {
    const response = await pub(`/threads/${conversation}/messages`, token, { text });
    return { status: response.status, text: await response.text() };
  };
  return { get identities() { return identities; }, alice, records, pub, assertion, login, open, send, admin, assign,
    reads: () => reads, metadataReads: () => metadataReads, backend,
    restart: async () => {
      await closeServer(host.server);
      await runtimeStore.close();
      identities.close();
      identities = new ConsumerIdentityStore(storePath, workspace);
      runtimeStore = createRunStore({ rootDir: home });
      auth = createAuthorization();
      host = await start();
      const restartedAddress = host.server.address();
      if (!restartedAddress || typeof restartedAddress === "string") throw new Error("no port");
      base = `http://127.0.0.1:${restartedAddress.port}`;
    } };
}

describe("verified consumers through public chat", () => {
  it("reads only Alice's order and denies other and unknown orders before payload retrieval", async () => {
    const host = await fixture();
    expect((await host.pub("/threads")).status).toBe(401);
    const token = await host.login();
    const conversation = await host.open(token);
    expect((await host.send(token, conversation, "alice-order")).text).toContain("private-alice-order");
    expect(host.reads()).toBe(1);
    for (const id of ["bob-order", "unknown-order", "other-business"]) {
      const response = await host.send(token, conversation, id);
      expect(response.text).toContain("identity.not_available");
      expect(response.text).not.toContain(`private-${id}`);
    }
    expect(host.reads()).toBe(1);
  });

  it("does not treat the visitor id or another consumer token as conversation ownership", async () => {
    const host = await fixture();
    const alice = await host.login();
    const bob = await host.login("bob");
    const conversation = await host.open(alice);
    expect((await host.pub(`/threads/${conversation}`, bob)).status).toBe(404);
    expect((await host.send(bob, conversation, "alice-order")).status).toBe(404);
    expect((await host.pub(`/threads/${conversation}`)).status).toBe(401);
    expect((await (await host.pub("/threads", bob)).json()).threads).toEqual([]);
    expect(host.reads()).toBe(0);
  });

  it.each(["supporter", "supervisor", "selected"])("permits explicitly scoped %s access, never another Workspace", async (subject) => {
    const host = await fixture();
    const token = await host.login(subject);
    const conversation = await host.open(token);
    expect((await host.send(token, conversation, "alice-order")).text).toContain("private-alice-order");
    expect((await host.send(token, conversation, "other-business")).text).toContain("identity.not_available");
    expect(host.reads()).toBe(1);
  });

  it("rejects actor, role, credential and endpoint injection before even ownership lookup", async () => {
    const host = await fixture();
    const token = await host.login();
    const conversation = await host.open(token);
    for (const key of ["actor", "role", "workspace", "credential", "url", "authorization", "ownerAccountId", "destination"]) {
      expect((await host.send(token, conversation, JSON.stringify({ orderId: "bob-order", [key]: "supervisor" }))).text).toContain("identity.not_available");
    }
    expect(host.metadataReads()).toBe(0);
    expect(host.reads()).toBe(0);
  });

  it("rejects replay, tampering, foreign Workspace and unsigned browser identity", async () => {
    const host = await fixture();
    const proof = await host.assertion();
    expect((await host.pub("/admission", undefined, { connectionId: "app", assertion: proof })).status).toBe(201);
    expect((await host.pub("/admission", undefined, { connectionId: "app", assertion: proof })).status).toBe(401);
    for (const assertion of [proof.slice(0, -10) + "AAAAAAAAAA", await host.assertion("alice", { workspace: "foreign" }), "alice"]) {
      expect((await host.pub("/admission", undefined, { connectionId: "app", assertion })).status).toBe(401);
    }
    expect((await host.pub("/admission", undefined, { customerId: "alice" })).status).toBe(400);
    expect((await host.pub("/admission", undefined, { connectionId: "app", assertion: await host.assertion() }, { Origin: "https://evil.example" })).status).toBe(403);
    expect(host.reads()).toBe(0);
  });

  it("blocks a token from another Workspace even with the same subject and visitor id", async () => {
    const first = await fixture();
    const second = await fixture({ workspace: "business-b" });
    const token = await first.login();
    expect((await second.pub("/threads", token, {})).status).toBe(401);
    expect(second.reads()).toBe(0);
  });

  it.each([false, "error"])("fails closed on policy outcome %s", async (decision) => {
    const host = await fixture({ engine: { check: async () => { if (decision === "error") throw new Error("SECRET endpoint error"); return false; } } });
    const token = await host.login();
    const result = await host.send(token, await host.open(token), "alice-order");
    expect(result.text).toContain("identity.not_available");
    expect(result.text).not.toContain("SECRET");
    expect(host.reads()).toBe(0);
  });

  it("rechecks permission after an approval wait", async () => {
    const host = await fixture({ askFirst: true });
    const token = await host.login();
    const conversation = await host.open(token);
    const sending = host.send(token, conversation, "alice-order");
    let approvals: any[] = [];
    for (let attempt = 0; attempt < 100 && approvals.length === 0; attempt += 1) {
      approvals = (await host.admin("GET", "/api/agents/approvals")).body.approvals ?? [];
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(approvals).toHaveLength(1);
    host.identities.revoke("principal", host.alice);
    await host.admin("POST", `/api/agents/support/sessions/${conversation}/approval/approve`);
    expect((await sending).text).not.toContain("private-alice-order");
    expect(host.reads()).toBe(0);
  });

  it("withholds buffered output if permission is removed after retrieval", async () => {
    let revoke = () => {};
    const host = await fixture({ beforeReply: () => revoke() });
    const token = await host.login();
    revoke = () => host.identities.revoke("principal", host.alice);
    expect((await host.send(token, await host.open(token), "alice-order")).text).not.toContain("private-alice-order");
    expect(host.reads()).toBe(1);
  });

  it("withholds history and further model input when order ownership changes", async () => {
    const host = await fixture();
    const token = await host.login();
    const conversation = await host.open(token);
    await host.send(token, conversation, "alice-order");
    host.records.get("alice-order")!.ownerAccountId = "bob";
    host.records.get("alice-order")!.version = "v2";
    expect((await host.pub(`/threads/${conversation}`, token)).status).toBe(404);
    expect((await host.send(token, conversation, "alice-order")).status).toBe(404);
    expect(host.backend.calls).toBe(1);
  });

  it("retains ownership, proof replay protection and revocation across Host restarts", async () => {
    const host = await fixture();
    const proof = await host.assertion();
    const token = (await (await host.pub("/admission", undefined, { connectionId: "app", assertion: proof })).json()).token as string;
    const other = await host.login("bob");
    const conversation = await host.open(token);
    const authority = host.identities.authenticate(token, "support");
    expect((await host.send(token, conversation, "alice-order")).text).toContain("private-alice-order");
    await host.restart();
    expect((await host.pub(`/threads/${conversation}`, token)).status).toBe(200);
    expect((await host.pub(`/threads/${conversation}`, other)).status).toBe(404);
    expect((await host.pub("/admission", undefined, { connectionId: "app", assertion: proof })).status).toBe(401);
    expect((await host.send(token, conversation, "alice-order")).text).toContain("private-alice-order");
    host.identities.revoke("grant", authority.grantId);
    await host.restart();
    expect((await host.pub(`/threads/${conversation}`, token)).status).toBe(401);
    expect((await host.send(token, conversation, "alice-order")).status).toBe(401);
    expect(host.reads()).toBe(2);
  });

  it("refuses child invocation rather than losing the initiating authority", async () => {
    const host = await fixture();
    const token = await host.login();
    const result = await host.send(token, await host.open(token), "delegate");
    expect(result.text).not.toContain("private");
    expect(host.backend.calls).toBe(1);
    expect(host.reads()).toBe(0);
  });
});
