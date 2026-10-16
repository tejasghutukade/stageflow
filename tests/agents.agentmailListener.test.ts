import { describe, expect, it, vi } from "vitest";
import { addressOf, bodyOf, createAgentMailListener, ignoreReason, toInbound, type AgentMailMessage, type AgentMailSocket, type AgentMailTransport } from "../src/agents/communications/agentmailListener.js";
import type { AgentInboundMessage } from "../src/agents/communications/port.js";

const mail = (over: Partial<AgentMailMessage> = {}): AgentMailMessage => ({
  inboxId: "support@agentmail.to", threadId: "thd_1", messageId: "<m1@x>", labels: ["received"], from: "Jane <jane@x.com>", subject: "Where is my order?", text: "Order 42 is late.\n\n> quoted", extractedText: "Order 42 is late.", ...over,
});

class FakeSocket implements AgentMailSocket {
  handlers: Record<string, Array<(payload?: any) => void>> = {};
  subscribed: unknown[] = [];
  closed = false;
  on(event: string, callback: (payload?: any) => void) {
    (this.handlers[event] ??= []).push(callback);
  }
  sendSubscribe(message: any) {
    this.subscribed.push(message);
  }
  async waitForOpen() {}
  close() {
    this.closed = true;
  }
  emit(event: string, payload?: unknown) {
    (this.handlers[event] ?? []).forEach((handler) => handler(payload));
  }
}

describe("AgentMail mail handling", () => {
  it("reads the sender address and the new text, led by the subject on a first message", () => {
    expect(addressOf("Jane Doe <Jane@X.com>")).toBe("jane@x.com");
    expect(bodyOf(mail())).toBe("Subject: Where is my order?\n\nOrder 42 is late.");
    expect(bodyOf(mail({ subject: "Re: Where is my order?" }))).toBe("Order 42 is late.");
    expect(bodyOf(mail({ extractedText: undefined, text: undefined, html: "<p>Hello <b>there</b></p>" }))).toContain("Hello there");
    expect(bodyOf(mail({ extractedText: "", text: "" }))).toBe("");
  });

  it("answers in the thread: thread id is the conversation, message id the reply handle", () => {
    expect(toInbound("c", mail())).toMatchObject({ provider: "agentmail", connectionId: "c", threadId: "thd_1", eventId: "agentmail:<m1@x>", from: "Jane <jane@x.com>", replyTo: "<m1@x>" });
    expect(toInbound("c", mail({ extractedText: "", text: "" }))).toBeUndefined();
  });

  it("keeps the agent out of mail loops", () => {
    const inbox = "support@agentmail.to";
    expect(ignoreReason(mail(), inbox)).toBeUndefined();
    expect(ignoreReason(mail({ labels: ["sent"] }), inbox)).toBe("not received mail");
    expect(ignoreReason(mail({ from: "Support <support@agentmail.to>" }), inbox)).toBe("from the agent's own inbox");
    expect(ignoreReason(mail({ from: "MAILER-DAEMON@x.com" }), inbox)).toBe("from a no-reply or system sender");
    expect(ignoreReason(mail({ from: "no-reply@shop.com" }), inbox)).toBe("from a no-reply or system sender");
    expect(ignoreReason(mail({ headers: { "Auto-Submitted": "auto-replied" } }), inbox)).toBe("automatic reply");
    expect(ignoreReason(mail({ headers: { "Auto-Submitted": "no" } }), inbox)).toBeUndefined();
    expect(ignoreReason(mail({ headers: { Precedence: "bulk" } }), inbox)).toBe("bulk mail");
  });
});

describe("AgentMail listener", () => {
  function setup(options: { recent?: AgentMailMessage[]; failConnects?: number } = {}) {
    const sockets: FakeSocket[] = [];
    let failures = options.failConnects ?? 0;
    const transport: AgentMailTransport = {
      connect: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("offline");
        }
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      recent: async () => options.recent ?? [],
    };
    const delivered: AgentInboundMessage[] = [];
    const listener = createAgentMailListener({ connectionId: "inbox", inbox: "support@agentmail.to" }, transport, {
      onMessage: async (message) => void delivered.push(message),
      log: () => undefined,
      sleep: async () => undefined,
    });
    return { listener, sockets, delivered };
  }

  it("subscribes to received mail for its inbox and hands each new message to the agent", async () => {
    const { listener, sockets, delivered } = setup();
    await listener.start();
    await vi.waitFor(() => expect(listener.state().status).toBe("connected"));
    expect(sockets[0]!.subscribed).toEqual([{ type: "subscribe", inboxIds: ["support@agentmail.to"], eventTypes: ["message.received"] }]);
    sockets[0]!.emit("message", { type: "event", eventType: "message.received", message: mail() });
    sockets[0]!.emit("message", { type: "event", eventType: "message.received.spam", message: mail({ messageId: "<spam>" }) });
    sockets[0]!.emit("message", { type: "event", eventType: "message.received", message: mail({ inboxId: "other@agentmail.to", messageId: "<other>" }) });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]!.eventId).toBe("agentmail:<m1@x>");
    expect(listener.state().received).toBe(1);
    await listener.stop();
    expect(listener.state().status).toBe("stopped");
  });

  it("answers mail that arrived while it was away, and reconnects after a drop", async () => {
    const { listener, sockets, delivered } = setup({ recent: [mail({ messageId: "<missed>" })] });
    await listener.start();
    await vi.waitFor(() => expect(delivered.map((m) => m.eventId)).toEqual(["agentmail:<missed>"]));
    sockets[0]!.emit("close");
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(listener.state().status).toBe("connected"));
    await listener.stop();
  });

  it("keeps trying when the connection cannot be made, and reports it", async () => {
    const { listener, sockets } = setup({ failConnects: 2 });
    await listener.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.waitFor(() => expect(listener.state().status).toBe("connected"));
    await listener.stop();
  });
});
