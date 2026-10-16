import { afterEach, describe, expect, it } from "vitest";
import { normalizeSender, senderAllowed } from "../src/agents/communications/allowlist.js";
import { parseAgentDefinition, parseAgentYaml, serializeAgentDefinition } from "../src/config/loadAgent.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { channelIdentity } from "../src/agents/communications/identity.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const base = { id: "mail", name: "Mail", instructions: "x" };

describe("sender allow-list", () => {
  it("normalizes emails and phone numbers", () => {
    expect(normalizeSender("Jane Doe <Jane@X.com>")).toBe("jane@x.com");
    expect(normalizeSender("+1 (415) 555-0123")).toBe("+14155550123");
  });

  it("lets nobody in when empty, anyone with *, and matches addresses, phones and domains", () => {
    expect(senderAllowed([], "a@b.com")).toBe(false);
    expect(senderAllowed(["*"], undefined)).toBe(true);
    expect(senderAllowed(["jane@x.com"], "Jane <JANE@x.com>")).toBe(true);
    expect(senderAllowed(["jane@x.com"], "bob@x.com")).toBe(false);
    // Slack user ids and Telegram usernames (which arrive without the "@").
    expect(senderAllowed(["U02ABC1234"], "U02ABC1234")).toBe(true);
    expect(senderAllowed(["@Bob_Smith"], "bob_smith")).toBe(true);
    expect(senderAllowed(["@bob_smith"], "alice_x")).toBe(false);
    expect(senderAllowed(["@x.com"], "a@x.com")).toBe(true);
    expect(senderAllowed(["@acme.com"], "bob@Acme.com")).toBe(true);
    expect(senderAllowed(["@acme.com"], "bob@acme.com.evil.io")).toBe(false);
    expect(senderAllowed(["+14155550123"], "+1 415 555 0123")).toBe(true);
    expect(senderAllowed(["jane@x.com"], undefined)).toBe(false);
  });
});

describe("channel definition", () => {
  it("accepts one channel with an allow-list and round-trips through YAML", () => {
    const parsed = parseAgentDefinition({ ...base, channel: { connection_id: "inbox", allow_from: ["jane@x.com", "@acme.com", "+14155550123"] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const again = parseAgentYaml(serializeAgentDefinition(parsed.value));
    expect(again.ok && again.value.channel).toEqual({ connection_id: "inbox", allow_from: ["jane@x.com", "@acme.com", "+14155550123"] });
    expect(serializeAgentDefinition({ ...parsed.value, channel: undefined })).not.toContain("channel");
  });

  it("rejects malformed senders and duplicates", () => {
    expect(parseAgentDefinition({ ...base, channel: { connection_id: "i", allow_from: ["not a sender"] } }).ok).toBe(false);
    expect(parseAgentDefinition({ ...base, channel: { connection_id: "i", allow_from: ["a@b.com", "A@B.com"] } }).ok).toBe(false);
  });

  it("reads the old channels list as the one channel and refuses more than one", () => {
    const one = parseAgentDefinition({ ...base, channels: [{ connection_id: "inbox" }] });
    expect(one.ok && one.value.channel).toEqual({ connection_id: "inbox", allow_from: [] });
    const two = parseAgentDefinition({ ...base, channels: [{ connection_id: "a" }, { connection_id: "b" }] });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.issues[0]?.message).toContain("only one channel");
  });
});

describe("channel service rules", () => {
  async function setup() {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("gives a connection to one agent only", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("first", { channel: { connection_id: "inbox", allow_from: ["*"] } }), { source: "console" });
    const second = await service.validate(project, agentInput("second", { channel: { connection_id: "inbox", allow_from: ["*"] } }));
    expect(second.issues.map((i) => i.code)).toEqual(["agent.channel_in_use"]);
    await expect(service.create(project, agentInput("second", { channel: { connection_id: "inbox", allow_from: ["*"] } }), { source: "console" })).rejects.toMatchObject({ code: "agent.invalid" });
    // the same agent may keep its own connection when saved again
    const detail = await service.get(project, "first");
    expect((await service.validate(project, agentInput("first", { channel: { connection_id: "inbox", allow_from: ["*"] } }))).issues).toEqual([]);
    expect(detail.definition?.channel?.connection_id).toBe("inbox");
  });

  it("refuses messages from senders that are not allowed, and warns about empty or open lists", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("mail", { channel: { connection_id: "inbox", allow_from: ["jane@x.com"] } }), { source: "console" });
    await service.setEnabled(project, "mail", true, { source: "console" });
    const message = (from: string, eventId: string) => ({ provider: "agentmail" as const, connectionId: "inbox", eventId, threadId: "t1", text: "hi", from });
    await expect(service.receive(project, message("bob@x.com", "e1"))).rejects.toMatchObject({ code: "agent.sender_not_allowed" });
    expect((await service.receive(project, message("Jane <jane@x.com>", "e2"))).duplicate).toBe(false);
    const empty = await service.validate(project, agentInput("quiet", { channel: { connection_id: "other", allow_from: [] } }));
    expect(empty.warnings.map((w) => w.code)).toContain("agent.channel_nobody_allowed");
  });
});

