import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../routes";
import { railActiveId } from "../routeNav";
import {
  IdentityApiError,
  identityApi,
  projectIdentityAssignment,
  projectEngineTest,
  projectIdentityAudit,
  projectIdentitySetup,
  projectOrdersTest,
  projectIdentityConnection,
  projectIdentityPreview,
  type IdentityConnection,
} from "./identity";
import { IdentityPage } from "../redesign/identity/IdentityPage";
import { CheckAccessPanel } from "../redesign/identity/CheckAccessPanel";
import { SetupRequired } from "../redesign/identity/SetupRequired";
import {
  IdentityAuditTable,
  IdentityConnectionFacts,
  IdentityPreviewResult,
  OidcDraftActions,
} from "../redesign/identity/identityParts";
import { FAILED_TEST_COPY, JWKS_WRITE_ONLY_COPY, PREVIEW_COPY, SECRET_WRITE_ONLY_COPY, identityConnectionLines } from "../redesign/identity/identityView";

const SECRET = "sekret-value";

const connectionPayload = {
  id: "directory",
  kind: "oidc",
  active: false,
  status: "draft",
  callbackPath: "/api/public/chat/support/oidc/callback",
  issuer: "https://idp.example",
  issuerChecks: ["issuer origin"],
  upstreamRevocation: "local_only",
  upstreamNote: "Local revoke only. Do not rewrite this sentence.",
  clientSecret: SECRET,
  publicJwks: { keys: [{ d: SECRET, k: SECRET }] },
  secret: SECRET,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

describe("identity route", () => {
  it("opens /identity on the identity rail item", () => {
    expect(parseHash("#/identity")).toEqual({ name: "identity" });
    expect(railActiveId({ name: "identity" }, true)).toBe("identity");
  });

  it("renders the page shell without key material", () => {
    const html = renderToStaticMarkup(createElement(IdentityPage));
    expect(html).toContain("Identity");
    expect(html).toContain("Add connection");
    expect(html).toContain("People &amp; access");
    expect(html).toContain("Check access");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("clientSecret");
  });

  it("explains a preview without activating anything", () => {
    const html = renderToStaticMarkup(createElement(CheckAccessPanel, {
      workspaceId: "business-a",
      assignments: [{
        id: "a1",
        connectionId: "directory",
        subject: "sam",
        accountId: "acct_1",
        scope: "own",
        resources: [],
        agents: ["support"],
        revision: 1,
        active: true,
      }],
    }));
    expect(html).toContain(PREVIEW_COPY);
    expect(html).toContain(">Preview<");
    expect(html).not.toContain("Activate");
  });

  it("offers to turn identity on when the Host manages it", () => {
    const html = renderToStaticMarkup(createElement(SetupRequired, { mode: "managed", busy: false, onEnable: () => undefined, onRetry: () => undefined }));
    expect(html).toContain("Turn on identity for this Host");
    expect(html).toContain(">Turn on identity<");
    expect(html).toContain("docs/consumer-identity.md");
  });

  it("explains an embedded Host without offering a switch", () => {
    const html = renderToStaticMarkup(createElement(SetupRequired, { mode: "embedded", busy: false, onRetry: () => undefined }));
    expect(html).toContain("isn&#x27;t switched on");
    expect(html).toContain("consumerAuthorization");
    expect(html).not.toContain(">Turn on identity<");
  });

  it("keeps the write-only copy", () => {
    expect(JWKS_WRITE_ONLY_COPY).toContain("write-only");
    expect(SECRET_WRITE_ONLY_COPY).toContain("not shown again");
  });
});

describe("identity connection view", () => {
  it("drops secret fields so a connection payload is not rendered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ connections: [connectionPayload] })));
    const [connection] = await identityApi.connections();
    expect(connection).toEqual({
      id: "directory",
      kind: "oidc",
      active: false,
      status: "draft",
      callbackPath: "/api/public/chat/support/oidc/callback",
      issuer: "https://idp.example",
      issuerChecks: ["issuer origin"],
      upstreamRevocation: "local_only",
      upstreamNote: "Local revoke only. Do not rewrite this sentence.",
      agentId: "",
      audience: "",
      tested: false,
    });
    expect(JSON.stringify(connection)).not.toContain(SECRET);
    const dirty = { ...connection!, clientSecret: SECRET, publicJwks: { keys: [{ d: SECRET }] } } as IdentityConnection;
    expect(JSON.stringify(identityConnectionLines(dirty))).not.toContain(SECRET);
    const html = renderToStaticMarkup(createElement(IdentityConnectionFacts, { connection: dirty }));
    expect(html).not.toContain(SECRET);
    expect(html).toContain("Local revoke only. Do not rewrite this sentence.");
    expect(html).toContain("/api/public/chat/support/oidc/callback");
    expect(html).toContain("issuer origin");
  });

  it("sends a client secret on create and rotate and does not keep it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(connectionPayload));
    vi.stubGlobal("fetch", fetchMock);
    const created = await identityApi.registerOidc({
      id: "directory",
      issuer: "https://idp.example",
      clientId: "app",
      agentId: "support",
      clientSecret: SECRET,
      redirectUri: "https://chat.example/api/public/chat/support/oidc/callback",
      algorithms: ["RS256"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).clientSecret).toBe(SECRET);
    expect(JSON.stringify(created)).not.toContain(SECRET);
    const rotated = await identityApi.rotateOidc("directory", SECRET);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/identity/connections/directory/oidc/rotate");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ clientSecret: SECRET });
    expect(JSON.stringify(rotated)).not.toContain(SECRET);
  });

  it("shows only the error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "identity.setup_required", body: `<html>${SECRET}</html>`, message: SECRET }, false, 400)),
    );
    const error = await identityApi.connections().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(IdentityApiError);
    expect(error).toMatchObject({ code: "identity.setup_required", message: "identity.setup_required", status: 400 });
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });
});

