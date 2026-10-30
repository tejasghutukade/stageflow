import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SignJWT, type JWTPayload } from "jose";
import { createOrderApiAdapter } from "../src/identity/orders.js";
import type { ConsumerAuthority } from "../src/identity/types.js";
import { startOrderApiFixture, type OrderApiFixture } from "./helpers/orderApiFixture.js";

const PRIVATE_STATUS = "private-fixture-status";
const CHAT_BEARER = "chat-session-bearer";
const ID_TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsImlzcyI6ImlkcCJ9.signature";

type Seen = {
  hostname: string;
  url: string;
  requestBody: string;
  authorization: string;
  context: string;
  status: number;
  body: string;
};

const fixtures: OrderApiFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("local order API", () => {
  it("returns status only for a signed short-lived context and the ownership version it just read", async () => {
    const fixture = await open();
    const seen: Seen[] = [];
    const adapter = bind(fixture, fixture.credential, seen);
    const ownership = await adapter.ownership("w", "order-a", new AbortController().signal);
    expect(ownership).toEqual(fixture.resource());
    expect(seen[0].body).not.toContain(PRIVATE_STATUS);
    const status = await adapter.read(authority(), ownership, new AbortController().signal);
    expect(status).toEqual({ orderId: "order-a", status: PRIVATE_STATUS, updatedAt: "2026-10-30T12:00:00.000Z" });
    expect(seen[1].authorization).toBe("Bearer downstream-key");
    expect(seen[1].status).toBe(200);
    const claims = jwtPayload(seen[1].context);
    expect(claims).toMatchObject({
      aud: fixture.audience, sub: "p", workspace: "w", action: "order:read", resource: "order-a", resource_version: "v1",
    });
    expect(typeof claims.jti).toBe("string");
    expect(claims.jti).not.toBe("");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(30);
    expect(JSON.parse(seen[1].requestBody)).toEqual({ orderId: "order-a", expectedVersion: "v1" });
    expectLocal(seen, fixture);
  });

  it("withholds the private payload when ownership changes before the status read", async () => {
    const fixture = await open();
    const seen: Seen[] = [];
    const adapter = bind(fixture, fixture.credential, seen);
    const ownership = await adapter.ownership("w", "order-a", new AbortController().signal);
    fixture.setVersion("v2");
    const outcome = await surfaced(adapter.read(authority(), ownership, new AbortController().signal));
    expect(outcome).toMatch(/request_failed|order_unavailable/);
    expect(outcome).not.toContain(PRIVATE_STATUS);
    expect(seen[1].status).toBe(404);
    expect(JSON.parse(seen[1].body)).toEqual({ error: "not_available" });
    expect(seen[1].body).not.toContain(PRIVATE_STATUS);
    expect(JSON.parse(seen[1].requestBody)).toEqual({ orderId: "order-a", expectedVersion: ownership.version });
    expect(jwtPayload(seen[1].context).resource_version).toBe(ownership.version);
    expect(seen.map((call) => call.body).join("\n")).not.toContain(PRIVATE_STATUS);
    expectLocal(seen, fixture);
  });

  it.each([
    ["chat bearer", CHAT_BEARER],
    ["provider ID token", ID_TOKEN],
    ["administrator credential", "admin"],
  ])("rejects the %s and does not return the private status", async (_name, credential) => {
    const fixture = await open({ chatBearer: CHAT_BEARER });
    const seen: Seen[] = [];
    const adapter = bind(fixture, credential, seen);
    const outcome = await surfaced(adapter.read(authority(), fixture.resource(), new AbortController().signal));
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(401);
    expect(seen[0].authorization).toBe(`Bearer ${credential}`);
    expect(seen[0].body).not.toContain(PRIVATE_STATUS);
    expect(outcome).not.toContain(PRIVATE_STATUS);
    expect(outcome).toMatch(/request_failed|order_unavailable/);
    expectLocal(seen, fixture);
  });

  it("rejects a context signed for another audience or with another secret", async () => {
    const fixture = await open();
    const wrongAudience: Seen[] = [];
    const audienceAdapter = bind(fixture, fixture.credential, wrongAudience, { audience: "other-api" });
    const audienceOutcome = await surfaced(audienceAdapter.read(authority(), fixture.resource(), new AbortController().signal));
    expect(wrongAudience[0].status).toBe(401);
    expect(audienceOutcome).not.toContain(PRIVATE_STATUS);
    expect(wrongAudience[0].body).not.toContain(PRIVATE_STATUS);

    const wrongSecret: Seen[] = [];
    const secretAdapter = bind(fixture, fixture.credential, wrongSecret, { secret: "not-the-fixture-secret-not-the-fixture" });
    const secretOutcome = await surfaced(secretAdapter.read(authority(), fixture.resource(), new AbortController().signal));
    expect(wrongSecret[0].status).toBe(401);
    expect(secretOutcome).not.toContain(PRIVATE_STATUS);
    expect(wrongSecret[0].body).not.toContain(PRIVATE_STATUS);
    expectLocal([...wrongAudience, ...wrongSecret], fixture);
  });

  it.each(["expired", "long-lived", "missing-jti", "missing-header", "wrong-action"] as const)("rejects a %s invocation context", async (kind) => {
    const fixture = await open();
    const now = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { Authorization: `Bearer ${fixture.credential}` };
    if (kind !== "missing-header") {
      const overrides = kind === "expired" ? { iat: now - 90, exp: now - 60 }
        : kind === "long-lived" ? { iat: now, exp: now + 31 }
        : kind === "wrong-action" ? { action: "order:write" } : {};
      headers["Stageflow-Authorization"] = await contextToken(fixture, overrides, kind === "missing-jti" ? ["jti"] : []);
    }
    const response = await fetch(new URL("/stageflow/order-status", fixture.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ orderId: "order-a", expectedVersion: "v1" }),
    });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).not.toContain(PRIVATE_STATUS);
    expect(new URL(fixture.url).hostname).toBe("127.0.0.1");
    expect(fixture.peers().every((peer) => /^(127\.0\.0\.1|::ffff:127\.0\.0\.1|::1)$/.test(peer))).toBe(true);
  });

  it("does not call a non-loopback order API", () => {
    expect(() => createOrderApiAdapter({
      endpoint: "http://orders.customer.example",
      audience: "orders-api",
      credential: async () => "downstream-key",
      signContext: async () => "signed",
    })).toThrow("A trusted HTTPS endpoint is required");
  });
});

