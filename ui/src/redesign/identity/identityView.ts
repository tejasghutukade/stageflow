import type {
  IdentityAssignment,
  IdentityAuditEvent,
  IdentityConnection,
  IdentityScope,
  SigningAlgorithm,
} from "../../api/identity";

export const PREVIEW_COPY = "Preview does not activate this assignment.";
export const FAILED_TEST_COPY = "A failed test does not replace the active connection.";
export const JWKS_WRITE_ONLY_COPY = "The public key set is write-only. It is not shown after you register.";
export const SECRET_WRITE_ONLY_COPY = "The client secret is sent only when you register or rotate. It is not shown again.";

export const IDENTITY_SCOPES: readonly IdentityScope[] = ["own", "assigned", "selected", "workspace"];
export const SIGNING_ALGORITHMS: readonly SigningAlgorithm[] = ["RS256", "ES256", "EdDSA"];

export type Tone = "ok" | "needs" | "fail" | "muted";
export type ConnectionKind = "handoff" | "oidc" | "service";

export const SCOPE_INFO: Record<IdentityScope, { label: string; summary: string; example: string; broad?: boolean }> = {
  own: {
    label: "Their own records",
    summary: "Sees only orders that belong to the account they are mapped to.",
    example: "A customer asking about their own orders.",
  },
  assigned: {
    label: "Assigned records",
    summary: "Sees orders where their account is on the order's assignment list.",
    example: "A support employee covering specific customers.",
  },
  selected: {
    label: "Specific records",
    summary: "Sees only the orders you list here, nothing else.",
    example: "A contractor handed three escalated orders.",
  },
  workspace: {
    label: "Everything in this workspace",
    summary: "Sees every order in this business. Never reaches another workspace.",
    example: "A supervisor who needs the full picture.",
    broad: true,
  },
};

export const KIND_INFO: Record<ConnectionKind, { label: string; title: string; blurb: string; bestFor: string }> = {
  handoff: {
    label: "Handoff",
    title: "Existing login handoff",
    blurb: "Your app already signs customers in. It vouches for them with a short-lived signed token when it opens the chat.",
    bestFor: "Agents embedded inside your own product.",
  },
  oidc: {
    label: "OIDC",
    title: "Sign in with your identity provider",
    blurb: "People sign in at Okta, Entra, Auth0, Google or any OpenID Connect provider. Passwords and MFA stay there.",
    bestFor: "Employees and customers who log in through a company directory.",
  },
  service: {
    label: "Service",
    title: "Service identity",
    blurb: "A fixed, explicitly scoped identity for agents that run on a schedule with nobody signed in.",
    bestFor: "Unattended runs such as nightly order reports.",
  },
};

export function connectionKind(kind: string): ConnectionKind {
  return kind === "oidc" || kind === "service" ? kind : "handoff";
}

export function oidcActivateReady(recordedTest: boolean): boolean {
  return recordedTest;
}

export function matchingAssignment(
  assignments: readonly IdentityAssignment[],
  connectionId: string,
  subject: string,
): IdentityAssignment | undefined {
  const id = connectionId.trim();
  const person = subject.trim();
  if (!id || !person) return undefined;
  return assignments.find((row) => row.connectionId === id && row.subject === person);
}

export function splitResourceList(value: string): string[] {
  return value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
}

export function previewWord(outcome: "allow" | "deny"): "Allow" | "Deny" {
  return outcome === "allow" ? "Allow" : "Deny";
}

export function identityConnectionLines(connection: IdentityConnection): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [
    { label: "Kind", value: connection.kind },
    { label: "Status", value: connection.status },
    { label: "Active", value: connection.active ? "Active" : "Inactive" },
    { label: "Issuer", value: connection.issuer },
  ];
  if (connection.callbackPath) lines.push({ label: "Callback", value: connection.callbackPath });
  if (connection.issuerChecks.length > 0) {
    lines.push({ label: "Issuer checks", value: connection.issuerChecks.join("\n") });
  }
  lines.push({ label: "Upstream revocation", value: connection.upstreamRevocation });
  if (connection.upstreamRevocation === "local_only") {
    lines.push({ label: "Upstream note", value: connection.upstreamNote });
  }
  return lines;
}

export function connectionStatus(connection: IdentityConnection): { tone: Tone; label: string; detail: string } {
  if (connection.active) return { tone: "ok", label: "Active", detail: "Accepting sign-ins" };
  if (connection.status === "disabled") return { tone: "muted", label: "Disabled", detail: "Sign-ins are refused" };
  if (connection.kind === "oidc") {
    if (connection.tested) return { tone: "needs", label: "Ready to go live", detail: "Test sign-in recorded" };
    if (connection.status === "validated") return { tone: "needs", label: "Needs a test sign-in", detail: "Provider reached" };
    return { tone: "needs", label: "Draft", detail: "Check the provider next" };
  }
  return { tone: "muted", label: "Inactive", detail: "Not accepting sign-ins" };
}

