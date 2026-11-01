import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsumerIdentityRuntime } from "../src/identity/runtime.js";
import { handleIdentitySetupRoutes } from "../src/server/identitySetupRoutes.js";
import { startOrderApiFixture, type OrderApiFixture } from "./helpers/orderApiFixture.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CREDENTIAL = "downstream-key";

async function home() {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-identity-runtime-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runtimeFor(dir: string, extra: Partial<ConstructorParameters<typeof ConsumerIdentityRuntime>[0]> = {}) {
  const runtime = new ConsumerIdentityRuntime({ homeDir: dir, secretsFile: path.join(dir, "secrets", "identity-secrets.json"), workspaceId: "w", ...extra });
  cleanups.push(() => runtime.close());
  return runtime;
}

async function fixture(): Promise<OrderApiFixture> {
  const started = await startOrderApiFixture({ credential: CREDENTIAL });
  cleanups.push(() => started.close());
  return started;
}

describe("managed consumer identity runtime", () => {
  it("is off until enabled and fails closed while off", async () => {
    const runtime = runtimeFor(await home());
    runtime.init();
    expect(runtime.current()).toBeUndefined();
    expect(runtime.status()).toMatchObject({ mode: "managed", enabled: false, workspaceId: "w", engine: { kind: "scope" } });
    expect(() => runtime.setEngine({ kind: "scope" })).toThrowError("identity.setup_required");
    await expect(runtime.setOrders({ endpoint: "https://orders.example", audience: "orders", credential: "k" })).rejects.toThrowError("identity.setup_required");
  });

  it("keeps people, grants and settings across a restart", async () => {
    const dir = await home();
    const first = runtimeFor(dir);
    first.init();
    first.enable();
    first.current()!.store.registerService("nightly", "acct-reports", { scope: "workspace", agents: ["support"], actions: ["order:read", "conversation:use"] });
    first.close();

    const second = runtimeFor(dir);
    second.init();
    expect(second.status().enabled).toBe(true);
    expect(second.current()!.store.listConnections().map((row) => row.id)).toEqual(["nightly"]);
    expect(second.current()!.store.listAssignments()).toEqual([expect.objectContaining({ subject: "service:nightly", accountId: "acct-reports" })]);
    expect((await stat(path.join(dir, "identity"))).mode & 0o077).toBe(0);
  });

  it("stays on the same authority object when the engine and orders change", async () => {
    const orders = await fixture();
    const runtime = runtimeFor(await home(), { allowLoopback: true });
    runtime.init();
    runtime.enable();
    const authorization = runtime.current();
    runtime.setEngine({ kind: "scope" });
    await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL });
    expect(runtime.current()).toBe(authorization);
  });

  it("validates the engine choice and reports a scope engine as sound", async () => {
    const runtime = runtimeFor(await home());
    runtime.init();
    runtime.enable();
    expect(() => runtime.setEngine({ kind: "cerbos", endpoint: "https://pdp.example.com" })).toThrowError("identity.setup_required");
    expect(() => runtime.setEngine({ kind: "cerbos", endpoint: "not a url" })).toThrowError("identity.setup_required");
    expect(runtime.status().engine).toEqual({ kind: "scope" });
    await expect(runtime.testEngine()).resolves.toEqual({ ok: true, allowsOwn: true, deniesOther: true, reason: "ok" });
  });

  it("tells an unreachable engine apart from a policy that allows too much", async () => {
    const dir = await home();
    const respond = (effect: string | null): typeof fetch => (async (_url, init) => {
      if (effect === null) throw new Error("connect ECONNREFUSED");
      const body = JSON.parse(String(init?.body)) as { requestId: string; resources: Array<{ resource: { id: string; policyVersion: string } }> };
      const resource = body.resources[0]!.resource;
      return new Response(JSON.stringify({ requestId: body.requestId, results: [{ resource: { kind: "order", id: resource.id, policyVersion: resource.policyVersion }, actions: { read: effect } }] }));
    }) as typeof fetch;

    const down = runtimeFor(dir, { fetch: respond(null) });
    down.init();
    down.enable();
    down.setEngine({ kind: "cerbos", endpoint: "http://127.0.0.1:3592" });
    await expect(down.testEngine()).resolves.toMatchObject({ ok: false, reason: "unreachable" });
    down.close();

    const open = runtimeFor(dir, { fetch: respond("EFFECT_ALLOW") });
    open.init();
    await expect(open.testEngine()).resolves.toMatchObject({ ok: false, reason: "too_broad" });
  });

  it("keeps the order credential and private key out of settings, status and the database", async () => {
    const orders = await fixture();
    const dir = await home();
    const runtime = runtimeFor(dir, { allowLoopback: true });
    runtime.init();
    runtime.enable();
    const status = await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL });
    expect(status.orders).toMatchObject({ configured: true, endpoint: orders.url, audience: "orders-api", hasCredential: true });
    expect(status.orders.signingKey?.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
    expect(status.orders.signingKey?.publicJwk).not.toHaveProperty("d");
    const visible = JSON.stringify(status) + await readFile(path.join(dir, "identity", "settings.json"), "utf8");
    expect(visible).not.toContain(CREDENTIAL);
    const secrets = await readFile(path.join(dir, "secrets", "identity-secrets.json"), "utf8");
    expect(secrets).toContain(CREDENTIAL);
    expect((await stat(path.join(dir, "secrets", "identity-secrets.json"))).mode & 0o077).toBe(0);
  });

  it("refuses plain-http endpoints unless loopback is allowed and requires a first credential", async () => {
    const runtime = runtimeFor(await home());
    runtime.init();
    runtime.enable();
    await expect(runtime.setOrders({ endpoint: "http://127.0.0.1:9", audience: "o", credential: "k" })).rejects.toThrowError("identity.setup_required");
    await expect(runtime.setOrders({ endpoint: "https://orders.example", audience: "o" })).rejects.toThrowError("identity.setup_required");
    await expect(runtime.setOrders({ endpoint: "https://orders.example", audience: "o", credential: "line\nbreak" })).rejects.toThrowError("identity.setup_required");
    expect(runtime.status().orders.configured).toBe(false);
  });

  it("tests the order API contract and verifies its own signature", async () => {
    const orders = await fixture();
    const runtime = runtimeFor(await home(), { allowLoopback: true });
    runtime.init();
    runtime.enable();
    await expect(runtime.testOrders("order-a")).resolves.toEqual({ ok: false, reason: "not_configured" });
    await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL });
    await expect(runtime.testOrders("order-a")).resolves.toEqual({ ok: true, signingVerified: true, ownership: { version: "v1", assignedAccounts: 0 } });
    await expect(runtime.testOrders("missing")).resolves.toEqual({ ok: false, reason: "failed" });
    await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: "wrong-key" });
    await expect(runtime.testOrders("order-a")).resolves.toEqual({ ok: false, reason: "failed" });
    await expect(runtime.testOrders("../../etc")).rejects.toThrowError("identity.setup_required");
  });

  it("rotation publishes a different key id and public key", async () => {
    const orders = await fixture();
    const runtime = runtimeFor(await home(), { allowLoopback: true });
    runtime.init();
    runtime.enable();
    const before = (await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL })).orders.signingKey!;
    const after = (await runtime.rotateSigningKey()).orders.signingKey!;
    expect(after.keyId).not.toBe(before.keyId);
    expect(after.publicJwk.x).not.toBe(before.publicJwk.x);
    await expect(runtime.testOrders("order-a")).resolves.toMatchObject({ ok: true, signingVerified: true });
  });

  it("removes the order API and its secrets", async () => {
    const orders = await fixture();
    const dir = await home();
    const runtime = runtimeFor(dir, { allowLoopback: true });
    runtime.init();
    runtime.enable();
    await runtime.setOrders({ endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL });
    const status = runtime.clearOrders();
    expect(status.orders).toEqual({ configured: false, endpoint: null, audience: null, hasCredential: false, signingKey: null });
    expect(await readFile(path.join(dir, "secrets", "identity-secrets.json"), "utf8")).not.toContain(CREDENTIAL);
  });

  it("turns off without losing data and fails protected paths closed", async () => {
    const dir = await home();
    const runtime = runtimeFor(dir);
    runtime.init();
    runtime.enable();
    runtime.current()!.store.registerService("nightly", "acct", { scope: "own", agents: ["support"], actions: ["order:read", "conversation:use"] });
    runtime.disable();
    expect(runtime.current()).toBeUndefined();
    runtime.enable();
    expect(runtime.current()!.store.listConnections()).toHaveLength(1);
  });

  it("refuses a database that belongs to another Workspace", async () => {
    const dir = await home();
    const first = runtimeFor(dir);
    first.init();
    first.enable();
    first.close();
    const other = runtimeFor(dir, { workspaceId: "someone-else" });
    other.init();
    expect(other.status().enabled).toBe(false);
    expect(other.current()).toBeUndefined();
  });
});

