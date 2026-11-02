import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { admitEmbeddedConsumer } from "../src/identity/handoff.js";
import { createCerbosAuthorizationEngine } from "../src/identity/cerbos.js";
import { createOrderApiAdapter } from "../src/identity/orders.js";
import type { AuthorizationInput } from "../src/identity/types.js";

const stores: ConsumerIdentityStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function admission() {
  const store = new ConsumerIdentityStore(":memory:", "w");
  stores.push(store);
  const keys = await generateKeyPair("ES256");
  store.registerHandoff({ id: "app", issuer: "https://issuer.example", agentId: "support", audience: "stageflow:w:support",
    algorithms: ["ES256"], publicJwks: { keys: [{ ...await exportJWK(keys.publicKey), kid: "key" }] } });
  store.assign("app", "alice", "business-account", "directory:v3", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  const now = Math.floor(Date.now() / 1000);
  const sign = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => new SignJWT({
    iss: "https://issuer.example", aud: "stageflow:w:support", sub: "alice", workspace: "w", agent: "support", iat: now, exp: now + 240, jti: randomUUID(), ...overrides,
  }).setProtectedHeader({ alg: "ES256", kid: "key", typ: "stageflow-agent-handoff+jwt", ...header }).sign(keys.privateKey);
  return { store, sign, now };
}

describe("maintained handoff verification", () => {
  it.each([
    { iss: "https://wrong.example" }, { aud: "api-token" }, { workspace: "wrong" }, { agent: "other" },
    { sub: "unmapped" }, { jti: "" }, { iat: 0 }, { exp: 0 }, { exp: 9_999_999_999 }, { iat: 9_999_999_999 }, { iat: 1.5 },
  ])("rejects invalid proof %j", async (claims) => {
    const { store, sign } = await admission();
    await expect(admitEmbeddedConsumer(store, "app", "support", await sign(claims))).rejects.toThrow("identity.verification_required");
  });

  it("rejects an API token type even when signature and subject are valid", async () => {
    const { store, sign } = await admission();
    await expect(admitEmbeddedConsumer(store, "app", "support", await sign({}, { typ: "at+jwt" }))).rejects.toThrow("identity.verification_required");
  });

  it("consumes one assertion exactly once under concurrent requests", async () => {
    const { store, sign } = await admission();
    const assertion = await sign();
    const outcomes = await Promise.allSettled([admitEmbeddedConsumer(store, "app", "support", assertion), admitEmbeddedConsumer(store, "app", "support", assertion)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("invalidates old permission revisions", async () => {
    const { store, sign } = await admission();
    const token = await admitEmbeddedConsumer(store, "app", "support", await sign());
    const authority = store.authenticate(token, "support");
    expect(authority.principal.accountId).toBe("business-account");
    store.assign("app", "alice", "business-account", "directory:v4", { scope: "own", agents: ["support"], actions: ["conversation:use"] });
    expect(() => store.resolve(authority.sessionId, "support")).toThrow("identity.verification_required");
  });

  it("expires a session with its verified proof", async () => {
    vi.useFakeTimers();
    try {
      const { store, sign } = await admission();
      const token = await admitEmbeddedConsumer(store, "app", "support", await sign());
      expect(store.authenticate(token, "support").principal.subject).toBe("alice");
      vi.advanceTimersByTime(240_000);
      expect(() => store.authenticate(token, "support")).toThrow("identity.verification_required");
    } finally {
      vi.useRealTimers();
    }
  });
});

const input: AuthorizationInput = {
  authority: { principal: { id: "p", workspaceId: "w", connectionId: "app", subject: "alice", accountId: "account-a", mappingSource: "directory:v3", revision: 1,
    permission: { scope: "own", agents: ["support"], actions: ["order:read", "conversation:use"] } }, sessionId: "session", grantId: "grant", agentId: "support", expiresAt: Date.now() + 240_000, actions: ["order:read"], resources: null },
  resource: { id: "order-a", workspaceId: "w", ownerAccountId: "account-a", assignedAccountIds: [], version: "v1" }, action: "order:read", policyRevision: "consumer_v1",
};

describe("Cerbos decision contract", () => {
  it("correlates an exact resource, version and action before accepting allow", async () => {
    const engine = createCerbosAuthorizationEngine({ endpoint: "http://127.0.0.1:3592", allowLoopback: true,
      fetch: vi.fn(async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        expect(request.principal.attr.workspace).toBe("w");
        expect(request.principal.attr.account).toBe("account-a");
        return Response.json({ requestId: request.requestId, results: [{ resource: request.resources[0].resource, actions: { read: "EFFECT_ALLOW" } }] });
      }) });
    expect(await engine.check(input, new AbortController().signal)).toBe(true);
  });

  it.each([null, {}, { results: [{ actions: { read: "EFFECT_ALLOW" } }] }, { requestId: "wrong", results: [] }])("rejects malformed or uncorrelated PDP response %j", async (result) => {
    const engine = createCerbosAuthorizationEngine({ endpoint: "http://127.0.0.1:3592", allowLoopback: true, fetch: vi.fn(async () => Response.json(result)) });
    expect(await engine.check(input, new AbortController().signal)).toBe(false);
  });

  it("rejects external or credential-bearing PDP endpoints", () => {
    expect(() => createCerbosAuthorizationEngine({ endpoint: "https://pdp.example" })).toThrow();
    expect(() => createCerbosAuthorizationEngine({ endpoint: "https://secret@localhost" })).toThrow();
  });
});

describe("read-only order API contract", () => {
  it("keeps login separate from API credentials and signs fixed constrained requests", async () => {
    const signed: Record<string, unknown>[] = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createOrderApiAdapter({ endpoint: "https://api.business.example", audience: "orders-api",
      credential: async (workspace) => { expect(workspace).toBe("w"); return "downstream-key"; },
      signContext: async (claims) => { signed.push(claims); return "signed-integration-context"; },
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json(String(url).endsWith("ownership") ? input.resource : {
          ownership: input.resource, receipt: { principalId: "p", grantId: "grant" },
          status: { orderId: "order-a", status: "shipped", updatedAt: "2026-10-30T12:00:00.000Z" },
        });
      }) });
    const ownership = await adapter.ownership("w", "order-a", new AbortController().signal);
    expect(await adapter.read(input.authority, ownership, new AbortController().signal)).toMatchObject({ status: "shipped" });
    expect(signed[0]).toMatchObject({ aud: "orders-api", sub: "p", workspace: "w", action: "order:read", resource: "order-a", resource_version: "v1" });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer downstream-key");
    expect((calls[1].init.headers as Record<string, string>)["Stageflow-Authorization"]).toBe("signed-integration-context");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ orderId: "order-a", expectedVersion: "v1" });
  });

  it.each(["workspace", "owner", "version", "principal", "order", "extra-field"])("withholds mismatched %s responses", async (change) => {
    const result = { ownership: structuredClone(input.resource), receipt: { principalId: "p", grantId: "grant" },
      status: { orderId: "order-a", status: "private", updatedAt: "2026-10-30T12:00:00.000Z" } };
    if (change === "workspace") result.ownership.workspaceId = "other";
    if (change === "owner") result.ownership.ownerAccountId = "other";
    if (change === "version") result.ownership.version = "v2";
    if (change === "principal") result.receipt.principalId = "other";
    if (change === "order") result.status.orderId = "other";
    const adapter = createOrderApiAdapter({ endpoint: "https://api.business.example", audience: "orders-api", credential: async () => "api-key", signContext: async () => "signed",
      fetch: vi.fn(async () => Response.json(change === "extra-field" ? { ...result, secret: "hidden" } : result)) });
    await expect(adapter.read(input.authority, input.resource, new AbortController().signal)).rejects.toThrow();
  });
});
