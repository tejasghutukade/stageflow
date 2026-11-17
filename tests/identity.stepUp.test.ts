import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STEP_UP_LINK_MS,
  SIGNED_IN_ELEVATION_MS,
  clearRequiredAssuranceOverridesForTests,
  setRequiredAssuranceForTests,
} from "../src/identity/assurance.js";
import { ConsumerAuthorization } from "../src/identity/authorization.js";
import { dmarcAlignedPass } from "../src/agents/communications/agentmailListener.js";
import { ConsumerStepUpRequired, peekStepUpAccount } from "../src/identity/stepUp.js";
import { createScopeAuthorizationEngine } from "../src/identity/scope.js";
import { ConsumerIdentityStore } from "../src/identity/store.js";
import { ConsumerAccessError } from "../src/identity/types.js";
import type { OwnedResource } from "../src/identity/types.js";
import { orderCustomerStub } from "./helpers/customerAdapterStub.js";

const stores: ConsumerIdentityStore[] = [];
const ENV_KEYS = ["STAGEFLOW_PUBLIC_CHAT_URL", "STAGEFLOW_PUBLIC_URL"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.STAGEFLOW_PUBLIC_CHAT_URL = "https://chat.test/";
});

afterEach(() => {
  clearRequiredAssuranceOverridesForTests();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const store of stores.splice(0)) store.close();
});

const JANE = "jane@x.com";

function ordersAdapter() {
  const resources = new Map<string, OwnedResource>([
    ["ord_jane", { id: "ord_jane", workspaceId: "w", ownerAccountId: "cus_881", assignedAccountIds: [], version: "1" }],
  ]);
  return orderCustomerStub({
    resources,
    resolveSender: async () => ({ status: "found" as const, accountId: "cus_881" }),
  });
}

function channelHost(now: () => number) {
  const store = new ConsumerIdentityStore(":memory:", "w", now);
  stores.push(store);
  const auth = new ConsumerAuthorization(store, createScopeAuthorizationEngine(), ordersAdapter(), "consumer_v1");
  auth.resolveStepUpSlug = () => "helpslug";
  auth.registerChannel({
    id: "mail-id", channelConnectionId: "inbox", agentId: "help", provider: "agentmail", unmappedReply: "no match",
    permission: { scope: "own", agents: ["help"], actions: ["conversation:use", "order:read"] },
  });
  return { store, auth };
}

