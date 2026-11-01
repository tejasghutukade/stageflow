import { describe, expect, it } from "vitest";
import type { IdentityConnection } from "../../api/identity";
import {
  auditSummary,
  cerbosEndpointProblem,
  endpointProblem,
  engineTestCopy,
  ordersTestCopy,
  connectionStatus,
  defaultRedirectUri,
  errorCopy,
  initials,
  inspectJwks,
  oidcSteps,
  readinessSteps,
  reasonLabel,
  relativeTime,
  validClientSecret,
  validConnectionId,
} from "./identityView";

function connection(patch: Partial<IdentityConnection>): IdentityConnection {
  return {
    id: "c",
    kind: "oidc",
    active: false,
    status: "draft",
    callbackPath: "",
    issuer: "https://idp.example",
    issuerChecks: [],
    upstreamRevocation: "local_only",
    upstreamNote: "",
    agentId: "support",
    audience: "",
    tested: false,
    ...patch,
  };
}

describe("connection status", () => {
  it("walks an OIDC draft to live", () => {
    expect(connectionStatus(connection({}))).toMatchObject({ tone: "needs", label: "Draft" });
    expect(connectionStatus(connection({ status: "validated" })).label).toBe("Needs a test sign-in");
    expect(connectionStatus(connection({ status: "validated", tested: true })).label).toBe("Ready to go live");
    expect(connectionStatus(connection({ status: "active", active: true }))).toMatchObject({ tone: "ok", label: "Active" });
    expect(connectionStatus(connection({ status: "disabled" }))).toMatchObject({ tone: "muted", label: "Disabled" });
  });

  it("marks the first unfinished OIDC step as current", () => {
    const states = (c: IdentityConnection) => oidcSteps(c).map((step) => step.state);
    expect(states(connection({}))).toEqual(["done", "current", "todo", "todo"]);
    expect(states(connection({ status: "validated" }))).toEqual(["done", "done", "current", "todo"]);
    expect(states(connection({ status: "validated", tested: true }))).toEqual(["done", "done", "done", "current"]);
    expect(states(connection({ status: "active", active: true, tested: true }))).toEqual(["done", "done", "done", "done"]);
  });
});

describe("setup readiness", () => {
  it("is done only once there is a live connection, a mapped person and activity", () => {
    const live = connection({ active: true, status: "active" });
    const person = { id: "a", connectionId: "c", subject: "s", accountId: "x", scope: "own" as const, resources: [], agents: [], revision: 1, active: true };
    const event = { at: "1", principalId: "", conversationId: "", outcome: "allow", reason: "admitted" };
    expect(readinessSteps([], [], []).map((step) => step.done)).toEqual([false, false, false]);
    expect(readinessSteps([live], [person], [event]).map((step) => step.done)).toEqual([true, true, true]);
    expect(readinessSteps([connection({})], [{ ...person, active: false }], []).map((step) => step.done)).toEqual([false, false, false]);
  });
});

describe("public key set check", () => {
  it("accepts public keys and refuses private material", () => {
    expect(inspectJwks("")).toEqual({ state: "empty" });
    expect(inspectJwks("{not json")).toEqual({ state: "invalid" });
    expect(inspectJwks('{"keys":[]}')).toEqual({ state: "invalid" });
    expect(inspectJwks('{"keys":[{"kty":"EC","x":"a","y":"b"}]}')).toEqual({ state: "ok", count: 1 });
    expect(inspectJwks('[{"kty":"EC","x":"a","y":"b"},{"kty":"RSA","n":"1","e":"AQAB"}]')).toEqual({ state: "ok", count: 2 });
    expect(inspectJwks('{"keys":[{"kty":"EC","x":"a","y":"b","d":"secret"}]}')).toEqual({ state: "private" });
    expect(inspectJwks('{"keys":[{"kty":"oct","k":"secret"}]}')).toEqual({ state: "private" });
  });
});

