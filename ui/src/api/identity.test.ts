import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHash } from "../routes";
import { railActiveId } from "../routeNav";
import {
  IdentityApiError,
  identityApi,
  projectIdentityAudit,
  projectIdentityConnection,
  projectIdentityPreview,
  type IdentityConnection,
} from "./identity";
import { IdentityPage } from "../redesign/identity/IdentityPage";
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

  it("renders the page without key material", () => {
    const html = renderToStaticMarkup(createElement(IdentityPage));
    expect(html).toContain(PREVIEW_COPY);
    expect(html).toContain(JWKS_WRITE_ONLY_COPY);
    expect(html).toContain(SECRET_WRITE_ONLY_COPY);
    expect(html).toContain(">Preview<");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("clientSecret");
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
