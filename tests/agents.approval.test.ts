import { afterEach, describe, expect, it } from "vitest";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

/** An enabled agent that may post to Slack only after approval, with one open session. */
async function poster(overrides: Record<string, unknown> = {}) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(
    project,
    agentInput("poster", {
      tools: { builtin: ["read"], mcp: { slack: ["post_message"] } },
      approvals: { ask_first: ["slack.post_message"], timeout_minutes: 5, ...overrides },
    }),
    { source: "console" },
  );
  await service.setEnabled(project, "poster", true, { source: "console" });
  const session = await service.openSession(project, "poster", { source: "console" });
  return { ...fixture, session };
}

const payload = { channel: "#research", text: "Sources: …" };

describe("agent approvals", () => {
  it("waits for an operator, then records the decision and frees the session (F3)", async () => {
    const { service, project, session } = await poster();
    const approval = await service.requestApproval(project, session.id, { tool: "slack.post_message", payload });
    expect(approval).toMatchObject({ status: "pending", expiresAt: "2026-10-15T12:05:00.000Z" });
    expect((await service.getSession(project, session.id)).session.status).toBe("waiting");
    expect((await service.list(project))[0]!.pendingApprovals).toBe(1);
    const decided = await service.decideApproval(project, session.id, "approve", { kind: "operator" });
    expect(decided).toMatchObject({ status: "approved", actor: { kind: "operator" } });
    const detail = await service.getSession(project, session.id);
    expect(detail.session.status).toBe("open");
    expect(detail.pendingApproval).toBeNull();
  });

  it("returns the earlier decision instead of asking twice for an already-run payload", async () => {
    const { service, project, session } = await poster();
    const first = await service.requestApproval(project, session.id, { tool: "slack.post_message", payload });
    await service.decideApproval(project, session.id, "approve", { kind: "operator" });
    const again = await service.requestApproval(project, session.id, { tool: "slack.post_message", payload: { ...payload } });
    expect(again).toMatchObject({ id: first.id, status: "approved" });
  });

  it("refuses tools that aren't granted or don't need approval", async () => {
    const { service, project, session } = await poster();
    await expect(
      service.requestApproval(project, session.id, { tool: "github.merge", payload }),
    ).rejects.toMatchObject({ code: "agent.tool_not_granted" });
    await expect(service.requestApproval(project, session.id, { tool: "read", payload })).rejects.toMatchObject({
      code: "agent.approval_not_required",
    });
  });

  it("expires after the timeout without running the action (AE3)", async () => {
    const { service, project, session, clock } = await poster();
    await service.requestApproval(project, session.id, { tool: "slack.post_message", payload });
    clock.advance(5 * 60_000);
    await expect(
      service.decideApproval(project, session.id, "approve", { kind: "operator" }),
    ).rejects.toMatchObject({ code: "agent.approval_expired" });
    const detail = await service.getSession(project, session.id);
    expect(detail.session.status).toBe("open");
    expect(detail.approvals[0]).toMatchObject({ status: "expired" });
  });

  it("lets only configured approvers decide", async () => {
    const { service, project, session } = await poster({ approvers: { operators: false, channel_ids: ["slack:U1"] } });
    await service.requestApproval(project, session.id, { tool: "slack.post_message", payload });
    await expect(
      service.decideApproval(project, session.id, "approve", { kind: "operator" }),
    ).rejects.toMatchObject({ code: "agent.approval_forbidden" });
    await expect(
      service.decideApproval(project, session.id, "approve", { kind: "channel", channelId: "slack:U2" }),
    ).rejects.toMatchObject({ code: "agent.approval_forbidden" });
    const decided = await service.decideApproval(project, session.id, "approve", { kind: "channel", channelId: "slack:U1" });
    expect(decided.actor).toEqual({ kind: "channel", channelId: "slack:U1" });
  });

  it("refuses approval after the agent is disabled, but still allows a denial (R9)", async () => {
    const { service, project, session } = await poster();
    await service.requestApproval(project, session.id, { tool: "slack.post_message", payload });
    await service.setEnabled(project, "poster", false, { source: "console" });
    await expect(
      service.decideApproval(project, session.id, "approve", { kind: "operator" }),
    ).rejects.toMatchObject({ code: "agent.disabled" });
    expect(await service.decideApproval(project, session.id, "deny", { kind: "operator" })).toMatchObject({
      status: "denied",
    });
  });
});
