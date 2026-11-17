import { afterEach, describe, expect, it } from "vitest";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createCustomerApiAdapter } from "../src/identity/customerApi.js";
import { ConsumerAccessError } from "../src/identity/types.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { isConsumerSafeAgent } from "../src/agents/consumerSafety.js";
import { startOrderApiFixture, type OrderApiFixture } from "./helpers/orderApiFixture.js";
import { SignJWT, type JWTPayload } from "jose";

const stores: ConsumerIdentityStore[] = [];
const fixtures: OrderApiFixture[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function authority(accountId = "account-a") {
  return {
    principal: {
      id: "p", workspaceId: "w", connectionId: "app", subject: "alice", accountId,
      mappingSource: "directory:v3", revision: 1,
      permission: { scope: "own" as const, agents: ["support"], actions: ["conversation:use", "order:read", "order:list", "account:read"] },
    },
    sessionId: "session", grantId: "grant", agentId: "support", expiresAt: Date.now() + 240_000,
    actions: ["order:read", "order:list", "account:read"], resources: null,
  };
}

async function host(fixture: OrderApiFixture) {
  const store = new ConsumerIdentityStore(":memory:", "w");
  stores.push(store);
  const customer = createCustomerApiAdapter({
    endpoint: fixture.url,
    allowLoopback: true,
    audience: fixture.audience,
    credential: async () => fixture.credential,
    signContext: (claims) => new SignJWT(claims as JWTPayload).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(fixture.secret)),
  });
  const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), customer, "consumer_v1");
  store.registerService("svc", authority().principal.accountId, authority().principal.permission);
  const live = store.openServiceAuthority("support");
  auth.bind("conv", live.sessionId, "support", live.principal.revision);
  return { store, auth, sessionId: live.sessionId };
}

describe("customer resource tools", () => {
  it("lists only resources the principal may read even when the downstream list includes another account", async () => {
    const fixture = await open();
    fixture.setListIncludesOtherAccount(true);
    const { auth, sessionId } = await host(fixture);
    const tool = auth.tools("conv", sessionId, "support").find((row) => row.grantId === "orders.list");
    expect(tool).toBeTruthy();
    await expect(tool!.execute({ accountId: "someone-else", orderId: "order-other-account" }, AbortSignal.timeout(3_000)))
      .rejects.toBeInstanceOf(ConsumerAccessError);
  });

  it("returns only owned resources when the list is clean", async () => {
    const fixture = await open();
    const { auth, sessionId } = await host(fixture);
    const tool = auth.tools("conv", sessionId, "support").find((row) => row.grantId === "orders.list")!;
    const output = JSON.parse(await tool.execute({ orderId: "ignored" }, AbortSignal.timeout(3_000)));
    expect(output).toEqual({ resources: [{ id: "order-a", version: "v1" }] });
  });

  it("reads the mapped account profile through the generic adapter", async () => {
    const fixture = await open();
    const { auth, sessionId } = await host(fixture);
    const tool = auth.tools("conv", sessionId, "support").find((row) => row.grantId === "account.profile")!;
    const output = JSON.parse(await tool.execute({ accountId: "hacker" }, AbortSignal.timeout(3_000)));
    expect(output).toEqual({ accountId: "account-a", displayName: "private-fixture-name" });
  });
});

describe("turn gate check", () => {
  it("allows orders.list and account.profile for the mapped account and denies another account order read", async () => {
    const fixture = await open();
    const { auth, sessionId } = await host(fixture);
    const signal = AbortSignal.timeout(3_000);
    await auth.check("conv", sessionId, "support", "orders.list", {}, signal);
    await auth.check("conv", sessionId, "support", "account.profile", {}, signal);
    await expect(auth.check("conv", sessionId, "support", "orders.status", { orderId: "order-other-account" }, signal))
      .rejects.toBeInstanceOf(ConsumerAccessError);
  });
});

describe("consumer-safe publication", () => {
  it("rejects a generic MCP tool on an authenticated channel agent", () => {
    const safeBase = {
      model: { backend: "pi" as const },
      project_context: false,
      memories: [],
      tools: {
        builtin: [],
        builtin_tools: [],
        mcp: { orders: ["status"] },
        skills: [],
        browser: false,
        stageflow: { groups: [], tools: [] },
      },
    };
    expect(isConsumerSafeAgent(safeBase)).toBe(true);
    expect(isConsumerSafeAgent({
      ...safeBase,
      tools: { ...safeBase.tools, mcp: { billing: ["lookup"] } },
    })).toBe(false);
  });
});

async function open(): Promise<OrderApiFixture> {
  const fixture = await startOrderApiFixture();
  fixtures.push(fixture);
  return fixture;
}