describe("one inbox, one agent", () => {
  it("names what a connection talks to", () => {
    const mail = (id: string, inbox: string, region?: string) => channelIdentity({ id, provider: "agentmail", config: { inbox, ...(region ? { region } : {}) } });
    expect(mail("a", "Support@AgentMail.to")).toBe(mail("b", "support@agentmail.to", "us"));
    expect(mail("a", "support@agentmail.to")).not.toBe(mail("a", "support@agentmail.to", "eu"));
    const line = (id: string, projectId: string) => channelIdentity({ id, provider: "imessage", credential: { secrets: { projectId, projectSecret: "s" } } });
    expect(line("x", "p1")).toBe(line("y", "p1"));
    expect(line("x", "p1")).not.toBe(line("x", "p2"));
    expect(channelIdentity({ id: "s1", provider: "slack" })).not.toBe(channelIdentity({ id: "s2", provider: "slack" }));
  });

  it("refuses a second agent on another connection that reaches the same inbox", async () => {
    const identities: Record<string, string> = { "mail-a": "agentmail:us:support@agentmail.to", "mail-b": "agentmail:us:support@agentmail.to", "mail-c": "agentmail:us:sales@agentmail.to" };
    const fixture = await agentsFixture({
      environment: {
        mcpServerNames: async () => undefined,
        skillNames: async () => undefined,
        connectionIds: async () => undefined,
        connectionIdentity: async (id) => identities[id],
      },
    });
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("first", { channel: { connection_id: "mail-a", allow_from: ["*"] } }), { source: "console" });
    const same = await service.validate(project, agentInput("second", { channel: { connection_id: "mail-b", allow_from: ["*"] } }));
    expect(same.issues.map((i) => i.code)).toEqual(["agent.channel_in_use"]);
    expect(same.issues[0]!.message).toContain("same inbox");
    await expect(service.create(project, agentInput("second", { channel: { connection_id: "mail-b", allow_from: ["*"] } }), { source: "console" })).rejects.toMatchObject({ code: "agent.invalid" });
    expect((await service.validate(project, agentInput("second", { channel: { connection_id: "mail-c", allow_from: ["*"] } }))).issues).toEqual([]);
  });
});

describe("always-on sessions", () => {
  it("skip the time and turn limits, and cap cost per day instead of per session", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("pal", { limits: { always_on: true, session_minutes: 1, max_turns: 1, cost_usd: 1 } }), { source: "console" });
    await service.setEnabled(project, "pal", true, { source: "console" });
    const chat = new AgentChatController({ service, backend: scriptedBackend((m) => `re: ${m.at(-1)!.text}`) });
    const first = await chat.send({ projectRoot: project, agentId: "pal", text: "one", source: "console" });
    const sessionId = first.session.id;
    const second = await chat.send({ projectRoot: project, agentId: "pal", sessionId, text: "two", source: "console" });
    expect(second.turns).toHaveLength(2);
  });

  it("still end a normal session at max_turns", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const { service, project } = fixture;
    await service.create(project, agentInput("brief", { limits: { max_turns: 1 } }), { source: "console" });
    await service.setEnabled(project, "brief", true, { source: "console" });
    const chat = new AgentChatController({ service, backend: scriptedBackend(() => "ok") });
    const first = await chat.send({ projectRoot: project, agentId: "brief", text: "one", source: "console" });
    await expect(chat.send({ projectRoot: project, agentId: "brief", sessionId: first.session.id, text: "two", source: "console" })).rejects.toMatchObject({ code: "agent.limit_reached" });
  });
});
