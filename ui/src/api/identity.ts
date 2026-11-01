import { authorizationHeaders, notifyControlTokenRequired } from "./controlToken";

export type IdentityScope = "own" | "assigned" | "selected" | "workspace";
export type UpstreamRevocation = "connected" | "local_only";
export type SigningAlgorithm = "RS256" | "ES256" | "EdDSA";

export type IdentityConnection = {
  id: string;
  kind: string;
  active: boolean;
  status: string;
  callbackPath: string;
  issuer: string;
  issuerChecks: string[];
  upstreamRevocation: UpstreamRevocation;
  upstreamNote: string;
  agentId: string;
  audience: string;
  tested: boolean;
};

export type IdentityOverview = { workspaceId: string; connections: IdentityConnection[] };

export type IdentityAssignment = {
  id: string;
  connectionId: string;
  subject: string;
  accountId: string;
  scope: IdentityScope;
  resources: string[];
  agents: string[];
  revision: number;
  active: boolean;
};

export type IdentityAuditEvent = {
  at: string;
  principalId: string;
  conversationId: string;
  outcome: string;
  reason: string;
};

export type IdentityPreview = { outcome: "allow" | "deny" };

export type HandoffConnectionInput = {
  id: string;
  issuer: string;
  agentId: string;
  audience: string;
  algorithms: SigningAlgorithm[];
  publicJwks: { keys: Record<string, unknown>[] };
};

export type OidcConnectionInput = {
  id: string;
  issuer: string;
  clientId: string;
  agentId: string;
  clientSecret: string;
  redirectUri: string;
  algorithms: SigningAlgorithm[];
};

export type AssignmentInput = {
  connectionId: string;
  subject: string;
  accountId: string;
  scope: IdentityScope;
  resources: string[];
  agents: string[];
  expectedRevision?: number;
};

export type PreviewInput = {
  accountId: string;
  scope: IdentityScope;
  resources: string[];
  order: {
    id: string;
    workspaceId: string;
    ownerAccountId: string;
    assignedAccountIds: string[];
    version: string;
  };
};

export type ServiceConnectionInput = {
  id: string;
  accountId: string;
  scope: IdentityScope;
  agents: string[];
  resources: string[];
};

export type IdentityEngineChoice = { kind: "scope" } | { kind: "cerbos"; endpoint: string };

export type IdentitySetupStatus = {
  mode: "managed" | "embedded";
  enabled: boolean;
  workspaceId: string;
  allowLoopback: boolean;
  engine: IdentityEngineChoice;
  orders: {
    configured: boolean;
    endpoint: string;
    audience: string;
    hasCredential: boolean;
    signingKey: { keyId: string; publicJwk: Record<string, string> } | null;
  };
};

export type EngineTestResult = { ok: boolean; reason: "ok" | "unreachable" | "too_broad" };
export type OrdersTestResult =
  | { ok: true; signingVerified: boolean; version: string; assignedAccounts: number }
  | { ok: false; reason: "not_configured" | "no_credential" | "no_signing_key" | "failed" };

export type OrdersSetupInput = { endpoint: string; audience: string; credential?: string };

const SCOPES = new Set<string>(["own", "assigned", "selected", "workspace"]);

export class IdentityApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "IdentityApiError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function projectIdentityConnection(value: unknown): IdentityConnection {
  const raw = asRecord(value);
  return {
    id: text(raw.id),
    kind: text(raw.kind),
    active: raw.active === true,
    status: text(raw.status),
    callbackPath: text(raw.callbackPath),
    issuer: text(raw.issuer),
    issuerChecks: stringList(raw.issuerChecks),
    upstreamRevocation: raw.upstreamRevocation === "local_only" ? "local_only" : "connected",
    upstreamNote: text(raw.upstreamNote),
    agentId: text(raw.agentId),
    audience: text(raw.audience),
    tested: raw.tested === true,
  };
}