export type OidcStep = { id: "register" | "prepare" | "test" | "activate"; label: string; state: "done" | "current" | "todo" };

export function oidcSteps(connection: IdentityConnection, recordedTest = connection.tested): OidcStep[] {
  const prepared = connection.status === "validated" || connection.status === "active" || connection.active;
  const tested = recordedTest || connection.active;
  const live = connection.active;
  const order: Array<[OidcStep["id"], string, boolean]> = [
    ["register", "Registered", true],
    ["prepare", "Provider checked", prepared],
    ["test", "Test sign-in", tested],
    ["activate", "Live", live],
  ];
  let currentSet = false;
  return order.map(([id, label, done]) => {
    if (done) return { id, label, state: "done" };
    if (!currentSet) {
      currentSet = true;
      return { id, label, state: "current" };
    }
    return { id, label, state: "todo" };
  });
}

export type ReadinessStep = { id: string; label: string; detail: string; done: boolean };

export function readinessSteps(
  connections: readonly IdentityConnection[],
  assignments: readonly IdentityAssignment[],
  audit: readonly IdentityAuditEvent[],
): ReadinessStep[] {
  const liveConnections = connections.filter((row) => row.active);
  return [
    {
      id: "connect",
      label: "Connect a sign-in",
      detail: liveConnections.length > 0 ? `${liveConnections.length} live` : "Handoff, OIDC or service",
      done: liveConnections.length > 0,
    },
    {
      id: "people",
      label: "Give people access",
      detail: assignments.some((row) => row.active) ? `${assignments.filter((row) => row.active).length} mapped` : "Map a sign-in to an account",
      done: assignments.some((row) => row.active),
    },
    {
      id: "verify",
      label: "Check and watch",
      detail: audit.length > 0 ? `${audit.length} recent events` : "Run an access check",
      done: audit.length > 0,
    },
  ];
}

const ERROR_COPY: Record<string, { title: string; hint?: string }> = {
  "identity.setup_required": {
    title: "That request was not accepted.",
    hint: "A field is missing or invalid, or identity is not set up on this Host.",
  },
  "identity.conflict": {
    title: "Someone else changed this just now.",
    hint: "Reload to see the latest version, then try again.",
  },
  "identity.verification_required": {
    title: "A test sign-in is needed first.",
    hint: "Record a successful test sign-in before going live.",
  },
  "identity.not_available": { title: "That item is no longer available." },
  "identity.method_not_allowed": { title: "That action is not supported." },
  invalid_jwks: {
    title: "That is not a valid public key set.",
    hint: "Paste the JWKS JSON with a keys array.",
  },
  invalid_response: { title: "The Host sent a reply the console could not read." },
  request_failed: { title: "Could not reach the Host.", hint: "Check that it is running, then retry." },
  "identity.managed_externally": {
    title: "The app that runs this Host manages identity.",
    hint: "Change it there, not from the console.",
  },
  http_401: { title: "The Host needs its control token.", hint: "Sign in to the console again." },
  http_403: { title: "This console may not manage identity." },
};

export function errorCopy(code: string): { title: string; hint?: string; code: string } {
  return { ...(ERROR_COPY[code] ?? { title: "Something went wrong." }), code };
}

export function isSetupRequired(code: string | null): boolean {
  return code === "identity.setup_required";
}

const REASON_LABELS: Record<string, string> = {
  admitted: "Signed in",
  oidc_verified: "Signed in with OIDC",
  order_read: "Order read",
  permission_assigned: "Access saved",
  connection_registered: "Connection registered",
  connection_disabled: "Connection disabled",
  oidc_registered: "OIDC draft registered",
  oidc_activated: "OIDC went live",
  session_revoked: "Session revoked",
  principal_revoked: "Access revoked",
  connection_revoked: "Connection revoked",
  grant_revoked: "Grant revoked",
  not_owner: "Order belongs to someone else",
};

export function reasonLabel(reason: string): string {
  const known = REASON_LABELS[reason];
  if (known) return known;
  const readable = reason.replace(/^identity\./, "").replace(/[_.]+/g, " ").trim();
  return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : "Unknown";
}

export function parseEventTime(at: string): number | null {
  if (!at) return null;
  const numeric = /^\d+$/.test(at) ? Number(at) : Date.parse(at);
  return Number.isFinite(numeric) ? numeric : null;
}