type Reply = { status: number; body: Record<string, any> };

async function call(runtime: ConsumerIdentityRuntime | undefined, method: string, target: string, payload?: unknown): Promise<Reply & { handled: boolean }> {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as IncomingMessage;
  req.method = method;
  req.url = target;
  let reply: Reply = { status: 0, body: {} };
  const handled = await handleIdentitySetupRoutes(req, method, target, runtime, false, {} as ServerResponse, (_res, status, body) => {
    reply = { status, body: (body ?? {}) as Record<string, any> };
  });
  return { handled, ...reply };
}

describe("identity setup routes", () => {
  it("walks from off to a tested order API without exposing a secret", async () => {
    const orders = await fixture();
    const runtime = runtimeFor(await home(), { allowLoopback: true });
    runtime.init();
    expect((await call(runtime, "GET", "/api/identity/setup")).body).toMatchObject({ enabled: false, mode: "managed" });
    expect((await call(runtime, "POST", "/api/identity/setup/engine", { kind: "scope" })).body).toEqual({ code: "identity.setup_required" });
    expect((await call(runtime, "POST", "/api/identity/setup/enable")).body).toMatchObject({ enabled: true });
    expect((await call(runtime, "POST", "/api/identity/setup/engine/test")).body).toMatchObject({ ok: true });
    const saved = await call(runtime, "POST", "/api/identity/setup/orders", { endpoint: orders.url, audience: "orders-api", credential: CREDENTIAL });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(saved.body)).not.toMatch(/"d"\s*:/);
    expect((await call(runtime, "POST", "/api/identity/setup/orders/test", { orderId: "order-a" })).body).toMatchObject({ ok: true, signingVerified: true });
    expect((await call(runtime, "POST", "/api/identity/setup/orders/signing-key")).status).toBe(200);
    expect((await call(runtime, "POST", "/api/identity/setup/orders/clear")).body.orders.configured).toBe(false);
    expect((await call(runtime, "POST", "/api/identity/setup/disable")).body).toMatchObject({ enabled: false });
  });

  it("rejects bad input with a code and nothing else", async () => {
    const runtime = runtimeFor(await home());
    runtime.init();
    await call(runtime, "POST", "/api/identity/setup/enable");
    for (const [target, payload] of [
      ["/api/identity/setup/engine", { kind: "magic" }],
      ["/api/identity/setup/engine", { kind: "cerbos" }],
      ["/api/identity/setup/orders", { endpoint: "https://x.example", audience: "" }],
      ["/api/identity/setup/orders", { endpoint: "https://x.example", audience: "a", credential: 5 }],
      ["/api/identity/setup/orders/test", { orderId: "" }],
    ] as const) {
      const reply = await call(runtime, "POST", target, payload);
      expect(reply.status).toBe(400);
      expect(reply.body).toEqual({ code: "identity.setup_required" });
    }
    expect((await call(runtime, "PUT", "/api/identity/setup/enable")).status).toBe(405);
  });

  it("leaves setup to the embedder when it supplied its own authorization", async () => {
    expect((await call(undefined, "GET", "/api/identity/setup")).body).toEqual({ mode: "embedded", enabled: false });
    const reply = await call(undefined, "POST", "/api/identity/setup/enable");
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ code: "identity.managed_externally" });
    expect((await call(undefined, "GET", "/api/identity/connections")).handled).toBe(false);
  });
});