export function projectIdentityAssignment(value: unknown): IdentityAssignment | null {
  const raw = asRecord(value);
  const scope = raw.scope;
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision)) return null;
  if (typeof scope !== "string" || !SCOPES.has(scope)) return null;
  return {
    id: text(raw.id),
    connectionId: text(raw.connectionId),
    subject: text(raw.subject),
    accountId: text(raw.accountId),
    scope: scope as IdentityScope,
    resources: stringList(raw.resources),
    agents: stringList(raw.agents),
    revision: raw.revision,
    active: raw.active === true,
  };
}

export function projectIdentityAudit(value: unknown): IdentityAuditEvent {
  const raw = asRecord(value);
  return {
    at: typeof raw.at === "number" && Number.isFinite(raw.at) ? String(raw.at) : text(raw.at),
    principalId: text(raw.principalId),
    conversationId: text(raw.conversationId),
    outcome: text(raw.outcome),
    reason: text(raw.reason),
  };
}

export function projectIdentityPreview(value: unknown): IdentityPreview {
  const raw = asRecord(value);
  if (typeof raw.allow === "boolean") return { outcome: raw.allow ? "allow" : "deny" };
  const outcome = raw.outcome;
  if (outcome !== "allow" && outcome !== "deny") throw new IdentityApiError("identity.preview_invalid", 200);
  return { outcome };
}

const PUBLIC_JWK_FIELDS = ["kty", "crv", "x", "y", "kid", "alg", "use"] as const;

function publicJwk(value: unknown): Record<string, string> {
  const raw = asRecord(value);
  return Object.fromEntries(
    PUBLIC_JWK_FIELDS.flatMap((field) => (typeof raw[field] === "string" ? [[field, raw[field] as string]] : [])),
  );
}

export function projectIdentitySetup(value: unknown): IdentitySetupStatus {
  const raw = asRecord(value);
  const engine = asRecord(raw.engine);
  const orders = asRecord(raw.orders);
  const key = asRecord(orders.signingKey);
  return {
    mode: raw.mode === "embedded" ? "embedded" : "managed",
    enabled: raw.enabled === true,
    workspaceId: text(raw.workspaceId),
    allowLoopback: raw.allowLoopback === true,
    engine: engine.kind === "cerbos" ? { kind: "cerbos", endpoint: text(engine.endpoint) } : { kind: "scope" },
    orders: {
      configured: orders.configured === true,
      endpoint: text(orders.endpoint),
      audience: text(orders.audience),
      hasCredential: orders.hasCredential === true,
      signingKey: typeof key.keyId === "string" ? { keyId: key.keyId, publicJwk: publicJwk(key.publicJwk) } : null,
    },
  };
}

export function projectEngineTest(value: unknown): EngineTestResult {
  const raw = asRecord(value);
  const reason = raw.reason === "unreachable" || raw.reason === "too_broad" ? raw.reason : "ok";
  return { ok: raw.ok === true && reason === "ok", reason };
}

export function projectOrdersTest(value: unknown): OrdersTestResult {
  const raw = asRecord(value);
  if (raw.ok === true) {
    const ownership = asRecord(raw.ownership);
    return {
      ok: true,
      signingVerified: raw.signingVerified === true,
      version: text(ownership.version),
      assignedAccounts: typeof ownership.assignedAccounts === "number" ? ownership.assignedAccounts : 0,
    };
  }
  const reason = raw.reason;
  return { ok: false, reason: reason === "not_configured" || reason === "no_credential" || reason === "no_signing_key" ? reason : "failed" };
}

function list(body: unknown, key: string): unknown[] {
  const value = asRecord(body)[key];
  return Array.isArray(value) ? value : [];
}

function nested(body: unknown, key: string): unknown {
  const value = asRecord(body)[key];
  if (value !== null && typeof value === "object") return value;
  return body;
}

async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...authorizationHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) notifyControlTokenRequired();
  const parsed = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (!res.ok) {
    const code = typeof parsed.code === "string" && parsed.code.trim() ? parsed.code : `http_${res.status}`;
    throw new IdentityApiError(code, res.status);
  }
  return parsed;
}