describe("identity preview and audit", () => {
  it("keeps allow or deny and drops order contents", () => {
    expect(projectIdentityPreview({ outcome: "deny", order: { status: "shipped", note: SECRET }, reason: SECRET })).toEqual({ outcome: "deny" });
    expect(JSON.stringify(projectIdentityPreview({ outcome: "allow", receipt: { status: SECRET } }))).not.toContain(SECRET);
    const html = renderToStaticMarkup(createElement(IdentityPreviewResult, { outcome: "deny" }));
    expect(html).toContain("Deny");
    expect(html).not.toContain("Activate");
    expect(PREVIEW_COPY).toBe("Preview does not activate this assignment.");
  });

  it("renders only audit fields", () => {
    const event = projectIdentityAudit({
      at: "2026-10-30T12:00:00Z",
      principalId: "p1",
      conversationId: "c1",
      outcome: "deny",
      reason: "not_owner",
      order: { status: SECRET },
    });
    expect(event).toEqual({ at: "2026-10-30T12:00:00Z", principalId: "p1", conversationId: "c1", outcome: "deny", reason: "not_owner" });
    const html = renderToStaticMarkup(createElement(IdentityAuditTable, { events: [{ ...event, status: "shipped-private" } as typeof event] }));
    expect(html).toContain("not_owner");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("shipped-private");
  });

  it("asks for the latest fifty audit events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ audit: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await identityApi.audit();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/identity/audit?limit=50");
  });
});

describe("oidc activate", () => {
  it("stays disabled until a test is recorded for the draft", () => {
    const blocked = renderToStaticMarkup(createElement(OidcDraftActions, {
      recordedTest: false,
      busy: false,
      onPrepare: () => undefined,
      onRecordTest: () => undefined,
      onActivate: () => undefined,
    }));
    expect(blocked).toContain(FAILED_TEST_COPY);
    expect(blocked.match(/data-action="activate-oidc"[^>]*/)?.[0]).toContain("disabled");
    const ready = renderToStaticMarkup(createElement(OidcDraftActions, {
      recordedTest: true,
      busy: false,
      onPrepare: () => undefined,
      onRecordTest: () => undefined,
      onActivate: () => undefined,
    }));
    expect(ready.match(/data-action="activate-oidc"[^>]*/)?.[0]).not.toContain("disabled");
  });
});

describe("assignment save", () => {
  it("sends the loaded revision and returns the new one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: "a1",
      connectionId: "directory",
      subject: "sam",
      accountId: "acct",
      scope: "own",
      resources: [],
      revision: 4,
      active: true,
      clientSecret: SECRET,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = await identityApi.saveAssignment({
      connectionId: "directory",
      subject: "sam",
      accountId: "acct",
      scope: "own",
      resources: [],
      agents: ["support"],
      expectedRevision: 3,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).expectedRevision).toBe(3);
    expect(saved.revision).toBe(4);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });
});

describe("projectIdentityConnection", () => {
  it("keeps a local-only note unchanged", () => {
    const note = "  exact note\nsecond line";
    expect(projectIdentityConnection({ ...connectionPayload, upstreamNote: note }).upstreamNote).toBe(note);
  });
});

