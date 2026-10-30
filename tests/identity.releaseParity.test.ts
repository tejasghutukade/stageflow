import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ConsumerAuthorization, ConsumerIdentityStore, createScopeAuthorizationEngine, type OrderDataAdapter } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("self-hosted and hosted workspaces", () => {
  it("enforces the same allow, deny, replay, revocation, and restart results", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sf-identity-parity-"));
    directories.push(directory);
    const selfHosted = await deployment(directory, "self-hosted");
    const hosted = await deployment(directory, "hosted");
    const selfDecisions = await decide(selfHosted);
    const hostedDecisions = await decide(hosted);
    expect(() => hosted.store.authenticate(selfHosted.token, "support")).toThrow("identity.verification_required");
    expect(await selfHosted.authorization.preview("acct-alice", "own", null, {
      id: "bob-order", workspaceId: "self-hosted", ownerAccountId: "acct-bob", assignedAccountIds: [], version: "v1",
    }, AbortSignal.timeout(1_000))).toBe(false);
    const selfRestart = await restart(selfHosted);
    const hostedRestart = await restart(hosted);
    expect(hostedDecisions).toEqual(selfDecisions);
    expect(hostedRestart).toEqual(selfRestart);
    expect(selfDecisions).toEqual({
      own: "private-alice-order",
      other: "identity.not_available",
      otherRead: false,
      replay: "identity.verification_required",
      revoked: "identity.verification_required",
    });
    expect(selfRestart).toEqual({
      restart: "identity.verification_required",
      replayAfterRestart: "identity.verification_required",
    });
  });
});

async function deployment(directory: string, name: string) {
  const file = path.join(directory, `${name}.sqlite`);
  const store = new ConsumerIdentityStore(file, name);
  const reads: string[] = [];
  const authorization = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), orders(name, reads), "consumer_v1");
  const keys = await generateKeyPair("ES256");
  const issuer = `https://issuer.${name}.example`;
  store.registerHandoff({
    id: "app", issuer, agentId: "support", audience: `stageflow:${name}:support`, algorithms: ["ES256"],
    publicJwks: { keys: [{ ...await exportJWK(keys.publicKey), kid: "key", alg: "ES256" }] },
  });
  store.assign("app", "alice", "acct-alice", "directory", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  store.assign("app", "bob", "acct-bob", "directory", { scope: "own", agents: ["support"], actions: ["conversation:use", "order:read"] });
  return { name, file, store, authorization, reads, keys, issuer, token: "", assertion: "" };
}

async function decide(opened: Awaited<ReturnType<typeof deployment>>) {
  const assertion = await sign(opened, "alice", "jti-alice");
  opened.assertion = assertion;
  opened.token = await opened.authorization.admit("app", "support", assertion);
  const authority = opened.store.authenticate(opened.token, "support");
  opened.store.bind("chat-alice", authority.sessionId, "support", authority.principal.revision);
  const tool = opened.authorization.tools("chat-alice", authority.sessionId, "support")[0]!;
  const signal = new AbortController().signal;
  const own = JSON.parse(await tool.execute({ orderId: "alice-order" }, signal)) as { status: string };
  const before = opened.reads.length;
  const other = await tool.execute({ orderId: "bob-order" }, signal).then(() => "allowed", (error: Error) => error.message);
  const otherRead = opened.reads.slice(before).includes("bob-order");
  const replay = await opened.authorization.admit("app", "support", assertion).then(() => "opened", (error: Error) => error.message);
  opened.store.revoke("principal", authority.principal.id);
  let revoked = "open";
  try {
    opened.store.authenticate(opened.token, "support");
  } catch (error) {
    revoked = error instanceof Error ? error.message : "denied";
  }
  return { own: own.status, other, otherRead, replay, revoked };
}

async function restart(opened: Awaited<ReturnType<typeof deployment>> & { assertion?: string }) {
  const assertion = opened.assertion;
  opened.store.close();
  const reopened = new ConsumerIdentityStore(opened.file, opened.name);
  const restarted = new ConsumerAuthorization(reopened, createScopeAuthorizationEngine(), orders(opened.name, []), "consumer_v1");
  let restartResult = "open";
  try {
    reopened.authenticate(opened.token, "support");
  } catch (error) {
    restartResult = error instanceof Error ? error.message : "denied";
  }
  const replayAfterRestart = assertion
    ? await restarted.admit("app", "support", assertion).then(() => "opened", (error: Error) => error.message)
    : "missing";
  reopened.close();
  return { restart: restartResult, replayAfterRestart };
}

function sign(opened: Awaited<ReturnType<typeof deployment>>, subject: string, jti: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: opened.issuer, aud: `stageflow:${opened.name}:support`, sub: subject, workspace: opened.name, agent: "support",
    iat: now, exp: now + 240, jti,
  }).setProtectedHeader({ alg: "ES256", kid: "key", typ: "stageflow-agent-handoff+jwt" }).sign(opened.keys.privateKey);
}

function orders(workspaceId: string, reads: string[]): OrderDataAdapter {
  return {
    async ownership(_workspace, orderId) {
      return {
        id: orderId, workspaceId, ownerAccountId: orderId.startsWith("alice") ? "acct-alice" : "acct-bob",
        assignedAccountIds: [], version: "v1",
      };
    },
    async read(_authority, resource) {
      reads.push(resource.id);
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
  };
}
