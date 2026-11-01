import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from "jose";
import { z } from "zod";
import { ChannelSecretStore } from "../channels/secretStore.js";
import { ConsumerAuthorization } from "./authorization.js";
import { createCerbosAuthorizationEngine } from "./cerbos.js";
import { createOrderApiAdapter, type OrderDataAdapter } from "./orders.js";
import { createScopeAuthorizationEngine, previewAuthority } from "./scope.js";
import { ConsumerIdentityStore } from "./store.js";
import { ConsumerAccessError, type AuthorizationEngine, type OwnedResource } from "./types.js";

export const POLICY_REVISION = "consumer_v1";
const SETTINGS_VERSION = 1;
const CREDENTIAL_SECRET = "identity-orders-credential";
const SIGNING_SECRET = "identity-orders-signing-key";
const CONTEXT_TYP = "stageflow-order-context+jwt";

const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  enabled: z.boolean(),
  engine: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("scope") }),
    z.strictObject({ kind: z.literal("cerbos"), endpoint: z.string().min(1).max(2048) }),
  ]),
  orders: z.strictObject({
    endpoint: z.string().min(1).max(2048),
    audience: z.string().min(1).max(256),
  }).optional(),
});
type Settings = z.infer<typeof settingsSchema>;

export type IdentityEngineChoice = Settings["engine"];

export type OrdersSetupInput = { endpoint: string; audience: string; credential?: string };

export type IdentitySetupStatus = {
  mode: "managed" | "embedded";
  enabled: boolean;
  workspaceId: string;
  allowLoopback: boolean;
  engine: IdentityEngineChoice;
  orders: {
    configured: boolean;
    endpoint: string | null;
    audience: string | null;
    hasCredential: boolean;
    signingKey: { keyId: string; publicJwk: JWK } | null;
  };
};

export type EngineTestResult = { ok: boolean; allowsOwn: boolean; deniesOther: boolean; reason: "ok" | "unreachable" | "too_broad" };
export type OrdersTestResult =
  | { ok: true; signingVerified: boolean; ownership: { version: string; assignedAccounts: number } }
  | { ok: false; reason: "not_configured" | "no_credential" | "no_signing_key" | "failed" };

export type ConsumerIdentityRuntimeOptions = {
  /** `$STAGEFLOW_HOME`. Settings and the identity database live under `identity/`. */
  homeDir: string;
  /** Owner-only file for the order API credential and the signing key. */
  secretsFile: string;
  workspaceId?: string;
  allowLoopback?: boolean;
  fetch?: typeof fetch;
};

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function setupRequired(): never {
  throw new ConsumerAccessError("identity.setup_required");
}

/**
 * Host-managed consumer identity. The Host creates the store, picks the policy engine and holds the order API
 * settings, so an operator can switch identity on from the console. One stable `ConsumerAuthorization` is built
 * when identity is enabled; the engine and the order adapter behind it are swapped in place, so a change takes
 * effect without a restart and running conversations keep one authority object.
 */
export class ConsumerIdentityRuntime {
  readonly workspaceId: string;
  private readonly dir: string;
  private readonly settingsFile: string;
  private readonly secrets: ChannelSecretStore;
  private readonly allowLoopback: boolean;
  private readonly fetcher: typeof fetch | undefined;
  private settings: Settings = { version: SETTINGS_VERSION, enabled: false, engine: { kind: "scope" } };
  private store: ConsumerIdentityStore | undefined;
  private authorization: ConsumerAuthorization | undefined;
  private engine: AuthorizationEngine = createScopeAuthorizationEngine();
  private orders: OrderDataAdapter | undefined;

  constructor(options: ConsumerIdentityRuntimeOptions) {
    this.workspaceId = options.workspaceId?.trim() || "local";
    this.dir = path.join(options.homeDir, "identity");
    this.settingsFile = path.join(this.dir, "settings.json");
    this.secrets = new ChannelSecretStore(options.secretsFile);
    this.allowLoopback = options.allowLoopback === true;
    this.fetcher = options.fetch;
  }

  /** Load saved settings and reopen the store when identity was enabled before the restart. */
  init(): void {
    if (!existsSync(this.settingsFile)) return;
    let parsed: Settings;
    try {
      parsed = settingsSchema.parse(JSON.parse(readFileSync(this.settingsFile, "utf8")));
    } catch {
      return;
    }
    this.settings = parsed;
    if (parsed.enabled) {
      try {
        this.open();
      } catch {
        this.settings = { ...parsed, enabled: false };
      }
    }
  }

