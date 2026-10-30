import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import type { ConsumerScope, OwnedResource } from "../src/identity/types.js";
import { handleIdentityRoutes } from "../src/server/identityRoutes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ORDER: OwnedResource = {
  id: "alice-order",
  workspaceId: "business-a",
  ownerAccountId: "alice",
  assignedAccountIds: ["supporter"],
  version: "v1",
};
const SECRET = "c".repeat(24);
const NEXT_SECRET = "n".repeat(24);
const STATUS = "private-shipped-status";
const BEARER = "Bearer leak-token-value";

type Reply = { handled: boolean; status: number; body: Record<string, any> };
type Assignment = { id: string; connectionId: string; subject: string; accountId: string; scope: string; resources?: string[] | null; revision: number; active: boolean };
type Connection = { id: string; kind: string; active: boolean; status: string; callbackPath?: string; issuer?: string; issuerChecks?: unknown; upstreamRevocation?: unknown; upstreamNote?: string };

async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), "sf-identity-operator-"));
  const store = new ConsumerIdentityStore(path.join(home, "consumers.sqlite"), "business-a");
  const records = new Map<string, OwnedResource>([[ORDER.id, ORDER]]);
  let ownershipReads = 0;
  let payloadReads = 0;
  const engine = createScopeAuthorizationEngine();
  const authorization = new ConsumerAuthorization(store, engine, {
    ownership: async (_workspace, id) => {
      ownershipReads += 1;
      const record = records.get(id);
      if (!record) throw new Error("not found");
      return structuredClone(record);
    },
    read: async (_authority, resource) => {
      payloadReads += 1;
      return { orderId: resource.id, status: STATUS, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  }, "consumer_v1");
  cleanups.push(async () => { store.close(); await rm(home, { recursive: true, force: true }); });

  const call = async (method: string, target: string, payload?: unknown): Promise<Reply> => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]) as IncomingMessage;
    req.method = method;
    req.url = target;
    const url = new URL(target, "http://identity");
    let status = 0;
    let body: Record<string, any> = {};
    const handled = await handleIdentityRoutes(req, method, url.pathname, url, authorization, {} as ServerResponse, (_res, code, value) => {
      status = code;
      body = (value ?? {}) as Record<string, any>;
    });
    return { handled, status, body };
  };

  return {
    store,
    call,
    ownershipReads: () => ownershipReads,
    payloadReads: () => payloadReads,
  };
}

function handoffBody(id: string, keys: Record<string, unknown>[]) {
  return {
    id,
    issuer: "https://business.example",
    agentId: "support",
    audience: "stageflow:business-a:support",
    publicJwks: { keys },
    algorithms: ["ES256"],
  };
}

function oidcBody(id: string, clientSecret: string) {
  return {
    id,
    issuer: "https://idp.example",
    clientId: "orders-app",
    agentId: "support",
    redirectUri: "https://chat.example/api/public/chat/support/oidc/callback",
    algorithms: ["ES256"],
    clientSecret,
  };
}