const enc = encodeURIComponent;
const connectionUrl = (id: string, tail = "") => `/api/identity/connections/${enc(id)}${tail}`;

async function connectionResult(path: string, method = "POST", body?: unknown): Promise<IdentityConnection> {
  return projectIdentityConnection(nested(await request(path, method, body), "connection"));
}

export const identityApi = {
  overview: async (): Promise<IdentityOverview> => {
    const body = await request("/api/identity/connections");
    return {
      workspaceId: text(asRecord(body).workspaceId),
      connections: list(body, "connections").map(projectIdentityConnection),
    };
  },
  connections: async (): Promise<IdentityConnection[]> => {
    const body = await request("/api/identity/connections");
    return list(body, "connections").map(projectIdentityConnection);
  },
  registerHandoff: (input: HandoffConnectionInput) => connectionResult("/api/identity/connections/handoff", "POST", input),
  disable: (id: string) => connectionResult(connectionUrl(id, "/disable")),
  assignments: async (): Promise<IdentityAssignment[]> => {
    const body = await request("/api/identity/assignments");
    return list(body, "assignments").flatMap((row) => {
      const projected = projectIdentityAssignment(row);
      return projected ? [projected] : [];
    });
  },
  saveAssignment: async (input: AssignmentInput): Promise<IdentityAssignment> => {
    const projected = projectIdentityAssignment(nested(await request("/api/identity/assignments", "POST", input), "assignment"));
    if (!projected) throw new IdentityApiError("invalid_response", 200);
    return projected;
  },
  revokeAssignment: async (id: string): Promise<void> => {
    await request(`/api/identity/assignments/${enc(id)}/revoke`, "POST");
  },
  preview: async (input: PreviewInput): Promise<IdentityPreview> => {
    return projectIdentityPreview(nested(await request("/api/identity/preview", "POST", input), "preview"));
  },
  audit: async (limit = 50): Promise<IdentityAuditEvent[]> => {
    const body = await request(`/api/identity/audit?limit=${enc(String(limit))}`);
    return list(body, "audit").map(projectIdentityAudit);
  },
  registerOidc: (input: OidcConnectionInput) => connectionResult("/api/identity/connections/oidc", "POST", input),
  prepareOidc: (id: string) => connectionResult(connectionUrl(id, "/oidc/prepare")),
  recordOidcTest: (id: string) => connectionResult(connectionUrl(id, "/oidc/tested")),
  activateOidc: (id: string) => connectionResult(connectionUrl(id, "/oidc/activate")),
  rotateOidc: (id: string, clientSecret: string) => connectionResult(connectionUrl(id, "/oidc/rotate"), "POST", { clientSecret }),
  setup: async (): Promise<IdentitySetupStatus> => projectIdentitySetup(await request("/api/identity/setup")),
  enableIdentity: async (): Promise<IdentitySetupStatus> => projectIdentitySetup(await request("/api/identity/setup/enable", "POST")),
  disableIdentity: async (): Promise<IdentitySetupStatus> => projectIdentitySetup(await request("/api/identity/setup/disable", "POST")),
  setEngine: async (choice: IdentityEngineChoice) => projectIdentitySetup(await request("/api/identity/setup/engine", "POST", choice)),
  testEngine: async () => projectEngineTest(await request("/api/identity/setup/engine/test", "POST")),
  saveOrders: async (input: OrdersSetupInput) => projectIdentitySetup(await request("/api/identity/setup/orders", "POST", input)),
  clearOrders: async () => projectIdentitySetup(await request("/api/identity/setup/orders/clear", "POST")),
  rotateSigningKey: async () => projectIdentitySetup(await request("/api/identity/setup/orders/signing-key", "POST")),
  testOrders: async (orderId: string) => projectOrdersTest(await request("/api/identity/setup/orders/test", "POST", { orderId })),
  registerService: (input: ServiceConnectionInput) => connectionResult("/api/identity/connections/service", "POST", input),
  setRevocationSource: (id: string, url: string | null) => connectionResult(connectionUrl(id, "/revocation-source"), "POST", { url }),
};