  current(): ConsumerAuthorization | undefined {
    return this.settings.enabled ? this.authorization : undefined;
  }

  status(): IdentitySetupStatus {
    const orders = this.settings.orders;
    return {
      mode: "managed",
      enabled: this.settings.enabled,
      workspaceId: this.workspaceId,
      allowLoopback: this.allowLoopback,
      engine: this.settings.engine,
      orders: {
        configured: Boolean(orders),
        endpoint: orders?.endpoint ?? null,
        audience: orders?.audience ?? null,
        hasCredential: this.secrets.has(CREDENTIAL_SECRET),
        signingKey: this.publicSigningKey(),
      },
    };
  }

  enable(): IdentitySetupStatus {
    if (!this.settings.enabled) {
      this.open();
      this.save({ ...this.settings, enabled: true });
    }
    return this.status();
  }

  disable(): IdentitySetupStatus {
    if (this.settings.enabled) {
      this.save({ ...this.settings, enabled: false });
      this.close();
    }
    return this.status();
  }

  setEngine(choice: IdentityEngineChoice): IdentitySetupStatus {
    this.requireEnabled();
    const engine = this.buildEngine(choice);
    this.engine = engine;
    this.save({ ...this.settings, engine: choice });
    return this.status();
  }

  async testEngine(): Promise<EngineTestResult> {
    this.requireEnabled();
    const now = Date.now();
    const signal = AbortSignal.timeout(3_000);
    const order = (id: string, owner: string): OwnedResource => ({
      id, workspaceId: this.workspaceId, ownerAccountId: owner, assignedAccountIds: [], version: "1",
    });
    const check = (resource: OwnedResource) => this.engine.check({
      authority: previewAuthority(this.workspaceId, "engine-test-account", "own", null, now),
      action: "order:read", resource, policyRevision: POLICY_REVISION,
    }, signal).catch(() => false);
    const allowsOwn = await check(order("engine-test-own", "engine-test-account"));
    const allowsOther = await check(order("engine-test-other", "engine-test-someone-else"));
    if (!allowsOwn) return { ok: false, allowsOwn, deniesOther: !allowsOther, reason: "unreachable" };
    if (allowsOther) return { ok: false, allowsOwn, deniesOther: false, reason: "too_broad" };
    return { ok: true, allowsOwn, deniesOther: true, reason: "ok" };
  }

  async setOrders(input: OrdersSetupInput): Promise<IdentitySetupStatus> {
    this.requireEnabled();
    const endpoint = input.endpoint.trim();
    const audience = input.audience.trim();
    if (!endpoint || !audience || audience.length > 256) setupRequired();
    try {
      createOrderApiAdapter({
        endpoint, audience, credential: async () => "x", signContext: async () => "x", allowLoopback: this.allowLoopback,
      });
    } catch {
      setupRequired();
    }
    const credential = input.credential;
    if (credential !== undefined) {
      if (credential.length === 0 || credential.length > 4096 || /[\r\n\0]/.test(credential)) setupRequired();
    } else if (!this.secrets.has(CREDENTIAL_SECRET)) {
      setupRequired();
    }
    if (credential !== undefined) this.secrets.set(CREDENTIAL_SECRET, credential);
    if (!this.secrets.has(SIGNING_SECRET)) await this.generateSigningKey();
    this.save({ ...this.settings, orders: { endpoint, audience } });
    this.orders = this.buildOrders();
    return this.status();
  }

  clearOrders(): IdentitySetupStatus {
    this.requireEnabled();
    const { orders: _removed, ...rest } = this.settings;
    this.secrets.delete(CREDENTIAL_SECRET);
    this.secrets.delete(SIGNING_SECRET);
    this.save(rest);
    this.orders = undefined;
    return this.status();
  }

  async rotateSigningKey(): Promise<IdentitySetupStatus> {
    this.requireEnabled();
    await this.generateSigningKey();
    return this.status();
  }