describe("field rules", () => {
  it("mirrors the Host's id and secret rules", () => {
    expect(validConnectionId("shop-app_1")).toBe(true);
    expect(validConnectionId("shop app")).toBe(false);
    expect(validConnectionId("")).toBe(false);
    expect(validClientSecret("x".repeat(16))).toBe(true);
    expect(validClientSecret("short")).toBe(false);
    expect(validClientSecret(`${"x".repeat(16)}\nmore`)).toBe(false);
  });

  it("suggests a callback from the chat link", () => {
    expect(defaultRedirectUri("https://chat.example/", "/chat/support-abc")).toBe("https://chat.example/api/public/chat/support-abc/oidc/callback");
    expect(defaultRedirectUri("https://chat.example", null)).toBe("");
  });

  it("makes initials", () => {
    expect(initials("sam.jones")).toBe("SJ");
    expect(initials("user_8f2c1")).toBe("U8");
    expect(initials("")).toBe("?");
  });
});

describe("audit wording", () => {
  it("labels known reasons and keeps unknown ones readable", () => {
    expect(reasonLabel("order_read")).toBe("Order read");
    expect(reasonLabel("not_owner")).toBe("Order belongs to someone else");
    expect(reasonLabel("identity.verification_required")).toBe("Verification required");
    expect(reasonLabel("")).toBe("Unknown");
  });

  it("counts outcomes", () => {
    const event = (outcome: string) => ({ at: "1", principalId: "", conversationId: "", outcome, reason: "r" });
    expect(auditSummary([event("allow"), event("deny"), event("deny")])).toEqual({ allowed: 1, denied: 2 });
  });

  it("describes times from epoch milliseconds or ISO strings", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(relativeTime(String(now - 5_000), now)).toBe("just now");
    expect(relativeTime("2026-10-30T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime(String(now - 3 * 3_600_000), now)).toBe("3 h ago");
    expect(relativeTime("2026-10-28T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("", now)).toBe("—");
  });
});

describe("error copy", () => {
  it("never hides the code and explains the common ones", () => {
    expect(errorCopy("identity.conflict")).toMatchObject({ code: "identity.conflict", title: "Someone else changed this just now." });
    expect(errorCopy("something.else")).toMatchObject({ code: "something.else", title: "Something went wrong." });
  });
});

describe("setup helpers", () => {
  it("checks the order API address the way the Host does", () => {
    expect(endpointProblem("", false)).toBeNull();
    expect(endpointProblem("https://orders.example.com", false)).toBeNull();
    expect(endpointProblem("orders.example.com", false)).toMatch(/full address/);
    expect(endpointProblem("http://orders.example.com", false)).toMatch(/https/);
    expect(endpointProblem("http://127.0.0.1:9000", false)).toMatch(/local testing/);
    expect(endpointProblem("http://127.0.0.1:9000", true)).toBeNull();
    expect(endpointProblem("https://u:p@orders.example.com", false)).toMatch(/credentials/);
    expect(endpointProblem("https://orders.example.com/?a=1", false)).toMatch(/query/);
  });

  it("keeps the policy server on this machine", () => {
    expect(cerbosEndpointProblem("http://127.0.0.1:3592")).toBeNull();
    expect(cerbosEndpointProblem("https://localhost:3592")).toBeNull();
    expect(cerbosEndpointProblem("https://pdp.example.com")).toMatch(/this machine/);
    expect(cerbosEndpointProblem("ftp://127.0.0.1")).toMatch(/http/);
    expect(cerbosEndpointProblem("nope")).toMatch(/full address/);
  });

  it("explains test results in plain words", () => {
    expect(engineTestCopy({ ok: true, reason: "ok" }).tone).toBe("ok");
    expect(engineTestCopy({ ok: false, reason: "too_broad" }).title).toMatch(/too much/);
    expect(engineTestCopy({ ok: false, reason: "unreachable" }).title).toMatch(/did not answer/);
    expect(ordersTestCopy({ ok: true, signingVerified: true, version: "v1", assignedAccounts: 1 }).hint).toBe("Version v1, 1 assigned account.");
    expect(ordersTestCopy({ ok: true, signingVerified: false, version: "v1", assignedAccounts: 0 }).tone).toBe("needs");
    expect(ordersTestCopy({ ok: false, reason: "no_credential" }).hint).toMatch(/credential/);
    expect(ordersTestCopy({ ok: false, reason: "failed" }).tone).toBe("fail");
  });
});
