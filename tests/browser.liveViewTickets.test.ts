import { describe, expect, it } from "vitest";
import { createLiveViewTicketService } from "../src/browser/liveViewTickets.js";

const target = { scope: "scope-a", runId: "run-1", stageId: "login" };

function service() {
  let at = 1_000;
  let n = 0;
  const svc = createLiveViewTicketService({ now: () => at, randomToken: () => `tok-${++n}` });
  return { svc, advance: (ms: number) => (at += ms) };
}

describe("live view ticket service", () => {
  it("issues a one-minute ticket and redeems it once into a bound credential", () => {
    const { svc } = service();
    const { ticket, expiresAt } = svc.issue({ ...target, mode: "control", callerId: "ci" });
    expect(expiresAt).toBe(61_000);
    const redeemed = svc.redeem(ticket, target);
    expect(redeemed).toMatchObject({ ...target, mode: "control", callerId: "ci" });
    expect(svc.redeem(ticket, target)).toBeUndefined();
    expect(svc.resolve(redeemed!.credential, target)).toMatchObject({ mode: "control" });
  });

  it("refuses unknown, expired, wrong-run, wrong-stage and wrong-scope tickets and spends them", () => {
    const { svc, advance } = service();
    expect(svc.redeem("nope", target)).toBeUndefined();

    const expired = svc.issue({ ...target, mode: "view" }).ticket;
    advance(60_001);
    expect(svc.redeem(expired, target)).toBeUndefined();

    for (const other of [
      { ...target, runId: "run-2" },
      { ...target, stageId: "other" },
      { ...target, scope: "scope-b" },
    ]) {
      const ticket = svc.issue({ ...target, mode: "view" }).ticket;
      expect(svc.redeem(ticket, other)).toBeUndefined();
      expect(svc.redeem(ticket, target)).toBeUndefined();
    }
  });

  it("credentials only resolve for their own target", () => {
    const { svc } = service();
    const { credential } = svc.redeem(svc.issue({ ...target, mode: "view" }).ticket, target)!;
    expect(svc.resolve(credential, { ...target, scope: "scope-b" })).toBeUndefined();
    expect(svc.resolve(credential, { ...target, stageId: "x" })).toBeUndefined();
    expect(svc.resolve("unknown", target)).toBeUndefined();
  });

  it("revoke and revokeRun invalidate tickets and credentials and notify listeners", () => {
    const { svc } = service();
    const seen: string[][] = [];
    svc.onRevoked((credentials) => seen.push([...credentials]));

    const login = svc.redeem(svc.issue({ ...target, mode: "control" }).ticket, target)!;
    const pending = svc.issue({ ...target, mode: "view" }).ticket;
    const otherTarget = { ...target, stageId: "build" };
    const build = svc.redeem(svc.issue({ ...otherTarget, mode: "view" }).ticket, otherTarget)!;

    svc.revoke("run-1", "login");
    expect(svc.resolve(login.credential, target)).toBeUndefined();
    expect(svc.redeem(pending, target)).toBeUndefined();
    expect(svc.resolve(build.credential, otherTarget)).toBeDefined();
    expect(seen).toEqual([[login.credential]]);

    svc.revokeRun("run-1");
    expect(svc.resolve(build.credential, otherTarget)).toBeUndefined();
    expect(seen).toEqual([[login.credential], [build.credential]]);
  });

  it("expires credentials after their lifetime and unsubscribes listeners", () => {
    let at = 0;
    const svc = createLiveViewTicketService({
      now: () => at,
      randomToken: (() => {
        let n = 0;
        return () => `t${++n}`;
      })(),
      credentialTtlMs: 5_000,
    });
    const { credential } = svc.redeem(svc.issue({ ...target, mode: "view" }).ticket, target)!;
    at = 5_000;
    expect(svc.resolve(credential, target)).toBeUndefined();

    const calls: number[] = [];
    const off = svc.onRevoked(() => calls.push(1));
    off();
    const next = svc.redeem(svc.issue({ ...target, mode: "view" }).ticket, target)!;
    svc.revokeRun("run-1");
    expect(svc.resolve(next.credential, target)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("generates distinct unguessable tokens by default", () => {
    const svc = createLiveViewTicketService();
    const a = svc.issue({ ...target, mode: "view" }).ticket;
    const b = svc.issue({ ...target, mode: "view" }).ticket;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("revoking one mode leaves the other mode's credentials and reports remaining credentials", () => {
    const { svc } = service();
    const control = svc.redeem(svc.issue({ ...target, mode: "control" }).ticket, target)!;
    const view = svc.redeem(svc.issue({ ...target, mode: "view" }).ticket, target)!;
    svc.revoke("run-1", "login", "control");
    expect(svc.resolve(control.credential, target)).toBeUndefined();
    expect(svc.resolve(view.credential, target)).toMatchObject({ mode: "view" });
    expect(svc.hasCredentials("run-1", "login")).toBe(true);
    svc.revoke("run-1", "login");
    expect(svc.hasCredentials("run-1", "login")).toBe(false);
  });
});