describe("consumer step-up", () => {
  it("denies signed_in tools until the link is completed by the same account", async () => {
    setRequiredAssuranceForTests("orders.status", "signed_in");
    const { store, auth } = channelHost(() => Date.now());
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: true, signal: AbortSignal.timeout(3_000),
    });
    expect(admitted.outcome).toBe("admitted");
    if (admitted.outcome !== "admitted") return;
    auth.bind("conv", admitted.sessionId, "help", 1);
    await expect(auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000)))
      .rejects.toBeInstanceOf(ConsumerStepUpRequired);
    const issued = store.listAudit(20).find((row) => row.reason === "step_up_issued");
    expect(issued).toBeTruthy();
    let token = "";
    let reply = "";
    try {
      await auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    } catch (error) {
      if (error instanceof ConsumerStepUpRequired) {
        reply = error.reply;
        token = reply.split("token=")[1] ?? "";
      }
    }
    expect(reply).toMatch(/^Sign in to continue: https?:\/\//);
    expect(reply).toContain("/api/public/chat/helpslug/step-up?token=");
    auth.completeStepUp(token, "cus_881");
    expect(store.sessionAssurance(admitted.sessionId)).toBe("signed_in");
    await auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    expect(store.listAudit(30).some((row) => row.reason === "step_up_completed")).toBe(true);
  });

  it("denies step-up without issuing a link when no public origin is configured", async () => {
    delete process.env.STAGEFLOW_PUBLIC_CHAT_URL;
    delete process.env.STAGEFLOW_PUBLIC_URL;
    setRequiredAssuranceForTests("orders.status", "signed_in");
    const { store, auth } = channelHost(() => Date.now());
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: true, signal: AbortSignal.timeout(3_000),
    });
    if (admitted.outcome !== "admitted") throw new Error("not admitted");
    auth.bind("conv", admitted.sessionId, "help", 1);
    await expect(
      auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000)),
    ).rejects.toBeInstanceOf(ConsumerAccessError);
    expect(store.listAudit(20).some((row) => row.reason === "step_up_origin_missing")).toBe(true);
    expect(store.listAudit(20).some((row) => row.reason === "step_up_issued")).toBe(false);
  });

  it("does not elevate the channel session when a different account completes the link", async () => {
    setRequiredAssuranceForTests("orders.status", "signed_in");
    const { store, auth } = channelHost(() => Date.now());
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: true, signal: AbortSignal.timeout(3_000),
    });
    if (admitted.outcome !== "admitted") throw new Error("not admitted");
    auth.bind("conv", admitted.sessionId, "help", 1);
    let token = "";
    try {
      await auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    } catch (error) {
      if (error instanceof ConsumerStepUpRequired) token = error.reply.split("token=")[1] ?? "";
    }
    auth.completeStepUp(token, "cus_other");
    expect(store.sessionAssurance(admitted.sessionId)).toBe("address_only");
    expect(store.listAudit(20).some((row) => row.reason === "step_up_denied_account_mismatch")).toBe(true);
    expect(peekStepUpAccount(store, token)).toBe("cus_881");
    auth.completeStepUp(token, "cus_881");
    expect(store.sessionAssurance(admitted.sessionId)).toBe("signed_in");
    expect(store.listAudit(30).some((row) => row.reason === "step_up_completed")).toBe(true);
  });

  it("refuses a used or expired link", async () => {
    let now = 1_000_000;
    const { store, auth } = channelHost(() => now);
    const admitted = await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: true, signal: AbortSignal.timeout(3_000),
    });
    if (admitted.outcome !== "admitted") throw new Error("not admitted");
    auth.bind("conv", admitted.sessionId, "help", 1);
    let token = "";
    try {
      await auth.check("conv", admitted.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    } catch (error) {
      if (error instanceof ConsumerStepUpRequired) token = error.reply.split("token=")[1] ?? "";
    }
    auth.completeStepUp(token, "cus_881");
    auth.completeStepUp(token, "cus_881");
    expect(store.listAudit(30).some((row) => row.reason === "step_up_denied_used")).toBe(true);
    const second = channelHost(() => now);
    const admitted2 = await second.auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: true, signal: AbortSignal.timeout(3_000),
    });
    if (admitted2.outcome !== "admitted") throw new Error("not admitted");
    second.auth.bind("c2", admitted2.sessionId, "help", 1);
    let token2 = "";
    try {
      await second.auth.check("c2", admitted2.sessionId, "help", "orders.status", { orderId: "ord_jane" }, AbortSignal.timeout(3_000));
    } catch (error) {
      if (error instanceof ConsumerStepUpRequired) token2 = error.reply.split("token=")[1] ?? "";
    }
    now += STEP_UP_LINK_MS + 1;
    second.auth.completeStepUp(token2, "cus_881");
    expect(second.store.listAudit(20).some((row) => row.reason === "step_up_denied_expired")).toBe(true);
    expect(SIGNED_IN_ELEVATION_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe("agentmail dmarc admission", () => {
  it("requires aligned DMARC pass before mapping an email sender", async () => {
    const { auth } = channelHost(() => Date.now());
    expect(await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, dmarcPass: false, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "dmarc_failed" });
    expect(await auth.admitChannelSender({
      agentId: "help", channelConnectionId: "inbox", provider: "agentmail", sender: JANE, signal: AbortSignal.timeout(3_000),
    })).toMatchObject({ outcome: "unmapped", reason: "dmarc_failed" });
    expect(dmarcAlignedPass({ inboxId: "i", threadId: "t", messageId: "m", from: JANE, dmarc: { result: "pass", aligned: true } })).toBe(true);
    expect(dmarcAlignedPass({ inboxId: "i", threadId: "t", messageId: "m", from: JANE, dmarc: { result: "pass", aligned: false } })).toBe(false);
  });
});