import { afterEach, describe, expect, it } from "vitest";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { ConsumerAccessError } from "../src/identity/types.js";
import { createEvalConsumerSession } from "../src/evals/consumer/evalConsumerSession.js";
import { createEvalFixtureAdapter, misscopedEvalFixtureAdapter } from "../src/evals/consumer/fixtureAdapter.js";
import type { ConsumerAuthority } from "../src/identity/types.js";
import { EVAL_CONSUMER_WORKSPACE } from "../src/evals/consumer/fixtureCatalog.js";

const stores: ConsumerIdentityStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("eval consumer fixture", () => {
  it("runs consumer checks against the in-memory adapter, not the live store", async () => {
    const handle = createEvalConsumerSession({
      principalId: "customer-a",
      agentId: "support",
      conversationSessionId: "conv-eval",
    });
    const tool = handle.auth.tools("conv-eval", handle.consumerSessionId, "support").find((row) => row.grantId === "orders.status")!;
    const allowed = JSON.parse(await tool.execute({ orderId: "order-a" }, AbortSignal.timeout(3_000)));
    expect(allowed.status).toContain("fixture-private-status-a");
    await expect(tool.execute({ orderId: "order-b" }, AbortSignal.timeout(3_000))).rejects.toBeInstanceOf(ConsumerAccessError);
    handle.close();
  });

  it("denies list when the mis-scoped fixture includes another account's order", async () => {
    const store = new ConsumerIdentityStore(":memory:", EVAL_CONSUMER_WORKSPACE);
    stores.push(store);
    const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), misscopedEvalFixtureAdapter(), "eval_fixture_v1");
    store.registerService("eval-mis", "account-a", {
      scope: "own",
      agents: ["support"],
      actions: ["conversation:use", "order:read", "order:list"],
    });
    const live = store.openServiceAuthority("support");
    auth.bind("conv-mis", live.sessionId, "support", live.principal.revision);
    const list = auth.tools("conv-mis", live.sessionId, "support").find((row) => row.grantId === "orders.list")!;
    await expect(list.execute({}, AbortSignal.timeout(3_000))).rejects.toBeInstanceOf(ConsumerAccessError);
    const authority: ConsumerAuthority = {
      principal: {
        id: "p", workspaceId: EVAL_CONSUMER_WORKSPACE, connectionId: "c", subject: "s", accountId: "account-a",
        mappingSource: "fixture", revision: 1,
        permission: { scope: "own", agents: ["support"], actions: ["order:list"] },
      },
      sessionId: "s", grantId: "g", agentId: "support", expiresAt: Date.now() + 60_000, actions: ["order:list"], resources: null,
    };
    const clean = await createEvalFixtureAdapter().list("orders", authority, "/stageflow/orders-list", AbortSignal.timeout(3_000));
    expect(clean).toEqual([{ id: "order-a", version: "v1" }]);
  });
});