describe("requests match the Host routes", () => {
  it("sends a preview as an order object and reads the allow flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ allow: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await identityApi.preview({
      accountId: "acct_1",
      scope: "selected",
      resources: ["ord_1"],
      order: { id: "ord_1", workspaceId: "business-a", ownerAccountId: "acct_2", assignedAccountIds: [], version: "3" },
    });
    expect(result).toEqual({ outcome: "deny" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/identity/preview");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      accountId: "acct_1",
      scope: "selected",
      resources: ["ord_1"],
      order: { id: "ord_1", workspaceId: "business-a", ownerAccountId: "acct_2", assignedAccountIds: [], version: "3" },
    });
  });

  it("sends a revocation source as url and null clears it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(connectionPayload));
    vi.stubGlobal("fetch", fetchMock);
    await identityApi.setRevocationSource("directory", "https://idp.example/revoked");
    await identityApi.setRevocationSource("directory", null);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/identity/connections/directory/revocation-source");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ url: "https://idp.example/revoked" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toEqual({ url: null });
  });

  it("registers a service identity with an account, scope and agents", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "nightly", kind: "service", active: true, status: "active" }));
    vi.stubGlobal("fetch", fetchMock);
    await identityApi.registerService({ id: "nightly", accountId: "acct_reports", scope: "workspace", agents: ["support"], resources: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      id: "nightly",
      accountId: "acct_reports",
      scope: "workspace",
      agents: ["support"],
      resources: [],
    });
  });

  it("keeps the workspace id from the connection list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ workspaceId: "business-a", connections: [connectionPayload] })));
    const overview = await identityApi.overview();
    expect(overview.workspaceId).toBe("business-a");
    expect(overview.connections).toHaveLength(1);
  });

  it("keeps the agents on an assignment", () => {
    const row = projectIdentityAssignment({ id: "a1", connectionId: "c", subject: "s", accountId: "a", scope: "own", resources: null, agents: ["support", 4], revision: 1, active: true });
    expect(row?.agents).toEqual(["support"]);
  });
});

describe("setup client", () => {
  const status = {
    mode: "managed",
    enabled: true,
    workspaceId: "local",
    allowLoopback: false,
    engine: { kind: "cerbos", endpoint: "http://127.0.0.1:3592", token: SECRET },
    orders: {
      configured: true,
      endpoint: "https://orders.example",
      audience: "orders-api",
      hasCredential: true,
      credential: SECRET,
      signingKey: { keyId: "ctx-1", publicJwk: { kty: "EC", x: "a", y: "b", d: SECRET, n: 5 }, private: SECRET },
    },
  };

  it("keeps only the public parts of the setup status", () => {
    const projected = projectIdentitySetup(status);
    expect(projected).toEqual({
      mode: "managed",
      enabled: true,
      workspaceId: "local",
      allowLoopback: false,
      engine: { kind: "cerbos", endpoint: "http://127.0.0.1:3592" },
      orders: {
        configured: true,
        endpoint: "https://orders.example",
        audience: "orders-api",
        hasCredential: true,
        signingKey: { keyId: "ctx-1", publicJwk: { kty: "EC", x: "a", y: "b" } },
      },
    });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
  });

  it("falls back to an off, built-in setup for an unknown reply", () => {
    expect(projectIdentitySetup({})).toMatchObject({ mode: "managed", enabled: false, engine: { kind: "scope" }, orders: { configured: false, signingKey: null } });
    expect(projectIdentitySetup({ mode: "embedded", enabled: true }).mode).toBe("embedded");
  });

  it("posts each setup action to its route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status));
    vi.stubGlobal("fetch", fetchMock);
    await identityApi.setup();
    await identityApi.enableIdentity();
    await identityApi.setEngine({ kind: "cerbos", endpoint: "http://127.0.0.1:3592" });
    await identityApi.saveOrders({ endpoint: "https://orders.example", audience: "orders-api", credential: SECRET });
    await identityApi.rotateSigningKey();
    await identityApi.clearOrders();
    await identityApi.disableIdentity();
    const calls = fetchMock.mock.calls.map((call) => [call[0], call[1]?.method ?? "GET"]);
    expect(calls).toEqual([
      ["/api/identity/setup", "GET"],
      ["/api/identity/setup/enable", "POST"],
      ["/api/identity/setup/engine", "POST"],
      ["/api/identity/setup/orders", "POST"],
      ["/api/identity/setup/orders/signing-key", "POST"],
      ["/api/identity/setup/orders/clear", "POST"],
      ["/api/identity/setup/disable", "POST"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1].body))).toEqual({ endpoint: "https://orders.example", audience: "orders-api", credential: SECRET });
  });

  it("reads test results without keeping anything else", async () => {
    expect(projectEngineTest({ ok: false, reason: "too_broad", allowsOwn: true })).toEqual({ ok: false, reason: "too_broad" });
    expect(projectEngineTest({ ok: true, reason: "ok" })).toEqual({ ok: true, reason: "ok" });
    expect(projectOrdersTest({ ok: true, signingVerified: true, ownership: { version: "v1", assignedAccounts: 2, ownerAccountId: SECRET } }))
      .toEqual({ ok: true, signingVerified: true, version: "v1", assignedAccounts: 2 });
    expect(projectOrdersTest({ ok: false, reason: "no_credential", detail: SECRET })).toEqual({ ok: false, reason: "no_credential" });
    expect(projectOrdersTest({ ok: false, reason: "surprise" })).toEqual({ ok: false, reason: "failed" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: false, reason: "failed" }));
    vi.stubGlobal("fetch", fetchMock);
    await identityApi.testOrders("ord_1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/identity/setup/orders/test");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ orderId: "ord_1" });
  });
});