  async testOrders(orderId: string): Promise<OrdersTestResult> {
    this.requireEnabled();
    const orders = this.settings.orders;
    if (!orders || !this.orders) return { ok: false, reason: "not_configured" };
    if (!this.secrets.has(CREDENTIAL_SECRET)) return { ok: false, reason: "no_credential" };
    const signing = this.publicSigningKey();
    if (!signing) return { ok: false, reason: "no_signing_key" };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) setupRequired();
    try {
      const resource = await this.orders.ownership(this.workspaceId, orderId, AbortSignal.timeout(3_000));
      const signingVerified = await this.verifiesOwnSignature(orders.audience, signing.publicJwk);
      return { ok: true, signingVerified, ownership: { version: resource.version, assignedAccounts: resource.assignedAccountIds.length } };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  close(): void {
    this.authorization = undefined;
    this.store?.close();
    this.store = undefined;
    this.orders = undefined;
  }

  private requireEnabled(): void {
    if (!this.settings.enabled || !this.authorization) setupRequired();
  }

  private open(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const store = new ConsumerIdentityStore(path.join(this.dir, "consumer-identity.db"), this.workspaceId);
    try {
      this.engine = this.buildEngine(this.settings.engine);
      this.orders = this.settings.orders && this.secrets.has(SIGNING_SECRET) ? this.buildOrders() : undefined;
      const engine: AuthorizationEngine = { check: (input, signal) => this.engine.check(input, signal) };
      const orders: OrderDataAdapter = {
        ownership: (workspaceId, orderId, signal) => this.requireOrders().ownership(workspaceId, orderId, signal),
        read: (authority, resource, signal) => this.requireOrders().read(authority, resource, signal),
      };
      this.authorization = new ConsumerAuthorization(store, engine, orders, POLICY_REVISION, this.allowLoopback);
      this.store = store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  private requireOrders(): OrderDataAdapter {
    if (!this.orders) throw new Error("order_unavailable");
    return this.orders;
  }

  private buildEngine(choice: IdentityEngineChoice): AuthorizationEngine {
    if (choice.kind === "scope") return createScopeAuthorizationEngine();
    try {
      return createCerbosAuthorizationEngine({ endpoint: choice.endpoint, allowLoopback: true, ...(this.fetcher ? { fetch: this.fetcher } : {}) });
    } catch {
      return setupRequired();
    }
  }

  private buildOrders(): OrderDataAdapter {
    const orders = this.settings.orders;
    if (!orders) setupRequired();
    return createOrderApiAdapter({
      endpoint: orders.endpoint,
      audience: orders.audience,
      credential: async () => this.secrets.get(CREDENTIAL_SECRET) ?? "",
      signContext: (claims) => this.signContext(claims),
      allowLoopback: this.allowLoopback,
      ...(this.fetcher ? { fetch: this.fetcher } : {}),
    });
  }

  private save(next: Settings): void {
    atomicWrite(this.settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
  }

  private privateSigningKey(): JWK | undefined {
    const raw = this.secrets.get(SIGNING_SECRET);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as JWK;
      return typeof parsed.kid === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private publicSigningKey(): { keyId: string; publicJwk: JWK } | null {
    const key = this.privateSigningKey();
    if (!key || !key.kid) return null;
    const { kty, crv, x, y, kid } = key;
    return { keyId: kid, publicJwk: { kty, crv, x, y, kid, alg: "ES256", use: "sig" } };
  }

  private async generateSigningKey(): Promise<void> {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(privateKey);
    this.secrets.set(SIGNING_SECRET, JSON.stringify({ ...jwk, kid: `ctx-${randomUUID().slice(0, 8)}`, alg: "ES256" }));
  }

  private async signContext(claims: Record<string, unknown>): Promise<string> {
    const jwk = this.privateSigningKey();
    if (!jwk?.kid) throw new Error("order_unavailable");
    const key = await importJWK(jwk, "ES256");
    return new SignJWT(claims as Record<string, never>)
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid, typ: CONTEXT_TYP })
      .sign(key);
  }

  private async verifiesOwnSignature(audience: string, publicJwk: JWK): Promise<boolean> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await this.signContext({ iss: "stageflow", aud: audience, sub: "signing-test", iat: now, exp: now + 30, jti: randomUUID() });
      await jwtVerify(token, await importJWK(publicJwk, "ES256"), { audience, algorithms: ["ES256"] });
      return true;
    } catch {
      return false;
    }
  }
}
