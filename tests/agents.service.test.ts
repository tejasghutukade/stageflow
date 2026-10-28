import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/agents/errors.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

async function setup(options?: Parameters<typeof agentsFixture>[0]) {
  const fixture = await agentsFixture(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function expectCode(work: Promise<unknown>, code: string) {
  await expect(work).rejects.toMatchObject({ code });
  await work.catch((error: unknown) => expect(error).toBeInstanceOf(AgentError));
}

describe("AgentService definitions", () => {
  it("creates a disabled agent, writes canonical YAML, and records a console revision", async () => {
    const { service, project } = await setup();
    const detail = await service.create(project, agentInput("helper", { enabled: true }), { source: "console" });
    expect(detail.agent).toMatchObject({ id: "helper", enabled: false, revision: 1, issues: [] });
    const yaml = await readFile(path.join(project, "agents", "helper.agent.yaml"), "utf8");
    expect(yaml).toBe(detail.yaml);
    expect(yaml).toContain("enabled: false");
    const revisions = await service.listRevisions(project, "helper");
    expect(revisions).toEqual([expect.objectContaining({ revision: 1, source: "console", summary: "Created" })]);
  });

  it("generates the id from the name, unique per agent, when none is given", async () => {
    const { service, project } = await setup();
    const body = { name: "Research Assistant!", instructions: "Help." };
    const first = await service.create(project, body, { source: "console" });
    const second = await service.create(project, body, { source: "console" });
    const unnamed = await service.create(project, { name: "123", instructions: "Help." }, { source: "console" });
    expect([first.agent.id, second.agent.id, unnamed.agent.id]).toEqual(["research_assistant", "research_assistant_2", "agent"]);
    const preview = await service.validate(project, body);
    expect(preview.issues).toEqual([]);
    expect(preview.definition?.id).toBe("research_assistant_3");
    const nameless = await service.validate(project, { name: "", instructions: "Help." });
    expect(nameless.issues.length).toBeGreaterThan(0);
  });

  it("refuses to create over an existing agent or file", async () => {
    const { service, project, writeAgentFile } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await expect(service.create(project, agentInput("helper"), { source: "console" })).rejects.toMatchObject({
      code: "agent.exists",
      message: 'An agent with id "helper" already exists',
    });
    await writeAgentFile("broken", "id: [");
    await expectCode(service.create(project, agentInput("broken"), { source: "console" }), "agent.exists");
  });

  it("rejects an invalid definition with field issues and writes nothing", async () => {
    const { service, project } = await setup();
    const attempt = service.create(project, { id: "x", name: "", instructions: "" }, { source: "console" });
    await expect(attempt).rejects.toMatchObject({
      code: "agent.invalid",
      issues: expect.arrayContaining([expect.objectContaining({ path: "name" })]),
    });
    expect(await service.list(project)).toEqual([]);
  });

  it("saves a new revision, ignores a no-op save, and refuses a stale base revision", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    const saved = await service.save(
      project,
      "helper",
      { baseRevision: 1, definition: agentInput("helper", { instructions: "Be brief." }), summary: "Shorter" },
      { source: "console", author: "tejas" },
    );
    expect(saved.agent.revision).toBe(2);
    const unchanged = await service.save(
      project,
      "helper",
      { baseRevision: 2, definition: agentInput("helper", { instructions: "Be brief." }) },
      { source: "console" },
    );
    expect(unchanged.agent.revision).toBe(2);
    await expectCode(
      service.save(project, "helper", { baseRevision: 1, definition: agentInput("helper") }, { source: "console" }),
      "agent.conflict",
    );
    expect((await service.listRevisions(project, "helper"))[0]).toMatchObject({
      revision: 2,
      author: "tejas",
      summary: "Shorter",
    });
  });

  it("refuses to change the id on save", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await expect(
      service.save(project, "helper", { baseRevision: 1, definition: agentInput("other") }, { source: "console" }),
    ).rejects.toMatchObject({ code: "agent.invalid", issues: [expect.objectContaining({ code: "agent.id_immutable" })] });
  });

  it("turns a valid external edit into exactly one file revision and leaves the file alone", async () => {
    const { service, project, writeAgentFile } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    const edited = "id: helper\nname: Helper\ninstructions: Edited by hand.\n";
    await writeAgentFile("helper", edited);
    const first = await service.get(project, "helper");
    const second = await service.get(project, "helper");
    expect(first.agent.revision).toBe(2);
    expect(second.agent.revision).toBe(2);
    expect(first.definition?.instructions).toBe("Edited by hand.");
    expect(await readFile(path.join(project, "agents", "helper.agent.yaml"), "utf8")).toBe(edited);
    expect((await service.listRevisions(project, "helper"))[0]).toMatchObject({ source: "file" });
  });

  it("keeps the last valid revision when the file becomes invalid, and reports why", async () => {
    const { service, project, writeAgentFile } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await writeAgentFile("helper", "id: helper\nname: Helper\n");
    const detail = await service.get(project, "helper");
    expect(detail.agent.revision).toBe(1);
    expect(detail.definition?.instructions).toBe("Be helpful.");
    expect(detail.agent.issues).toEqual([expect.objectContaining({ path: "instructions" })]);
    await expectCode(service.setEnabled(project, "helper", true, { source: "console" }), "agent.invalid");
  });

  it("lists a never-valid file as an agent with issues and revision 0", async () => {
    const { service, project, writeAgentFile } = await setup();
    await writeAgentFile("draft", "id: other\nname: X\ninstructions: y\n");
    const [agent] = await service.list(project);
    expect(agent).toMatchObject({ id: "draft", revision: 0, issues: [expect.objectContaining({ code: "agent.id_mismatch" })] });
  });

  it("archives when the file is removed and restores visibility when it returns", async () => {
    const { service, project } = await setup();
    const created = await service.create(project, agentInput("helper"), { source: "console" });
    await rm(path.join(project, "agents", "helper.agent.yaml"));
    expect(await service.list(project)).toEqual([]);
    await expectCode(service.openSession(project, "helper", { source: "console" }), "agent.archived");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(project, "agents", "helper.agent.yaml"), created.yaml!);
    expect((await service.list(project)).map((agent) => agent.revision)).toEqual([1]);
  });

  it("archive removes the file and keeps revision history readable", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await service.archive(project, "helper");
    expect(await service.list(project)).toEqual([]);
    expect((await service.getRevision(project, "helper", 1)).definition.name).toBe("Agent helper");
  });

  it("enable and disable are revisions; a repeated toggle is a no-op", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    expect((await service.setEnabled(project, "helper", true, { source: "console" })).agent).toMatchObject({
      enabled: true,
      revision: 2,
    });
    expect((await service.setEnabled(project, "helper", true, { source: "console" })).agent.revision).toBe(2);
    expect((await service.listRevisions(project, "helper"))[0]!.summary).toBe("Enabled");
  });

  it("restores an old revision as a new one, keeps the current enabled state, and diffs revisions", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await service.save(
      project,
      "helper",
      { baseRevision: 1, definition: agentInput("helper", { instructions: "Version two." }) },
      { source: "console" },
    );
    await service.setEnabled(project, "helper", true, { source: "console" });
    const restored = await service.restore(project, "helper", { revision: 1, baseRevision: 3 }, { source: "console" });
    expect(restored.agent).toMatchObject({ revision: 4, enabled: true });
    expect(restored.definition?.instructions).toBe("Be helpful.");
    expect((await service.listRevisions(project, "helper"))[0]).toMatchObject({
      source: "restore",
      restoredFrom: 1,
      summary: "Restored v1",
    });
    const diff = await service.diffRevisions(project, "helper", 1, 2);
    expect(diff.filter((line) => line.kind !== "same")).toEqual([
      expect.objectContaining({ kind: "removed", text: "  Be helpful." }),
      expect.objectContaining({ kind: "added", text: "  Version two." }),
    ]);
    await expectCode(
      service.restore(project, "helper", { revision: 1, baseRevision: 3 }, { source: "console" }),
      "agent.conflict",
    );
  });

  it("warns about MCP servers, skills, sub-agents and connections that don't exist", async () => {
    const { service, project } = await setup({
      environment: {
        mcpServerNames: async () => ["notion"],
        skillNames: async () => ["web-research"],
        connectionIds: async () => ["slack-main"],
      },
    });
    const result = await service.validate(
      project,
      agentInput("lead", {
        tools: { mcp: { notion: ["search"], slack: ["post_message"] }, skills: ["web-research", "ghost"] },
        sub_agents: ["helper"],
        channel: { connection_id: "gone", allow_from: ["*"] },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((warning) => [warning.path, warning.code])).toEqual([
      ["tools.mcp.slack", "agent.mcp_server_unknown"],
      ["tools.skills.1", "agent.skill_unknown"],
      ["sub_agents.0", "agent.sub_agent_unknown"],
      ["channel.connection_id", "agent.connection_unknown"],
      ["channel.allow_from", "agent.channel_open_to_anyone"],
    ]);
    expect(result.yaml).toContain("sub_agents:");
  });
});