async function open(options?: Parameters<typeof startOrderApiFixture>[0]): Promise<OrderApiFixture> {
  const fixture = await startOrderApiFixture(options);
  fixtures.push(fixture);
  return fixture;
}

function bind(fixture: OrderApiFixture, credential: string, seen: Seen[], options: { audience?: string; secret?: string } = {}) {
  return createOrderApiAdapter({
    endpoint: fixture.url,
    allowLoopback: true,
    audience: options.audience ?? fixture.audience,
    credential: async (workspaceId) => {
      expect(workspaceId).toBe("w");
      return credential;
    },
    signContext: (claims) => sign(claims, options.secret ?? fixture.secret),
    fetch: recordingFetch(seen),
  });
}

function authority(): ConsumerAuthority {
  return {
    principal: {
      id: "p", workspaceId: "w", connectionId: "app", subject: "alice", accountId: "account-a",
      mappingSource: "directory:v3", revision: 1,
      permission: { scope: "own", agents: ["support"], actions: ["order:read", "conversation:use"] },
    },
    sessionId: "session", grantId: "grant", agentId: "support", expiresAt: Date.now() + 240_000,
    actions: ["order:read"], resources: null,
  };
}

function sign(claims: Record<string, unknown>, secret: string): Promise<string> {
  return new SignJWT(claims as JWTPayload).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}

async function contextToken(fixture: OrderApiFixture, overrides: Record<string, unknown>, omit: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    aud: fixture.audience, sub: "p", workspace: "w", action: "order:read", resource: "order-a",
    resource_version: "v1", jti: randomUUID(), grant: "grant", iat: now, exp: now + 30, ...overrides,
  };
  for (const key of omit) delete claims[key];
  return sign(claims, fixture.secret);
}

function recordingFetch(seen: Seen[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error(`request left 127.0.0.1 for ${url.hostname}`);
    const response = await fetch(input, init);
    const headers = new Headers(init?.headers);
    seen.push({
      hostname: url.hostname,
      url: url.toString(),
      requestBody: typeof init?.body === "string" ? init.body : "",
      authorization: headers.get("authorization") ?? "",
      context: headers.get("stageflow-authorization") ?? "",
      status: response.status,
      body: await response.clone().text(),
    });
    return response;
  };
}

function jwtPayload(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  if (!segment) throw new Error("malformed context");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function surfaced(work: Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await work);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

function expectLocal(seen: Seen[], fixture: OrderApiFixture): void {
  expect(seen.length).toBeGreaterThan(0);
  const origin = new URL(fixture.url).origin;
  for (const call of seen) {
    expect(call.hostname).toBe("127.0.0.1");
    expect(new URL(call.url).origin).toBe(origin);
  }
  expect(fixture.peers().length).toBeGreaterThanOrEqual(seen.length);
  for (const peer of fixture.peers()) expect(peer).toMatch(/^(127\.0\.0\.1|::ffff:127\.0\.0\.1|::1)$/);
}
