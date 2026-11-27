import { afterEach, describe, expect, it } from "vitest";
import { agentProjectKey } from "../src/agents/store.js";
import { parseAgentDefinition, serializeAgentDefinition, type AgentDefinition } from "../src/config/loadAgent.js";
import { checkAgentCaller } from "../src/toolkit/guard.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";
import { AgentError } from "../src/agents/errors.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function setup() {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  return fixture;
}

function definitionBody(id: string, overrides: Record<string, unknown> = {}): AgentDefinition {
  const parsed = parseAgentDefinition(agentInput(id, overrides));
  if (!parsed.ok) throw new Error(parsed.issues.map((i) => i.message).join("; "));
  return parsed.value;
}

function patchRevision(fixture: AgentsFixture, agentId: string, revision: number, mutate: (definition: AgentDefinition) => AgentDefinition): void {
  const projectKey = agentProjectKey(fixture.project);
  const existing = fixture.store.getRevision(projectKey, agentId, revision);
  if (!existing) throw new Error("missing revision");
  const definition = mutate(existing.definition);
  fixture.connection
    .prepare(
      `UPDATE agent_revisions SET definition_json = ?, yaml_text = ? WHERE project_key = ? AND agent_id = ? AND revision = ?`,
    )
    .run(JSON.stringify(definition), serializeAgentDefinition(definition), projectKey, agentId, revision);
}

function appendRevision(fixture: AgentsFixture, agentId: string, mutate: (definition: AgentDefinition) => AgentDefinition): number {
  const projectKey = agentProjectKey(fixture.project);
  const row = fixture.store.getDefinition(projectKey, agentId);
  const current = row?.currentRevision ?? 0;
  const base =
    current > 0 ? fixture.store.getRevision(projectKey, agentId, current)?.definition : definitionBody(agentId);
  if (!base) throw new Error("missing definition");
  const definition = mutate(base);
  return fixture.store.appendRevision(projectKey, {
    definition,
    yaml: serializeAgentDefinition(definition),
    source: "console",
    summary: "revision",
    fileHash: "test",
    now: fixture.clock.now.toISOString(),
  });
}

