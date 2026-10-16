import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const payload = { channel: "#research", text: "Sources" };

async function poster() {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(
    project,
    agentInput("poster", { tools: { builtin: ["read"], mcp: { slack: ["post_message"] } }, approvals: { ask_first: ["slack.post_message"], timeout_minutes: 5 } }),
    { source: "console" },
  );
  await service.setEnabled(project, "poster", true, { source: "console" });
  return fixture;
}

describe("turn lifecycle", () => {
  it("closes the approval when the turn is stopped at the gate, so it can never be approved later", async () => {
    const { service, project } = await poster();
    const ran: string[] = [];
    const backend = scriptedBackend(async (_m, ctx) => {
      const result = await ctx.tool("slack.post_message", payload, () => {
        ran.push("posted");
        return "posted";
      });
      return result.ran ? "done" : "stopped";
    });
    const chat = new AgentChatController({ service, backend });
    const opened = await service.openSession(project, "poster", { source: "console" });
    const sending = chat.send({ projectRoot: project, agentId: "poster", sessionId: opened.id, text: "post it" });
    await vi.waitFor(async () => expect((await service.pendingApprovals(project)).length).toBe(1));
    expect(chat.stop(opened.id)).toBe(true);
    await sending;

    const detail = await service.getSession(project, opened.id);
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]!.status).toBe("expired");
    expect(detail.pendingApproval).toBeNull();
    expect(detail.session.status).toBe("open");
    expect(detail.turns[0]!.status).toBe("cancelled");
    expect(await service.pendingApprovals(project)).toEqual([]);
    // Nothing is left to approve, so a late click cannot pre-approve the same call.
    await expect(service.decideApproval(project, opened.id, "approve", { kind: "operator" })).rejects.toMatchObject({ code: "agent.approval_not_pending" });
    expect(ran).toEqual([]);

    // The same call in a later turn asks again; it is not waved through.
    const second = chat.send({ projectRoot: project, agentId: "poster", sessionId: opened.id, text: "again" });
    await vi.waitFor(async () => expect((await service.pendingApprovals(project)).length).toBe(1));
    expect((await service.pendingApprovals(project))[0]!.status).toBe("pending");
    await service.decideApproval(project, opened.id, "deny", { kind: "operator" });
    await second;
    expect(ran).toEqual([]);
  });

  it("refuses to approve an approval whose turn is already over, and does not pre-approve its payload", async () => {
    const { service, store, project } = await poster();
    const opened = await service.openSession(project, "poster", { source: "console" });
    const active = await service.beginTurn(project, opened.id, { text: "go" });
    const approval = await service.requestApproval(project, opened.id, { tool: "slack.post_message", payload, turnId: active.turn.id });
    // A turn ended some other way (older data, a crash) while its approval stayed pending.
    store.setTurnOutcome(active.turn.id, "cancelled", null);
    await expect(service.decideApproval(project, opened.id, "approve", { kind: "operator" })).rejects.toMatchObject({ code: "agent.approval_not_pending" });
    expect(store.getApproval(approval.id)!.status).toBe("expired");
    expect(store.hasExecutedPayload(opened.id, approval.payloadHash)).toBe(false);
  });

  it("completing a finished turn changes nothing", async () => {
    const { service, project } = await poster();
    const opened = await service.openSession(project, "poster", { source: "console" });
    const active = await service.beginTurn(project, opened.id, { text: "go" });
    await service.completeTurn(project, active.turn.id, { status: "cancelled" });
    const detail = await service.completeTurn(project, active.turn.id, { status: "succeeded", assistantText: "late reply" });
    expect(detail.turns[0]).toMatchObject({ status: "cancelled" });
    expect(detail.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("finishing a turn closes its open approval and wakes the waiter", async () => {
    const { service, project } = await poster();
    const opened = await service.openSession(project, "poster", { source: "console" });
    const active = await service.beginTurn(project, opened.id, { text: "go" });
    const approval = await service.requestApproval(project, opened.id, { tool: "slack.post_message", payload, turnId: active.turn.id });
    expect(await service.waitOnApproval(project, active.turn.id, approval.id)).toBe("waiting");
    const waiter = service.approvalBroker.wait(approval.id, { expiresAt: approval.expiresAt, signal: new AbortController().signal, now: () => service.clockMs() });
    await service.completeTurn(project, active.turn.id, { status: "failed", errorCode: "agent.backend_failed" });
    expect(await waiter).toBe("expired");
    expect((await service.getSession(project, opened.id)).approvals[0]!.status).toBe("expired");
  });

  it("does not park a turn on an approval that was decided in between", async () => {
    const { service, project } = await poster();
    const opened = await service.openSession(project, "poster", { source: "console" });
    const active = await service.beginTurn(project, opened.id, { text: "go" });
    const approval = await service.requestApproval(project, opened.id, { tool: "slack.post_message", payload, turnId: active.turn.id });
    await service.decideApproval(project, opened.id, "approve", { kind: "operator" });
    expect(await service.waitOnApproval(project, active.turn.id, approval.id)).toBe("approved");
    expect((await service.getSession(project, opened.id)).turns[0]!.status).toBe("running");
  });

  it("only moves the reply-undelivered marker, never an unfinished or otherwise-ended turn", async () => {
    const { service, project } = await poster();
    const opened = await service.openSession(project, "poster", { source: "console" });
    const running = await service.beginTurn(project, opened.id, { text: "go" });
    service.setReplyDelivered(running.turn.id, false);
    expect((await service.getSession(project, opened.id)).turns[0]).toMatchObject({ status: "running", errorCode: null });
    await service.completeTurn(project, running.turn.id, { status: "cancelled" });
    service.setReplyDelivered(running.turn.id, false);
    service.setReplyDelivered(running.turn.id, true);
    expect((await service.getSession(project, opened.id)).turns[0]).toMatchObject({ status: "cancelled", errorCode: null });

    const next = await service.beginTurn(project, opened.id, { text: "again" });
    await service.completeTurn(project, next.turn.id, { status: "succeeded", assistantText: "ok" });
    service.setReplyDelivered(next.turn.id, false);
    expect((await service.getSession(project, opened.id)).turns[1]).toMatchObject({ status: "failed", errorCode: "agent.reply_undelivered" });
    service.setReplyDelivered(next.turn.id, true);
    expect((await service.getSession(project, opened.id)).turns[1]).toMatchObject({ status: "succeeded", errorCode: null });
  });
});