function assignmentBody(subject: string, scope: ConsumerScope, resources?: string[], expectedRevision?: number) {
  return {
    connectionId: "app",
    subject,
    accountId: subject,
    scope,
    agents: ["support"],
    mappingSource: "operator",
    ...(resources ? { resources } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function assignmentsOf(body: Record<string, any>): Assignment[] {
  return body.assignments as Assignment[];
}

function connectionsOf(body: Record<string, any>): Connection[] {
  return body.connections as Connection[];
}

describe("operator identity routes", () => {
  it("registers a public handoff and rejects a JWKS private key", async () => {
    const { store, call } = await harness();
    const { publicKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const privateMaterial = "private-key-material";
    const rejected = await call("POST", "/api/identity/connections/handoff", handoffBody("private", [{ ...publicJwk, d: privateMaterial, kid: "leaked" }]));
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ code: "identity.setup_required" });
    expect(JSON.stringify(rejected.body)).not.toContain(privateMaterial);

    const registered = await call("POST", "/api/identity/connections/handoff", handoffBody("app", [{ ...publicJwk, kid: "app-key" }]));
    expect(registered.handled).toBe(true);
    expect(registered.status).toBe(201);
    const registeredText = JSON.stringify(registered.body);
    expect(registeredText).not.toContain(privateMaterial);
    expect(registeredText).not.toMatch(/"d"\s*:/);
    expect(registeredText).not.toMatch(/"k"\s*:/);
    expect(registered.body.id).toBe("app");

    const listed = await call("GET", "/api/identity/connections");
    expect(listed.status).toBe(200);
    expect(connectionsOf(listed.body)).toEqual(store.listConnections());
    for (const row of connectionsOf(listed.body)) {
      const stored = store.listConnections().find((item) => item.id === row.id);
      expect(row.upstreamNote).toBe(stored?.upstreamNote);
    }

    expect(connectionsOf((await call("GET", "/api/identity/connections")).body).some((row) => row.id === "private")).toBe(false);
  });

  it("assigns each scope, previews without writing, then records the assignment", async () => {
    const { call, ownershipReads, payloadReads } = await harness();
    const { publicKey } = await generateKeyPair("ES256");
    expect((await call("POST", "/api/identity/connections/handoff", handoffBody("app", [await exportJWK(publicKey)]))).status).toBe(201);
    const before = structuredClone(assignmentsOf((await call("GET", "/api/identity/assignments")).body));

    const previews: Array<{ accountId: string; scope: ConsumerScope; resources?: string[]; order?: OwnedResource; allow: boolean }> = [
      { accountId: "alice", scope: "own", allow: true },
      { accountId: "bob", scope: "own", allow: false },
      { accountId: "supporter", scope: "assigned", allow: true },
      { accountId: "bob", scope: "assigned", allow: false },
      { accountId: "selected", scope: "selected", resources: ["alice-order"], allow: true },
      { accountId: "selected", scope: "selected", resources: ["other-order"], allow: false },
      { accountId: "supervisor", scope: "workspace", allow: true },
      { accountId: "supervisor", scope: "workspace", order: { ...ORDER, id: "other", workspaceId: "other-business" }, allow: false },
    ];
    for (const preview of previews) {
      const response = await call("POST", "/api/identity/preview", {
        accountId: preview.accountId,
        scope: preview.scope,
        ...(preview.resources ? { resources: preview.resources } : {}),
        order: { ...(preview.order ?? ORDER), status: STATUS, authorization: BEARER },
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ allow: preview.allow });
    }
    expect(assignmentsOf((await call("GET", "/api/identity/assignments")).body)).toEqual(before);
    expect(ownershipReads()).toBe(0);
    expect(payloadReads()).toBe(0);

    for (const scope of ["own", "assigned", "selected", "workspace"] as const) {
      const created = await call("POST", "/api/identity/assignments", assignmentBody(scope, scope, scope === "selected" ? ["alice-order"] : undefined));
      expect(created.status).toBe(201);
      expect(created.body.scope).toBe(scope);
      expect(created.body.revision).toBe(1);
    }
    const after = assignmentsOf((await call("GET", "/api/identity/assignments")).body);
    expect(after.map((row) => row.scope).sort()).toEqual(["assigned", "own", "selected", "workspace"]);
    expect(after.find((row) => row.scope === "selected")?.resources).toEqual(["alice-order"]);
    expect(after).not.toEqual(before);
    const frozen = structuredClone(after);
    expect((await call("POST", "/api/identity/preview", { accountId: "alice", scope: "own", order: ORDER })).body).toEqual({ allow: true });
    expect(assignmentsOf((await call("GET", "/api/identity/assignments")).body)).toEqual(frozen);
  });

  it("rejects a stale assignment revision and leaves the previous revision in place", async () => {
    const { call } = await harness();
    const { publicKey } = await generateKeyPair("ES256");
    expect((await call("POST", "/api/identity/connections/handoff", handoffBody("app", [await exportJWK(publicKey)]))).status).toBe(201);
    const created = await call("POST", "/api/identity/assignments", assignmentBody("alice", "own"));
    expect(created.status).toBe(201);
    const revision = created.body.revision as number;
    const conflict = await call("POST", "/api/identity/assignments", assignmentBody("alice", "workspace", undefined, revision - 1));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ code: "identity.conflict" });
    const row = assignmentsOf((await call("GET", "/api/identity/assignments")).body).find((item) => item.subject === "alice");
    expect(row?.revision).toBe(revision);
    expect(row?.scope).toBe("own");
  });

  it("revokes a principal", async () => {
    const { call } = await harness();
    const { publicKey } = await generateKeyPair("ES256");
    expect((await call("POST", "/api/identity/connections/handoff", handoffBody("app", [await exportJWK(publicKey)]))).status).toBe(201);
    const created = await call("POST", "/api/identity/assignments", assignmentBody("alice", "own"));
    const revoked = await call("POST", `/api/identity/assignments/${created.body.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.active).toBe(false);
    const row = assignmentsOf((await call("GET", "/api/identity/assignments")).body).find((item) => item.id === created.body.id);
    expect(row?.active).toBe(false);
  });

  it("lists audit without order status, bearers, or client secrets", async () => {
    const { call } = await harness();
    const registered = await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET));
    expect(registered.status).toBe(201);
    const { publicKey } = await generateKeyPair("ES256");
    expect((await call("POST", "/api/identity/connections/handoff", handoffBody("app", [await exportJWK(publicKey)]))).status).toBe(201);
    expect((await call("POST", "/api/identity/assignments", assignmentBody("alice", "own"))).status).toBe(201);
    expect((await call("POST", "/api/identity/preview", {
      accountId: "alice",
      scope: "own",
      order: { ...ORDER, status: STATUS },
      authorization: BEARER,
    })).status).toBe(200);
    const audit = await call("GET", "/api/identity/audit?limit=50");
    expect(audit.status).toBe(200);
    expect(Array.isArray(audit.body.audit)).toBe(true);
    expect(audit.body.audit.length).toBeGreaterThan(0);
    const text = JSON.stringify(audit.body);
    expect(text).not.toContain(STATUS);
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain(SECRET);
  });

  it("registers oidc without returning the client secret", async () => {
    const { store, call } = await harness();
    const registered = await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET));
    expect(registered.status).toBe(201);
    expect(registered.body.clientSecret).toBeUndefined();
    expect(registered.body.secret).toBeUndefined();
    expect(JSON.stringify(registered.body)).not.toContain(SECRET);
    const listedConnection = store.listConnections().find((row) => row.id === "directory");
    expect(registered.body.callbackPath).toBe(listedConnection?.callbackPath);
    expect(registered.body.issuerChecks).toEqual(listedConnection?.issuerChecks);
    expect(JSON.stringify(store.oidcSetup("directory"))).not.toContain(SECRET);
    const listed = await call("GET", "/api/identity/connections");
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);
    expect(JSON.stringify(store.listConnections())).not.toContain(SECRET);
    expect(store.oidcClientSecret("directory")).toBe(SECRET);
  });

  it("refuses activation until a test sign-in is recorded", async () => {
    const { store, call } = await harness();
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET))).status).toBe(201);
    store.markOidcValidated("directory");
    const activate = await call("POST", "/api/identity/connections/directory/oidc/activate");
    expect(activate.status).toBe(409);
    expect(activate.body).toEqual({ code: "identity.verification_required" });
    const row = connectionsOf((await call("GET", "/api/identity/connections")).body).find((item) => item.id === "directory");
    expect(row?.active).toBe(false);
    expect(row?.status).not.toBe("active");
  });

  it("activates after a recorded test on a validated connection", async () => {
    const { store, call } = await harness();
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET))).status).toBe(201);
    store.markOidcValidated("directory");
    expect((await call("POST", "/api/identity/connections/directory/oidc/tested")).status).toBe(200);
    const activate = await call("POST", "/api/identity/connections/directory/oidc/activate");
    expect(activate.status).toBe(200);
    expect(JSON.stringify(activate.body)).not.toContain(SECRET);
    const row = connectionsOf((await call("GET", "/api/identity/connections")).body).find((item) => item.id === "directory");
    expect(row?.active).toBe(true);
    expect(row?.status).toBe("active");
  });

  it("rotates the client secret without moving an existing principal revision", async () => {
    const { store, call } = await harness();
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET))).status).toBe(201);
    const created = await call("POST", "/api/identity/assignments", {
      connectionId: "directory",
      subject: "alice",
      accountId: "alice",
      scope: "own",
      agents: ["support"],
      mappingSource: "operator",
    });
    expect(created.status).toBe(201);
    const revision = created.body.revision as number;
    const rotated = await call("POST", "/api/identity/connections/directory/oidc/rotate", { clientSecret: NEXT_SECRET });
    expect(rotated.status).toBe(200);
    const text = JSON.stringify(rotated.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(NEXT_SECRET);
    expect(store.oidcClientSecret("directory")).toBe(NEXT_SECRET);
    const row = assignmentsOf((await call("GET", "/api/identity/assignments")).body).find((item) => item.id === created.body.id);
    expect(row?.revision).toBe(revision);
  });

  it("disables a connection without deleting the client secret", async () => {
    const { store, call } = await harness();
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET))).status).toBe(201);
    store.markOidcValidated("directory");
    expect((await call("POST", "/api/identity/connections/directory/oidc/tested")).status).toBe(200);
    expect((await call("POST", "/api/identity/connections/directory/oidc/activate")).status).toBe(200);
    const disabled = await call("POST", "/api/identity/connections/directory/disable");
    expect(disabled.status).toBe(200);
    expect(JSON.stringify(disabled.body)).not.toContain(SECRET);
    expect(store.oidcClientSecret("directory")).toBe(SECRET);
    const row = connectionsOf((await call("GET", "/api/identity/connections")).body).find((item) => item.id === "directory");
    expect(row?.active).toBe(false);
    expect(["disabled", "inactive"]).toContain(row?.status);
    expect(row?.upstreamNote).toBe(store.listConnections().find((item) => item.id === "directory")?.upstreamNote);
  });

  it("keeps another active connection active when a failed test never records success", async () => {
    const { store, call } = await harness();
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("directory", SECRET))).status).toBe(201);
    expect((await call("POST", "/api/identity/connections/oidc", oidcBody("other", NEXT_SECRET))).status).toBe(201);
    store.markOidcValidated("directory");
    store.markOidcValidated("other");
    expect((await call("POST", "/api/identity/connections/directory/oidc/tested")).status).toBe(200);
    expect((await call("POST", "/api/identity/connections/directory/oidc/activate")).status).toBe(200);
    const refused = await call("POST", "/api/identity/connections/other/oidc/activate");
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ code: "identity.verification_required" });
    const rows = connectionsOf((await call("GET", "/api/identity/connections")).body);
    expect(rows.find((item) => item.id === "directory")?.active).toBe(true);
    expect(rows.find((item) => item.id === "other")?.active).toBe(false);
    expect(rows.find((item) => item.id === "other")?.status).not.toBe("active");
  });
});
