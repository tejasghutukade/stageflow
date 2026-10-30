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
};

export type IdentityAssignment = {
  id: string;
  connectionId: string;
  subject: string;
  accountId: string;
  scope: IdentityScope;
  resources: string[];
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
};

export type AssignmentInput = {
  connectionId: string;
  subject: string;
  accountId: string;
  scope: IdentityScope;
  resources: string[];
  expectedRevision?: number;
};

export type PreviewInput = {
  connectionId: string;
  subject: string;
  accountId: string;
  scope: IdentityScope;
  resources: string[];
  orderId: string;
  owner: string;
  version: string;
};

export type ServiceConnectionInput = {
  id: string;
  agentId: string;
};

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
  const outcome = raw.outcome;
  if (outcome !== "allow" && outcome !== "deny") throw new IdentityApiError("identity.preview_invalid", 200);
  return { outcome };
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
  registerService: (input: ServiceConnectionInput) => connectionResult("/api/identity/connections/service", "POST", input),
  setRevocationSource: (id: string, source: string) => connectionResult(connectionUrl(id, "/revocation-source"), "POST", { source }),
};
