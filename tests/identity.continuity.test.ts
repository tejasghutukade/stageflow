import { describe, expect, it, vi } from "vitest";
import { sessionContinuityFailure } from "../src/identity/sessionContinuity.js";
import type { SessionProtection } from "../src/identity/store.js";
import type { ConsumerAuthority } from "../src/identity/types.js";

function authority(subject = "alice"): ConsumerAuthority {
  return {
    principal: {
      id: "p1", workspaceId: "w", connectionId: "c", subject, accountId: "a", mappingSource: "op", revision: 1,
      permission: { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] },
    },
    sessionId: "s1", grantId: "g1", agentId: "support", expiresAt: Date.now() + 60_000, actions: ["order:read"], resources: null,
  };
}

function protection(overrides: Partial<SessionProtection> = {}): SessionProtection {
  return {
    kind: "handoff", connectionId: "c", issuer: null, evidenceAt: null, freshnessMs: 300_000, revocationUrl: null, hasRefresh: false,
    ...overrides,
  };
}

describe("sessionContinuityFailure", () => {
  it("allows handoff sessions with no upstream revocation source", async () => {
    expect(await sessionContinuityFailure(protection(), authority(), 1_000, AbortSignal.timeout(100), async () => false, () => {})).toBeNull();
  });

  it("denies when upstream reports the subject inactive", async () => {
    const revoke = vi.fn();
    const result = await sessionContinuityFailure(
      protection({ revocationUrl: "https://issuer.example/revoke", issuer: "https://issuer.example" }),
      authority("bob"),
      1_000,
      AbortSignal.timeout(100),
      async () => false,
      revoke,
      { upstreamSubjectActive: async () => false },
    );
    expect(result).toBe("upstream_revoked");
    expect(revoke).toHaveBeenCalledWith("p1");
  });

  it("denies when upstream introspection fails", async () => {
    const result = await sessionContinuityFailure(
      protection({ revocationUrl: "https://issuer.example/revoke", issuer: "https://issuer.example" }),
      authority(),
      1_000,
      AbortSignal.timeout(100),
      async () => false,
      () => {},
      { upstreamSubjectActive: async () => { throw new Error("down"); } },
    );
    expect(result).toBe("upstream_unavailable");
  });

  it("refreshes stale OIDC evidence when inside the freshness window after refresh", async () => {
    const refresh = vi.fn(async () => true);
    const result = await sessionContinuityFailure(
      protection({ kind: "oidc", evidenceAt: 0, freshnessMs: 1_000, hasRefresh: true }),
      authority(),
      5_000,
      AbortSignal.timeout(100),
      refresh,
      () => {},
    );
    expect(result).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("denies stale OIDC evidence when refresh fails", async () => {
    const result = await sessionContinuityFailure(
      protection({ kind: "oidc", evidenceAt: 0, freshnessMs: 1_000, hasRefresh: true }),
      authority(),
      5_000,
      AbortSignal.timeout(100),
      async () => false,
      () => {},
    );
    expect(result).toBe("evidence_stale");
  });

  it("skips refresh when evidence is still fresh", async () => {
    const refresh = vi.fn(async () => false);
    const result = await sessionContinuityFailure(
      protection({ kind: "oidc", evidenceAt: 4_500, freshnessMs: 1_000, hasRefresh: true }),
      authority(),
      5_000,
      AbortSignal.timeout(100),
      refresh,
      () => {},
    );
    expect(result).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
