import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelError } from "../src/channels/errors.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter } from "../src/agents/communications/inbound.js";
import { classifySendFailure, ReplyDelivery } from "../src/agents/communications/delivery.js";
import type { AgentInboundMessage } from "../src/agents/communications/port.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const inbound = (id: string): AgentInboundMessage => ({ provider: "imessage", connectionId: "line", eventId: `imessage:${id}`, threadId: "+14155550123", text: `hello ${id}`, from: "+14155550123", replyTo: "+14155550123" });

/** A router whose sends follow a script: each call to `reply` throws the next scripted error, or succeeds. */
async function setup(script: Array<unknown | undefined>) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(project, agentInput("pal", { channel: { connection_id: "line", allow_from: ["*"] } }), { source: "console" });
  await service.setEnabled(project, "pal", true, { source: "console" });
  const sends: Array<{ to: string; text: string; key: string }> = [];
  const reply = async (_c: string, to: string, text: string, key: string) => {
    sends.push({ to, text, key });
    const next = script.shift();
    if (next !== undefined) throw next;
  };
  const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `re: ${m.at(-1)!.text}`) });
  const delivery = new ReplyDelivery({ service, reply, backoffMs: [1, 1, 1] });
  const router = new AgentInboundRouter({ service, chat, connections: { find: () => undefined, reply }, projectRoot: project, delivery });
  const turnOf = async () => {
    const sessions = (await service.listSessions(project, "pal", { limit: 5 })).sessions;
    return service.getSession(project, sessions[0]!.id);
  };
  return { service, project, router, delivery, sends, turnOf, clock: fixture.clock };
}

const transient = () => new ChannelError("CHANNEL_CONNECTION_FAILED", true);

describe("classifying a send failure", () => {
  it("separates never-sent, unknown and local failures", () => {
    expect(classifySendFailure(transient())).toMatchObject({ kind: "failed", retryable: true, code: "CHANNEL_CONNECTION_FAILED" });
    expect(classifySendFailure(new ChannelError("CHANNEL_AUTH_FAILED", false))).toMatchObject({ kind: "failed", retryable: false });
    expect(classifySendFailure(new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false))).toMatchObject({ kind: "unknown", retryable: false });
    expect(classifySendFailure(Object.assign(new Error("EACCES: denied"), { code: "EACCES" }))).toMatchObject({ kind: "failed", retryable: false, code: "EACCES" });
  });
});

describe("reply delivery", () => {
  it("marks the turn succeeded once the reply is delivered", async () => {
    const { router, sends, turnOf } = await setup([]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => expect((await turnOf()).deliveries[0]?.state).toBe("delivered"));
    const detail = await turnOf();
    expect(detail.turns[0]).toMatchObject({ status: "succeeded", errorCode: null });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.key).toMatch(/:1$/);
  });

  it("retries a transient failure on its own and the turn never shows as failed", async () => {
    const { router, delivery, sends, turnOf, clock } = await setup([transient(), transient()]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => expect((await turnOf()).deliveries[0]?.state).toBe("failed"));
    expect((await turnOf()).turns[0]!.status).toBe("succeeded");
    await vi.waitFor(async () => {
      clock.advance(10);
      await delivery.sweep();
      expect((await turnOf()).deliveries[0]?.state).toBe("delivered");
    });
    expect(sends.map((s) => s.key.split(":").at(-1))).toEqual(["1", "2", "3"]);
    expect((await turnOf()).turns[0]).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("fails the turn when the retries run out, and a person can resend it", async () => {
    const { router, delivery, sends, turnOf, clock } = await setup([transient(), transient(), transient(), transient()]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => {
      clock.advance(10);
      await delivery.sweep();
      const detail = await turnOf();
      expect(detail.deliveries[0]).toMatchObject({ state: "failed", retryable: false, attempts: 4 });
    });
    const failed = await turnOf();
    expect(failed.turns[0]).toMatchObject({ status: "failed", errorCode: "agent.reply_undelivered" });
    expect(failed.deliveries[0]!.errorMessage).toBeTruthy();
    await delivery.resend(failed.turns[0]!.id);
    const fixed = await turnOf();
    expect(fixed.deliveries[0]!.state).toBe("delivered");
    expect(fixed.turns[0]).toMatchObject({ status: "succeeded", errorCode: null });
    expect(sends).toHaveLength(5);
    await expect(delivery.resend(failed.turns[0]!.id)).rejects.toMatchObject({ code: "agent.invalid" });
  });

  it("fails at once, without retrying, when the problem is not transient", async () => {
    const { router, delivery, sends, turnOf } = await setup([new ChannelError("CHANNEL_AUTH_FAILED", false)]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => expect((await turnOf()).turns[0]?.status).toBe("failed"));
    await delivery.sweep();
    expect(sends).toHaveLength(1);
    const detail = await turnOf();
    expect(detail.deliveries[0]).toMatchObject({ state: "failed", retryable: false, errorCode: "CHANNEL_AUTH_FAILED" });
    expect(detail.turns[0]!.errorCode).toBe("agent.reply_undelivered");
  });

  it("never resends an unknown outcome on its own, but a person can confirm or resend it", async () => {
    const { router, delivery, sends, turnOf } = await setup([new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false)]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => expect((await turnOf()).deliveries[0]?.state).toBe("unknown"));
    await delivery.sweep();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await delivery.sweep();
    expect(sends).toHaveLength(1);
    const detail = await turnOf();
    expect(detail.turns[0]).toMatchObject({ status: "failed", errorCode: "agent.reply_undelivered" });
    delivery.markDelivered(detail.turns[0]!.id);
    const confirmed = await turnOf();
    expect(confirmed.deliveries[0]!.state).toBe("delivered");
    expect(confirmed.turns[0]).toMatchObject({ status: "succeeded", errorCode: null });
    expect(sends).toHaveLength(1);
  });

  it("turns a send a restart cut off into an unconfirmed reply", async () => {
    const { router, service, delivery, turnOf } = await setup([]);
    await router.deliver(inbound("1"));
    await vi.waitFor(async () => expect((await turnOf()).deliveries[0]?.state).toBe("delivered"));
    const turnId = (await turnOf()).turns[0]!.id;
    service.deliveries.patch(turnId, { state: "sending" });
    delivery.start(60_000);
    delivery.stop();
    const detail = await turnOf();
    expect(detail.deliveries[0]).toMatchObject({ state: "unknown", errorCode: "CHANNEL_SEND_OUTCOME_UNKNOWN" });
    expect(detail.turns[0]).toMatchObject({ status: "failed", errorCode: "agent.reply_undelivered" });
  });
});
