import { afterEach, describe, expect, it } from "vitest";
import { ChannelError } from "../src/channels/errors.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentInboundRouter } from "../src/agents/communications/inbound.js";
import { ReplyDelivery } from "../src/agents/communications/delivery.js";
import type { AgentInboundMessage } from "../src/agents/communications/port.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const inbound = (id: string): AgentInboundMessage => ({ provider: "imessage", connectionId: "line", eventId: `imessage:${id}`, threadId: `+1415555010${id}`, text: `hello ${id}`, from: `+1415555010${id}`, replyTo: `+1415555010${id}` });

describe("reply delivery under overlapping sweeps", () => {
  it("sends each due reply once even when two sweeps hold the same stale list", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project, clock } = fixture;
    await service.create(project, agentInput("pal", { channel: { connection_id: "line", allow_from: ["*"] } }), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });

    const sends: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let failing = true;
    const reply = async (_c: string, to: string, _t: string, key: string) => {
      sends.push(`${to}|${key}`);
      if (failing) throw new ChannelError("CHANNEL_CONNECTION_FAILED", true);
      await gate;
    };
    const delivery = new ReplyDelivery({ service, reply, backoffMs: [1, 1, 1] });
    const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `re: ${m.at(-1)!.text}`) });
    const router = new AgentInboundRouter({ service, chat, connections: { find: () => undefined, reply }, projectRoot: project, delivery });
    await router.deliver(inbound("1"));
    await router.deliver(inbound("2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toHaveLength(2);

    failing = false;
    clock.advance(10_000);
    expect(service.deliveries.due()).toHaveLength(2);
    const first = delivery.sweep();
    const second = delivery.sweep();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const counts = await Promise.all([first, second]);

    // two retries in total, one per reply, not four
    expect(sends).toHaveLength(4);
    expect(new Set(sends).size).toBe(4);
    expect(counts[0]! + counts[1]!).toBe(2);
    expect(service.deliveries.due()).toEqual([]);
    delivery.stop();
  });

  it("an attempt on a delivery that is already sending or delivered does nothing", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("pal", { channel: { connection_id: "line", allow_from: ["*"] } }), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });
    const sends: string[] = [];
    const reply = async (_c: string, to: string) => void sends.push(to);
    const delivery = new ReplyDelivery({ service, reply, backoffMs: [1] });
    const chat = new AgentChatController({ service, backend: scriptedBackend(() => "ok") });
    const router = new AgentInboundRouter({ service, chat, connections: { find: () => undefined, reply }, projectRoot: project, delivery });
    await router.deliver(inbound("1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toHaveLength(1);
    const turnId = service.deliveries.get(
      (await service.getSession(project, (await service.listSessions(project, "pal", { limit: 1 })).sessions[0]!.id)).turns[0]!.id,
    )!.turnId;
    // delivered: neither a sweep nor a second claim can send it again
    expect(service.deliveries.claim(turnId, "retry")).toBeUndefined();
    expect(service.deliveries.claim(turnId, "first")).toBeUndefined();
    expect(sends).toHaveLength(1);
  });
});