describe("stale Stageflow tool names", () => {
  it("rejects grants of renamed tools and names the replacement", () => {
    const parsed = parseAgentDefinition({
      id: "x",
      name: "x",
      instructions: "x",
      tools: { stageflow: { tools: ["list_runs"] } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]).toMatchObject({
        code: "agent.stageflow_tool_unknown",
        message: expect.stringContaining("get_run"),
      });
    }
  });

  it("rejects stale names in approvals.ask_first", () => {
    const parsed = parseAgentDefinition({
      id: "x",
      name: "x",
      instructions: "x",
      tools: { stageflow: { tools: ["set_agent_enabled"] } },
      approvals: { ask_first: ["stageflow.enable_agent"] },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.some((i) => i.code === "agent.stageflow_tool_unknown" && i.message.includes("set_agent_enabled"))).toBe(true);
    }
  });

  it("warns when a surviving tool grant now covers more modes", async () => {
    const { service, project } = await setup();
    const detail = await service.validate(project, agentInput("ops", { tools: { stageflow: { tools: ["start_run"] } } }));
    expect(detail.issues).toEqual([]);
    expect(detail.warnings.some((w) => w.code === "agent.stageflow_tool_widened" && w.message.includes("run_stage"))).toBe(true);
  });

  it("ends a stale pinned session at the next turn", async () => {
    const fixture = await setup();
    const { service, project } = fixture;
    await service.create(project, agentInput("helper", { tools: { stageflow: { tools: ["get_run"] } } }), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const session = await service.openSession(project, "helper", { source: "console" });
    patchRevision(fixture, "helper", session.revision, (definition) => ({
      ...definition,
      approvals: { ...definition.approvals, ask_first: ["stageflow.enable_agent"] },
    }));
    await expect(service.beginTurn(project, session.id, { text: "Hi" })).rejects.toMatchObject({
      code: "agent.stale_stageflow_tools",
    });
  });

  it("shows stale tool issues on the agent list entry", async () => {
    const { service, project, writeAgentFile } = await setup();
    await service.create(project, agentInput("helper", { tools: { stageflow: { tools: ["get_run"] } } }), { source: "console" });
    await writeAgentFile(
      "helper",
      ["id: helper", "name: Agent helper", "instructions: Be helpful.", "tools:", "  stageflow:", "    tools:", "      - list_runs"].join("\n") +
        "\n",
    );
    await service.list(project);
    const listed = await service.list(project);
    expect(listed[0]?.issues.some((i) => i.code === "agent.stageflow_tool_unknown" && i.message.includes("get_run"))).toBe(true);
  });

  it("opens a new session on the current revision after a stale one is fixed", async () => {
    const fixture = await setup();
    const { service, project } = fixture;
    await service.create(project, agentInput("helper", { tools: { stageflow: { tools: ["get_run"] } } }), { source: "console" });
    await service.setEnabled(project, "helper", true, { source: "console" });
    const stale = await service.openSession(project, "helper", { source: "console" });
    patchRevision(fixture, "helper", stale.revision, (definition) => ({
      ...definition,
      approvals: { ...definition.approvals, ask_first: ["stageflow.enable_agent"] },
    }));
    await service.beginTurn(project, stale.id, { text: "first" }).catch(() => undefined);
    await service.save(
      project,
      "helper",
      { baseRevision: (await service.get(project, "helper")).agent.revision, definition: agentInput("helper", { tools: { stageflow: { tools: ["get_run"] } } }) },
      { source: "console" },
    );
    await service.setEnabled(project, "helper", true, { source: "console" });
    const next = await service.openSession(project, "helper", { source: "console" });
    expect(next.revision).toBe((await service.get(project, "helper")).agent.revision);
    expect(next.id).not.toBe(stale.id);
    await expect(service.beginTurn(project, next.id, { text: "second" })).resolves.toBeDefined();
  });

  it("surfaces stale tools on an interrupted always-on turn", async () => {
    const fixture = await setup();
    const { service, project } = fixture;
    await service.create(
      project,
      agentInput("im_helper", {
        limits: { always_on: true },
        channel: { connection_id: "conn_im", allow_from: ["+15551212"] },
        tools: { stageflow: { tools: ["get_run"] } },
      }),
      { source: "console" },
    );
    await service.setEnabled(project, "im_helper", true, { source: "console" });
    const session = await service.openSession(project, "im_helper", {
      source: "imessage",
      sourceRef: "+15551212",
      threadKey: "imessage\0conn_im\0thread1",
    });
    const active = await service.beginTurn(project, session.id, { text: "Ping" });
    patchRevision(fixture, "im_helper", session.revision, (definition) => ({
      ...definition,
      approvals: { ...definition.approvals, ask_first: ["stageflow.enable_agent"] },
    }));
    service.recoverInterruptedTurns();
    expect(await service.resumableTurns(project)).toEqual([]);
    const failed = (await service.getSession(project, session.id)).turns.find((turn) => turn.id === active.turn.id);
    expect(failed?.errorCode).toBe("agent.stale_stageflow_tools");
  });

  it("refuses restoring a stale revision through the escalation guard", async () => {
    const fixture = await setup();
    const { service, project } = fixture;
    await service.create(project, agentInput("helper", { tools: { stageflow: { tools: ["delete_runs"] } } }), { source: "console" });
    const staleRevision = appendRevision(fixture, "helper", (definition) => ({
      ...definition,
      tools: { ...definition.tools, stageflow: { ...definition.tools.stageflow, tools: ["delete_run"] } },
    }));
    const latest = await service.get(project, "helper");
    const guard = await checkAgentCaller(
      "save_agent",
      { mode: "update", id: "helper", revision: staleRevision, baseRevision: latest.agent.revision },
      { agentId: "boss", definition: definitionBody("boss", { tools: { stageflow: { groups: ["agents.manage"] } } }) },
      service,
      project,
    );
    expect(guard?.ok).toBe(false);
    expect(guard?.message).toContain("delete_runs");
  });

  it("refuses restore() when the revision names a renamed tool", async () => {
    const fixture = await setup();
    const { service, project } = fixture;
    await service.create(project, agentInput("helper", { tools: { stageflow: { tools: ["get_run"] } } }), { source: "console" });
    const staleRevision = appendRevision(fixture, "helper", (definition) => ({
      ...definition,
      tools: { ...definition.tools, stageflow: { ...definition.tools.stageflow, tools: ["list_runs"] } },
    }));
    appendRevision(fixture, "helper", (definition) => ({
      ...definition,
      tools: { ...definition.tools, stageflow: { ...definition.tools.stageflow, tools: ["get_run"] } },
    }));
    const latest = await service.get(project, "helper");
    await expect(
      service.restore(project, "helper", { revision: staleRevision, baseRevision: latest.agent.revision }, { source: "console" }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});