describe("AgentService model warnings", () => {
  it("warns on a model no connected provider lists, and on native-tools providers, but still validates", async () => {
    const { service, project } = await setup({
      environment: {
        mcpServerNames: async () => undefined,
        skillNames: async () => undefined,
        connectionIds: async () => undefined,
        modelInfo: async (id) =>
          id === "anthropic/claude" ? { known: true, nativeTools: false } : id === "cursor/auto" ? { known: true, nativeTools: true } : { known: false, nativeTools: false },
      },
    });
    const warn = async (id: string) =>
      (await service.validate(project, agentInput("helper", { model: { id } }))).warnings.map((warning) => [warning.path, warning.code]);
    expect(await warn("anthropic/claude")).toEqual([]);
    expect(await warn("acme/custom")).toEqual([["model.id", "agent.model_unknown"]]);
    expect(await warn("cursor/auto")).toEqual([["model.id", "agent.model_native_tools"]]);
    expect((await service.validate(project, agentInput("helper", { model: { id: "acme/custom" } }))).issues).toEqual([]);
  });
});

describe("AgentService web chat with conversation-reading tools", () => {
  it("warns when a web-chat agent can read other agents' sessions", async () => {
    const { service, project } = await setup();
    const codes = async (extra: Record<string, unknown>) =>
      (await service.validate(project, agentInput("helper", extra))).warnings.filter((w) => w.code === "agent.web_chat_reads_conversations").map((w) => w.path);
    const reading = { tools: { stageflow: { groups: ["agents.read"] } } };
    expect(await codes({ ...reading, web_chat: { enabled: true, slug: "abcdefghijklmnop" } })).toEqual(["tools.stageflow"]);
    expect(await codes({ ...reading })).toEqual([]);
    expect(await codes({ tools: { stageflow: { groups: ["discover"] } }, web_chat: { enabled: true, slug: "abcdefghijklmnop" } })).toEqual([]);
  });
});