export function relativeTime(at: string, now: number): string {
  const time = parseEventTime(at);
  if (time === null) return at || "—";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function absoluteTime(at: string): string {
  const time = parseEventTime(at);
  return time === null ? at : new Date(time).toISOString();
}

export function auditSummary(events: readonly IdentityAuditEvent[]): { allowed: number; denied: number } {
  const denied = events.filter((event) => event.outcome === "deny").length;
  return { allowed: events.length - denied, denied };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePublicJwks(text: string): { keys: Record<string, unknown>[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0 || !parsed.every(isPlainObject)) return null;
    return { keys: parsed };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length === 0 || !parsed.keys.every(isPlainObject)) {
    return null;
  }
  return { keys: parsed.keys };
}

export type JwksCheck =
  | { state: "empty" }
  | { state: "invalid" }
  | { state: "private" }
  | { state: "ok"; count: number };

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k"];

export function inspectJwks(text: string): JwksCheck {
  if (!text.trim()) return { state: "empty" };
  const parsed = parsePublicJwks(text);
  if (!parsed) return { state: "invalid" };
  if (parsed.keys.some((key) => PRIVATE_JWK_FIELDS.some((field) => field in key))) return { state: "private" };
  return { state: "ok", count: parsed.keys.length };
}

export function validClientSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 512 && !/[\r\n]/.test(value);
}

export function defaultRedirectUri(origin: string, webChatUrl: string | null | undefined): string {
  const slug = webChatUrl?.split("/").filter(Boolean).pop();
  return slug ? `${origin.replace(/\/$/, "")}/api/public/chat/${slug}/oidc/callback` : "";
}

export function initials(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? value).slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function validConnectionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export type AgentOption = { id: string; name: string; webChatUrl?: string | null };

export const ORDER_API_CONTRACT: Array<{ path: string; sends: string; returns: string }> = [
  {
    path: "POST /stageflow/order-ownership",
    sends: "{ workspaceId, orderId } with your credential",
    returns: "Metadata only: { id, workspaceId, ownerAccountId, assignedAccountIds, version }",
  },
  {
    path: "POST /stageflow/order-status",
    sends: "{ orderId, expectedVersion }, your credential and a signed Stageflow-Authorization token",
    returns: "{ ownership, receipt: { principalId, grantId }, status: { orderId, status, updatedAt } }",
  },
];

export function engineTestCopy(result: { ok: boolean; reason: "ok" | "unreachable" | "too_broad" }): { tone: Tone; title: string; hint: string } {
  if (result.ok) return { tone: "ok", title: "The policy engine answered correctly.", hint: "It allowed an order the person owns and refused someone else's." };
  if (result.reason === "too_broad") {
    return { tone: "fail", title: "The policy allows too much.", hint: "It allowed an order the person does not own. Access levels still apply, but fix the policy." };
  }
  return { tone: "fail", title: "The policy server did not answer.", hint: "Check the address, that it is running on this machine, and that the consumer_v1 policy is loaded." };
}

export function ordersTestCopy(result: { ok: boolean; reason?: string; signingVerified?: boolean; version?: string; assignedAccounts?: number }): { tone: Tone; title: string; hint: string } {
  if (result.ok) {
    return {
      tone: result.signingVerified === false ? "needs" : "ok",
      title: "Your order API answered the ownership call.",
      hint: `Version ${result.version ?? "?"}, ${result.assignedAccounts ?? 0} assigned ${result.assignedAccounts === 1 ? "account" : "accounts"}.${result.signingVerified === false ? " The signing key did not verify its own token." : ""}`,
    };
  }
  const reasons: Record<string, string> = {
    not_configured: "Save the order API settings first.",
    no_credential: "Add the credential your API expects.",
    no_signing_key: "Rotate the signing key to create one.",
    failed: "No valid ownership reply came back. Check the address, the credential, that the order exists, and that the reply matches the contract.",
  };
  return { tone: "fail", title: "The order API test failed.", hint: reasons[result.reason ?? "failed"] ?? reasons.failed! };
}

export function endpointProblem(value: string, allowLoopback: boolean): string | null {
  if (!value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full address, for example https://orders.example.com.";
  }
  if (url.username || url.password || url.search || url.hash) return "Leave out credentials, query strings and fragments.";
  if (url.protocol === "https:") return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && loopback && allowLoopback) return null;
  return url.protocol === "http:" && loopback
    ? "Plain http on this machine is only allowed for local testing (STAGEFLOW_IDENTITY_ALLOW_LOOPBACK=1)."
    : "Use an https address.";
}

export function cerbosEndpointProblem(value: string): string | null {
  if (!value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a full address, for example http://127.0.0.1:3592.";
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "The policy server must run on this machine.";
  if (url.search || url.hash || url.username || url.password) return "Leave out credentials, query strings and fragments.";
  return url.protocol === "http:" || url.protocol === "https:" ? null : "Use an http or https address.";
}
