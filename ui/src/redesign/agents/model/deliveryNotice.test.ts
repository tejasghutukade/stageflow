import { describe, expect, it } from "vitest";
import type { AgentDelivery } from "../../../api/agents";
import { deliveryNotice } from "./deliveryNotice";

const base: AgentDelivery = { turnId: "t", sessionId: "s", connectionId: "line", provider: "imessage", replyTo: "+1415", text: "hi", state: "failed", attempts: 1, errorCode: "CHANNEL_AUTH_FAILED", errorMessage: "Credentials were rejected.", retryable: false, nextAttemptAt: null, createdAt: "", updatedAt: "" };

describe("delivery notice", () => {
  it("says nothing for delivered replies, retries in progress, or no delivery", () => {
    expect(deliveryNotice(undefined, "iMessage")).toBeNull();
    expect(deliveryNotice({ ...base, state: "delivered" }, "iMessage")).toBeNull();
    expect(deliveryNotice({ ...base, retryable: true, nextAttemptAt: "x" }, "iMessage")).toBeNull();
    expect(deliveryNotice({ ...base, state: "sending" }, "iMessage")).toBeNull();
  });

  it("explains a failed reply with the reason and the attempts", () => {
    expect(deliveryNotice({ ...base, attempts: 4 }, "iMessage")).toEqual({ title: "Reply was not delivered", detail: "Sending to iMessage (+1415) failed after 4 attempts. Credentials were rejected.", tone: "bad", canResend: true });
  });

  it("warns that an unknown outcome is not resent on its own", () => {
    const notice = deliveryNotice({ ...base, state: "unknown", errorMessage: "Timed out." }, "AgentMail");
    expect(notice).toMatchObject({ title: "Reply may or may not have arrived", tone: "warn", canResend: true });
    expect(notice!.detail).toContain("not resent on its own");
  });
});