describe("AgentService sessions", () => {
  it("pins a session to the revision it started on (AE1)", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper", { instructions: "v1 rules" }), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    await service.save(
      project,
      "helper",
      { baseRevision: 2, definition: agentInput("helper", { enabled: true, instructions: "v3 rules" }) },
      { source: "console" },
    );
    const turn = await service.beginTurn(project, session.id, { text: "hi" });
    expect(turn.definition.instructions).toBe("v1 rules");
    const fresh = await service.openSession(project, "helper", { source: "console" });
    expect(fresh.revision).toBe(3);
  });

  it("refuses sessions and turns on a disabled agent (AE2)", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await expectCode(service.openSession(project, "helper", { source: "console" }), "agent.disabled");
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    await service.setEnabled(project, "helper", false, { source: "console" });
    await expectCode(service.beginTurn(project, session.id, { text: "hi" }), "agent.disabled");
  });

  it("records messages with timestamps, titles the session, and refuses a second concurrent turn", async () => {
    const { service, project, clock } = await setup();
    await service.create(project, agentInput("helper", {}), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    const active = await service.beginTurn(project, session.id, { text: "Compare the feedback tools\nplease" });
    await expectCode(service.beginTurn(project, session.id, { text: "again" }), "agent.session_busy");
    clock.advance(2_000);
    const detail = await service.completeTurn(project, active.turn.id, { status: "succeeded", assistantText: "Done." });
    expect(detail.session).toMatchObject({ status: "open", title: "Compare the feedback tools" });
    expect(detail.messages.map((message) => [message.role, message.seq, message.createdAt])).toEqual([
      ["user", 1, "2026-10-15T12:00:00.000Z"],
      ["assistant", 2, "2026-10-15T12:00:02.000Z"],
    ]);
    expect(detail.turns[0]).toMatchObject({ seq: 1, status: "succeeded", endedAt: "2026-10-15T12:00:02.000Z" });
  });

  it("pages, filters and searches sessions, with stats", async () => {
    const { service, project, clock } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const ids: string[] = [];
    for (const text of ["alpha task", "beta task", "gamma task"]) {
      clock.advance(1_000);
      const session = await service.openSession(project, "helper", { source: text === "beta task" ? "slack" : "console" });
      const turn = await service.beginTurn(project, session.id, { text });
      await service.completeTurn(project, turn.turn.id, { status: "succeeded", assistantText: "ok" });
      ids.push(session.id);
    }
    const first = await service.listSessions(project, "helper", { limit: 2 });
    expect(first.sessions.map((session) => session.id)).toEqual([ids[2], ids[1]]);
    const second = await service.listSessions(project, "helper", { limit: 2, cursor: first.nextCursor! });
    expect(second.sessions.map((session) => session.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await service.listSessions(project, "helper", { limit: 10, source: "slack" })).sessions).toHaveLength(1);
    expect((await service.listSessions(project, "helper", { limit: 10, search: "gamma" })).sessions[0]!.id).toBe(ids[2]);
    expect(first.stats).toMatchObject({ total: 3, active: 0, last7Days: 3, turnsFinished7d: 3, turnsSucceeded7d: 3, cost7d: null, costTotal: null });
    expect(first.sessions[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "succeeded", inputTokens: 0 });
  });

  it("lists sessions of every agent with project-wide stats", async () => {
    const { service, project, clock } = await setup();
    const made: Record<string, string> = {};
    for (const agent of ["helper", "writer"]) {
      await service.create(project, agentInput(agent), { source: "console" });
      await service.setEnabled(project, agent, true, { source: "console" });
      clock.advance(1_000);
      const session = await service.openSession(project, agent, { source: "console" });
      const turn = await service.beginTurn(project, session.id, { text: `hello ${agent}` });
      await service.completeTurn(project, turn.turn.id, { status: "succeeded", assistantText: "ok" });
      made[agent] = session.id;
    }
    const all = await service.listAllSessions(project, { limit: 10 });
    expect(all.sessions.map((session) => [session.agentId, session.id])).toEqual([
      ["writer", made.writer],
      ["helper", made.helper],
    ]);
    expect(all.stats).toMatchObject({ total: 2, active: 0, last7Days: 2, turnsFinished7d: 2, turnsSucceeded7d: 2 });
    expect((await service.listAllSessions(project, { limit: 10, search: "hello helper" })).sessions.map((session) => session.agentId)).toEqual(["helper"]);
    const onlyWriter = await service.listAllSessions(project, { limit: 10 }, "writer");
    expect(onlyWriter.sessions.map((session) => session.id)).toEqual([made.writer]);
    expect(onlyWriter.stats.total).toBe(1);
  });

  it("fails turns left running by a stopped host", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    const turn = await service.beginTurn(project, session.id, { text: "hi" });
    expect(service.recoverInterruptedTurns()).toBe(1);
    const detail = await service.getSession(project, session.id);
    expect(detail.session.status).toBe("open");
    expect(detail.turns[0]).toMatchObject({ id: turn.turn.id, status: "failed", errorCode: "agent.host_restarted" });
  });

  it("keeps sessions of one project out of another", async () => {
    const { service, project } = await setup();
    await service.create(project, agentInput("helper"), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    await expectCode(service.getSession(path.join(project, "elsewhere"), session.id), "agent.session_not_found");
  });
});
