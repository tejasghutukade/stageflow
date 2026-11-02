import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import type { TurnHooks } from "../src/agents/runtime/types.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import type { ConsumerAuthority, OwnedResource } from "../src/identity/types.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-identity-delegate-"));
  const workspace = "business-a";
  const identities = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), workspace);
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  identities.registerHandoff({ id: "app", issuer: "https://business.example", agentId: "support", audience: `stageflow:${workspace}:support`,
    publicJwks: { keys: [{ ...await exportJWK(publicKey), kid: "app-key" }] }, algorithms: ["ES256"] });
  const permission = { scope: "own" as const, agents: ["support", "helper"], actions: ["conversation:use", "order:read"] };
  const alice = identities.assign("app", "alice", "alice", "business-directory:v1", permission);
  identities.assign("app", "narrow", "narrow", "business-directory:v1", { ...permission, scope: "selected", resources: ["alice-order"] });
  const records = new Map<string, OwnedResource>([
    ["alice-order", { id: "alice-order", workspaceId: workspace, ownerAccountId: "alice", assignedAccountIds: [], version: "v1" }],
    ["bob-order", { id: "bob-order", workspaceId: workspace, ownerAccountId: "bob", assignedAccountIds: [], version: "v1" }],
  ]);
  let reads = 0;
  const seen: ConsumerAuthority[] = [];
  let revoke: () => void = () => {};
  const auth = new ConsumerAuthorization(identities, createScopeAuthorizationEngine(), {
    ownership: async (_workspace, id) => {
      const record = records.get(id);
      if (!record) throw new Error("not found");
      return structuredClone(record);
    },
    read: async (authority, resource) => {
      seen.push(authority);
      reads += 1;
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1");
  const backend = scriptedBackend(async (messages, ctx) => {
    const text = messages.at(-1)!.text;
    if (text === "delegate") return ctx.hooks.delegate("helper", "alice-order");
    if (text === "delegate-bob") return ctx.hooks.delegate("helper", "bob-order");
    if (text === "delegate-missing") return ctx.hooks.delegate("child", "alice-order");
    if (text === "revoke-parent") return ctx.hooks.delegate("helper", "then-revoke");
    if (text === "then-revoke") {
      revoke();
      return (await ctx.tool("orders.status", { orderId: "alice-order" })).output;
    }
    if (text === "unsafe-tools") {
      const shell = await ctx.tool("bash", { command: "cat orders" });
      const file = await ctx.tool("read", { path: "orders.txt" });
      const browser = await ctx.tool("browser", { url: "https://orders.example" });
      return `${shell.output}|${file.output}|${browser.output}`;
    }
    return (await ctx.tool("orders.status", { orderId: text })).output;
  });
  bindStageflowHomeForTests(home);
  const runtimeStore = createRunStore({ rootDir: home });
  const host = await startUiServer({ agent: scriptedFakeAgent([]), cwd: home, rootDir: home, store: runtimeStore, port: 0,
    uiDistDir: path.join(home, "missing"), controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: "d".repeat(32) }),
    agentConversationBackend: backend, consumerAuthorization: auth });
  cleanups.push(async () => { await closeServer(host.server); await runtimeStore.close(); identities.close(); await rm(home, { recursive: true, force: true }); });
  const address = host.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, endpoint: string, body?: unknown) => {
    const response = await fetch(base + endpoint, { method, headers: { Authorization: `Bearer ${"d".repeat(32)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as { definition?: { web_chat?: { slug?: string } } } };
  };
  const helper = await admin("POST", "/api/agents", { definition: { id: "helper", name: "Helper", instructions: "Look up one order.", enabled: true,
    tools: { mcp: { orders: ["status"] } }, web_chat: { enabled: false } } });
  expect(helper.response.status).toBe(201);
  await admin("POST", "/api/agents/helper/enable");
  const made = await admin("POST", "/api/agents", { definition: { id: "support", name: "Support", instructions: "Help with order status.", enabled: true,
    tools: { mcp: { orders: ["status"] } }, sub_agents: ["helper"], sub_agent_depth: 1,
    web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 120 } } });
  expect(made.response.status).toBe(201);
  await admin("POST", "/api/agents/support/enable");
  const slug = made.body.definition!.web_chat!.slug!;
  const pub = (suffix: string, token?: string, body?: unknown) => fetch(`${base}/api/public/chat/${slug}${suffix}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const assertion = (subject: string) => new SignJWT({ workspace, agent: "support" })
    .setProtectedHeader({ alg: "ES256", kid: "app-key", typ: "stageflow-agent-handoff+jwt" })
    .setIssuer("https://business.example").setAudience(`stageflow:${workspace}:support`).setSubject(subject)
    .setIssuedAt().setExpirationTime("4m").setJti(randomUUID()).sign(privateKey);
  const login = async (subject = "alice") => {
    const response = await pub("/admission", undefined, { connectionId: "app", assertion: await assertion(subject) });
    expect(response.status).toBe(201);
    return (await response.json() as { token: string }).token;
  };
  const open = async (token: string) => {
    const response = await pub("/threads", token, {});
    expect(response.status).toBe(201);
    return (await response.json() as { thread: { id: string } }).thread.id;
  };
  const send = async (token: string, conversation: string, text: string) => {
    const response = await pub(`/threads/${conversation}/messages`, token, { text });
    return { status: response.status, text: await response.text() };
  };
  return { identities, alice, backend, pub, login, open, send, admin, base, seen: () => seen, reads: () => reads,
    armRevoke: (fn: () => void) => { revoke = fn; } };
}

describe("narrowed consumer delegation", () => {
  it("opens the child as the same person and reads only an order the narrowed grant allows", async () => {
    const host = await fixture();
    const token = await host.login();
    const parent = host.identities.authenticate(token, "support");
    const result = await host.send(token, await host.open(token), "delegate");
    expect(result.text).toContain("private-alice-order");
    expect(host.reads()).toBe(1);
    expect(host.seen()[0]).toMatchObject({ agentId: "helper", principal: { id: parent.principal.id, subject: "alice" } });
    expect(host.seen()[0]!.sessionId).not.toBe(parent.sessionId);
    expect(host.seen()[0]!.actions.every((action) => parent.actions.includes(action))).toBe(true);
    const denied = await host.send(token, await host.open(token), "delegate-bob");
    expect(denied.text).not.toContain("private-bob-order");
    expect(host.reads()).toBe(1);
  });

  it("refuses a wider resource, a longer expiry, or a service subject before any order read", async () => {
    const host = await fixture();
    const token = await host.login("narrow");
    const parent = host.identities.authenticate(token, "support");
    expect(parent.resources).toEqual(["alice-order"]);
    expect(() => host.identities.narrowAuthority(parent, "helper", { resources: ["alice-order", "bob-order"] })).toThrow("identity.not_available");
    expect(() => host.identities.narrowAuthority(parent, "helper", { expiresAt: parent.expiresAt + 1_000 })).toThrow("identity.not_available");
    expect(() => host.identities.narrowAuthority(parent, "helper", { subject: "service:batch" } as { actions?: string[] })).toThrow("identity.not_available");
    expect(host.reads()).toBe(0);
    const missing = await host.send(token, await host.open(token), "delegate-missing");
    expect(missing.text).not.toContain("private");
    expect(host.backend.calls).toBe(1);
    expect(host.reads()).toBe(0);
  });

  it("stops the child tool body when the parent session or grant is revoked", async () => {
    const host = await fixture();
    const token = await host.login();
    const parent = host.identities.authenticate(token, "support");
    host.armRevoke(() => host.identities.revoke("session", parent.sessionId));
    const bySession = await host.send(token, await host.open(token), "revoke-parent");
    expect(bySession.text).not.toContain("private");
    expect(host.reads()).toBe(0);
    const again = await host.login();
    const grant = host.identities.authenticate(again, "support");
    host.armRevoke(() => host.identities.revoke("grant", grant.grantId));
    const byGrant = await host.send(again, await host.open(again), "revoke-parent");
    expect(byGrant.text).not.toContain("private");
    expect(host.reads()).toBe(0);
  });

  it("refuses shell, files, browser, skills, and an unsafe child publication", async () => {
    const host = await fixture();
    const risky = await host.admin("POST", "/api/agents", { definition: { id: "risky", name: "Risky", instructions: "Do not publish.", enabled: true,
      tools: { browser: true, skills: ["lookup"] }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 30 } } });
    expect(risky.response.status).toBe(201);
    await host.admin("POST", "/api/agents/risky/enable");
    const slug = risky.body.definition!.web_chat!.slug!;
    const blocked = await fetch(`${host.base}/api/public/chat/${slug}`);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ code: "identity.setup_required" });
    const shell = await host.admin("POST", "/api/agents", { definition: { id: "shelly", name: "Shelly", instructions: "Do not publish.", enabled: true,
      tools: { builtin: ["shell"] }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 30 } } });
    expect(shell.response.status).toBe(201);
    await host.admin("POST", "/api/agents/shelly/enable");
    const shellSlug = shell.body.definition!.web_chat!.slug!;
    expect((await fetch(`${host.base}/api/public/chat/${shellSlug}`)).status).toBe(503);
    const foreign = await host.admin("POST", "/api/agents", { definition: { id: "foreign", name: "Foreign", instructions: "Do not publish.", enabled: true,
      tools: { mcp: { orders: ["status"], github: ["list"] } }, web_chat: { enabled: true, access: "authenticated", rate_limit_per_minute: 30 } } });
    expect(foreign.response.status).toBe(201);
    await host.admin("POST", "/api/agents/foreign/enable");
    const foreignSlug = foreign.body.definition!.web_chat!.slug!;
    expect((await fetch(`${host.base}/api/public/chat/${foreignSlug}`)).status).toBe(503);
    const token = await host.login();
    const refused = await host.send(token, await host.open(token), "unsafe-tools");
    expect(refused.text).not.toContain("private");
    expect(host.reads()).toBe(0);
  });

  it("keeps allowlisted consumer-safe sub-agents while stripping ambient tools", async () => {
    const parsed = parseAgentDefinition({ id: "support", name: "Support", instructions: "Help.", enabled: true,
      project_context: true, sub_agents: ["helper", "worker"], tools: { builtin: ["read", "shell"], mcp: { orders: ["status"] }, skills: ["lookup"], browser: true } });
    if (!parsed.ok) throw new Error("definition");
    let delegated: string | undefined;
    const hooks: TurnHooks = { gate: async () => ({ allow: true }), toolStarted: () => undefined, toolFinished: () => undefined,
      modelFinished: () => undefined, delegate: async (agentId) => { delegated = agentId; return "child"; } };
    const opened: OpenSessionInput[] = [];
    const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: async (input) => {
      opened.push(input);
      const listeners = new Set<(event: unknown) => void>();
      return { toolNames: input.toolNames, shutdown: vi.fn(async () => undefined), session: {
        subscribe: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        prompt: async () => { await input.delegateTool?.("helper", "task", "call-1"); },
        dispose: () => undefined, abort: async () => undefined,
      } } as never;
    } });
    await runtime.complete({ sessionId: "consumer", projectRoot: "/p", definition: parsed.value, consumerTools: [],
      consumerSafeSubAgents: ["helper"], messages: [{ role: "user", text: "go" }], signal: new AbortController().signal,
      onDelta: () => undefined, hooks });
    expect(opened[0]!.definition.sub_agents).toEqual(["helper"]);
    expect(opened[0]!.definition.tools).toMatchObject({ builtin: [], mcp: {}, skills: [], browser: false });
    expect(opened[0]!.definition.project_context).toBe(false);
    expect(opened[0]!.delegateTool).toEqual(expect.any(Function));
    expect(delegated).toBe("helper");
    await runtime.release!("consumer");
  });
});
