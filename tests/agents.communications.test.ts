import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentEmail } from "../src/agents/communications/email.js";
import { agentThreadKey } from "../src/agents/communications/port.js";
import { parseSlackInbound, verifySlackSignature } from "../src/agents/communications/slack.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function inboxAgent(enabled: boolean) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  await fixture.service.create(
    fixture.project,
    agentInput("inbox", { channel: { connection_id: "mail-inbox", allow_from: ["*"] } }),
    { source: "console" },
  );
  if (enabled) await fixture.service.setEnabled(fixture.project, "inbox", true, { source: "console" });
  return fixture;
}

const message = (eventId: string, threadId = "thread-a") => ({
  provider: "email" as const,
  connectionId: "mail-inbox",
  eventId,
  threadId,
  text: "Hello",
  from: "user@example.com",
});

describe("agent communications", () => {
  it("verifies Slack signatures", () => {
    const secret = "secret";
    const body = JSON.stringify({ event: { type: "message", text: "hi", channel: "C1", ts: "1" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const config = { connectionId: "ops-slack", signingSecret: secret };
    expect(verifySlackSignature(config, { signature, requestTimestamp: timestamp }, body)).toEqual({ ok: true });
    expect(verifySlackSignature(config, { signature: "v0=deadbeef", requestTimestamp: timestamp }, body)).toEqual({
      ok: false,
      code: "agent.signature_invalid",
    });
  });

  it("ignores Slack bot messages", () => {
    expect(
      parseSlackInbound(
        { connectionId: "ops-slack", signingSecret: "secret" },
        { event: { type: "message", text: "automated", channel: "C1", ts: "1", bot_id: "B123" } },
      ),
    ).toEqual({ ok: true, ignored: true, reason: "bot_message" });
  });

  it("routes a thread to one session and dedupes provider event ids (AE5)", async () => {
    const { service, project } = await inboxAgent(true);
    const first = await service.receive(project, message("email:1"));
    expect(first).toMatchObject({ agentId: "inbox", duplicate: false });
    expect(await service.receive(project, message("email:1"))).toEqual({ ...first, duplicate: true });
    expect(await service.receive(project, message("email:2"))).toEqual({ ...first, duplicate: false });
    const other = await service.receive(project, message("email:3", "thread-b"));
    expect(other.sessionId).not.toBe(first.sessionId);
    const detail = await service.getSession(project, first.sessionId);
    expect(detail.session).toMatchObject({ source: "email", sourceRef: "user@example.com" });
  });

  it("replaces a thread session that is past its limits and reuses one that is not", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project, clock } = fixture;
    await service.create(
      project,
      agentInput("inbox", {
        channel: { connection_id: "mail-inbox", allow_from: ["*"] },
        limits: { max_turns: 1, session_minutes: 5 },
      }),
      { source: "console" },
    );
    await service.setEnabled(project, "inbox", true, { source: "console" });
    const threadKey = agentThreadKey({ provider: "email", connectionId: "mail-inbox", threadId: "thread-a" });

    const first = await service.receive(project, message("email:1"));
    expect(await service.receive(project, message("email:2"))).toEqual({ ...first, duplicate: false });
    const turn = await service.beginTurn(project, first.sessionId, { text: "Hello" });
    await service.completeTurn(project, turn.turn.id, { status: "succeeded", assistantText: "ok" });

    const replaced = await service.receive(project, message("email:3"));
    expect(replaced.sessionId).not.toBe(first.sessionId);
    expect(replaced.duplicate).toBe(false);
    expect((await service.getSession(project, first.sessionId)).session.threadKey).toBeNull();
    expect((await service.getSession(project, replaced.sessionId)).session).toMatchObject({ source: "email", threadKey });
    expect(await service.receive(project, message("email:4"))).toEqual({ ...replaced, duplicate: false });
    await expect(service.beginTurn(project, first.sessionId, { text: "again" })).rejects.toMatchObject({ code: "agent.limit_reached" });

    const timed = await service.receive(project, message("email:5", "thread-b"));
    expect(await service.receive(project, message("email:6", "thread-b"))).toEqual({ ...timed, duplicate: false });
    clock.advance(5 * 60_000);
    const timedNext = await service.receive(project, message("email:7", "thread-b"));
    expect(timedNext.sessionId).not.toBe(timed.sessionId);
    expect(await service.receive(project, message("email:8", "thread-b"))).toEqual({ ...timedNext, duplicate: false });
    expect((await service.getSession(project, timedNext.sessionId)).session.source).toBe("email");
  });

  it("refuses messages for disabled or unbound agents", async () => {
    const { service, project } = await inboxAgent(false);
    await expect(service.receive(project, message("email:1"))).rejects.toMatchObject({ code: "agent.disabled" });
    await expect(
      service.receive(project, { ...message("email:2"), connectionId: "nobody" }),
    ).rejects.toMatchObject({ code: "agent.unbound" });
  });

  it("email dispatch calls the agent port only when the connection is bound", async () => {
    const port = { receive: vi.fn(async () => ({ agentId: "x", sessionId: "ses_x", duplicate: false })) };
    const onTrigger = vi.fn(async () => undefined);
    const email = { connectionId: "mail-inbox", messageId: "m1", threadId: "t", from: "a@b.c", subject: "Hi", text: "Body" };
    await dispatchAgentEmail({ email, isBound: false, port, projectRoot: "/p", onTrigger });
    expect(port.receive).not.toHaveBeenCalled();
    await dispatchAgentEmail({ email, isBound: true, port, projectRoot: "/p", onTrigger });
    expect(port.receive).toHaveBeenCalledOnce();
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("sends an outbound operation at most once and never retries an unknown outcome", async () => {
    const { service, project } = await inboxAgent(true);
    const session = await service.openSession(project, "inbox", { source: "console" });
    const submit = vi.fn(async () => undefined);
    expect(await service.sendOutbound(project, session.id, "op-1", submit)).toEqual({ state: "submitted", resent: true });
    expect(await service.sendOutbound(project, session.id, "op-1", submit)).toEqual({ state: "submitted", resent: false });
    expect(submit).toHaveBeenCalledOnce();
    await expect(
      service.sendOutbound(project, session.id, "op-2", async () => {
        throw new Error("timeout");
      }),
    ).rejects.toMatchObject({ code: "agent.outbound_unknown" });
    await expect(service.sendOutbound(project, session.id, "op-2", submit)).rejects.toMatchObject({
      code: "agent.outbound_unknown",
    });
  });
});
