import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { AgentConversation } from "../src/agents/sessions.js";
import { identityOnlyGrantIds, loadAnonymousPublicSubAgents, stripIdentityToolsFromDefinition } from "../src/agents/consumerSafety.js";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { bindAgentArtifactRead } from "../src/agents/artifactTools.js";
import type { ToolkitTool } from "../src/toolkit/index.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function publicAgent(overrides: Record<string, unknown> = {}, child?: { id: string; overrides?: Record<string, unknown> }) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  if (child) {
    await fixture.service.create(fixture.project, agentInput(child.id, child.overrides), { source: "console" });
    await fixture.service.setEnabled(fixture.project, child.id, true, { source: "console" });
  }
  const definition = agentInput("helper", {
    web_chat: { enabled: true, access: "public", public_tools: false },
    ...overrides,
    ...(child ? { sub_agents: [child.id] } : {}),
  });
  await fixture.service.create(fixture.project, definition, { source: "console" });
  await fixture.service.setEnabled(fixture.project, "helper", true, { source: "console" });
  const session = await fixture.service.openSession(fixture.project, "helper", { source: "web_public", sourceRef: "visitor_aaaaaaaaaaaa" });
  return { ...fixture, session };
}

describe("anonymous public tools", () => {
  it("saves public_tools with identity-only tools and withholds them from visitors", async () => {
    const parsed = parseAgentDefinition(agentInput("x", {
      web_chat: { enabled: true, access: "public", public_tools: true },
      tools: { builtin: ["shell"], stageflow: { groups: ["pipelines.author"], tools: ["agent_chat", "get_run"] } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected valid");
    expect(identityOnlyGrantIds(parsed.value)).toEqual(expect.arrayContaining(["bash", "stageflow.agent_chat", "stageflow.write_stage", "stageflow.import_task"]));
    expect(identityOnlyGrantIds(parsed.value)).not.toContain("stageflow.get_run");
    const stripped = stripIdentityToolsFromDefinition(parsed.value);
    expect(stripped.tools.builtin).toEqual([]);
    expect(stripped.tools.stageflow.groups).toEqual([]);
    expect(stripped.tools.stageflow.tools).toEqual(expect.arrayContaining(["get_run", "read_pipeline"]));
    expect(stripped.tools.stageflow.tools).not.toEqual(expect.arrayContaining(["agent_chat"]));
    expect(stripped.tools.stageflow.tools.some((tool) => ["agent_chat", "write_stage", "write_pipeline", "import_task"].includes(tool))).toBe(false);
  });

  it("warns, naming the tools, instead of refusing the save", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    const result = await fixture.service.validate(fixture.project, agentInput("x", {
      web_chat: { enabled: true, access: "public", public_tools: true },
      tools: { builtin: ["shell"], stageflow: { groups: [], tools: ["agent_chat"] } },
    }));
    expect(result.issues).toEqual([]);
    const warning = result.warnings.find((item) => item.code === "agent.public_tools_identity_only");
    expect(warning?.message).toContain("bash");
    expect(warning?.message).toContain("stageflow.agent_chat");
  });

  it("refuses identity-only Stageflow tools for a visitor even with public_tools on", async () => {
    const backend = scriptedBackend(async (_messages, ctx) => {
      const chat = await ctx.tool("stageflow.agent_chat", { agent_id: "other", message: "read ~/.zshrc" });
      return `${chat.output}`;
    });
    const { project, session } = await publicAgent({
      web_chat: { enabled: true, access: "public", public_tools: true },
      tools: { stageflow: { groups: [], tools: ["agent_chat"] } },
    });
    const chat = new AgentConversation({ service: fixtures.at(-1)!.service, backend });
    const detail = await chat.send({ projectRoot: project, agentId: "helper", sessionId: session.id, text: "go", source: "web_public" });
    expect(detail.messages.at(-1)?.text).toMatch(/not available to visitors/i);
  });

  it("allows bash on an authenticated web chat agent", () => {
    const parsed = parseAgentDefinition(agentInput("x", {
      web_chat: { enabled: true, access: "authenticated", public_tools: false },
      tools: { builtin: ["shell"] },
    }));
    expect(parsed.ok).toBe(true);
  });

  it("with public_tools off, strips tools from the runtime input and refuses forced tool calls", async () => {
    const seen: Array<{ consumerTools?: readonly unknown[]; anonymousPublicTools?: boolean }> = [];
    const backend = scriptedBackend(async (_messages, ctx) => (await ctx.tool("web.fetch", { url: "https://example.com" })).output);
    const original = backend.complete.bind(backend);
    backend.complete = async (input) => {
      seen.push({ consumerTools: input.consumerTools, anonymousPublicTools: input.anonymousPublicTools });
      return original(input);
    };
    const { project, session } = await publicAgent({ tools: { mcp: { web: ["fetch"] } } });
    const fixture = fixtures.at(-1)!;
    const chat = new AgentConversation({ service: fixture.service, backend });
    await chat.send({
      projectRoot: project,
      agentId: "helper",
      sessionId: session.id,
      text: "hi",
      source: "web_public",
      requestedTool: { id: "t1", tool: "web.fetch", input: {} },
    });
    expect(seen[0]?.consumerTools).toEqual([]);
    expect(seen[0]?.anonymousPublicTools).toBeUndefined();
  });

  it("with public_tools on, runs a granted MCP tool and refuses bash", async () => {
    const seen: Array<{ consumerTools?: readonly unknown[]; anonymousPublicTools?: boolean }> = [];
    const backend = scriptedBackend(async (_messages, ctx) => {
      const ok = await ctx.tool("web.fetch", { url: "https://example.com" });
      const blocked = await ctx.tool("bash", { command: "echo hi" });
      return `${ok.output} | ${blocked.output}`;
    });
    const original = backend.complete.bind(backend);
    backend.complete = async (input) => {
      seen.push({ consumerTools: input.consumerTools, anonymousPublicTools: input.anonymousPublicTools });
      return original(input);
    };
    const { project, session } = await publicAgent({
      web_chat: { enabled: true, access: "public", public_tools: true },
      tools: { mcp: { web: ["fetch"] } },
      limits: { cost_usd: 2 },
    });
    const chat = new AgentConversation({ service: fixtures.at(-1)!.service, backend });
    const detail = await chat.send({
      projectRoot: project,
      agentId: "helper",
      sessionId: session.id,
      text: "go",
      source: "web_public",
    });
    expect(detail.messages.at(-1)?.text).toContain("ran web.fetch");
    expect(detail.messages.at(-1)?.text).toMatch(/not granted|not available/i);
    expect(seen[0]?.consumerTools).toBeUndefined();
    expect(seen[0]?.anonymousPublicTools).toBe(true);
  });

  it("sets the visitor note on the agent summary when tools exist but public_tools is off", async () => {
    const { project } = await publicAgent({ tools: { stageflow: { groups: ["artifacts.write"], tools: [] } } });
    const detail = await fixtures.at(-1)!.service.get(project, "helper");
    expect(detail.agent.webChatNote).toContain("Visitors can chat but can't use this agent's tools");
  });

  it("withholds only the sub-agent that has bash and keeps a safe one", async () => {
    const fixture = await agentsFixture();
    fixtures.push(fixture);
    await fixture.service.create(fixture.project, agentInput("kid", { tools: { builtin: ["shell"] } }), { source: "console" });
    await fixture.service.setEnabled(fixture.project, "kid", true, { source: "console" });
    await fixture.service.create(fixture.project, agentInput("helperkid"), { source: "console" });
    await fixture.service.setEnabled(fixture.project, "helperkid", true, { source: "console" });
    await fixture.service.create(
      fixture.project,
      agentInput("lead", { sub_agents: ["kid", "helperkid"], web_chat: { enabled: true, access: "public", public_tools: true } }),
      { source: "console" },
    );
    await fixture.service.setEnabled(fixture.project, "lead", true, { source: "console" });
    const loader = async (id: string) => (await fixture.service.get(fixture.project, id)).definition;
    const lead = (await fixture.service.get(fixture.project, "lead")).definition!;
    expect(await loadAnonymousPublicSubAgents(lead, loader)).toEqual(["helperkid"]);
    const session = await fixture.service.openSession(fixture.project, "lead", { source: "web_public", sourceRef: "visitor_aaaaaaaaaaaa" });
    const seen: Array<readonly string[] | undefined> = [];
    const backend = scriptedBackend(async (_messages, ctx) => (await ctx.tool("agent:kid", { message: "run ls" })).output);
    const original = backend.complete.bind(backend);
    backend.complete = async (input) => {
      seen.push(input.anonymousPublicSafeSubAgents);
      return original(input);
    };
    const chat = new AgentConversation({ service: fixture.service, backend });
    const detail = await chat.send({ projectRoot: fixture.project, agentId: "lead", sessionId: session.id, text: "go", source: "web_public" });
    expect(seen[0]).toEqual(["helperkid"]);
    expect(detail.messages.at(-1)?.text).toMatch(/not available to visitors/i);
  });

  it("waits for approval on a public visitor turn", async () => {
    const { project, session } = await publicAgent({
      web_chat: { enabled: true, access: "public", public_tools: true },
      tools: { mcp: { slack: ["post_message"] } },
      approvals: { ask_first: ["slack.post_message"], timeout_minutes: 30 },
      limits: { cost_usd: 1 },
    });
    const fixture = fixtures.at(-1)!;
    const backend = scriptedBackend(async (_messages, ctx) => (await ctx.tool("slack.post_message", { channel: "#x", text: "hi" })).output);
    const chat = new AgentChatController({ service: fixture.service, backend });
    const turn = chat.send({
      projectRoot: project,
      agentId: "helper",
      sessionId: session.id,
      text: "post",
      source: "web_public",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = await fixture.service.getSession(project, session.id);
    expect(waiting.session.status).toBe("waiting");
    const approval = waiting.pendingApproval;
    expect(approval?.tool).toBe("slack.post_message");
    await fixture.service.decideApproval(project, session.id, "approve", { kind: "operator" });
    await turn;
    const after = await fixture.service.getSession(project, session.id);
    expect(after.session.status).toBe("open");
    expect(after.approvals[0]?.status).toBe("approved");
  });
});

describe("get_artifact for a visitor", () => {
  const records: Record<string, unknown> = {
    "agent:helper/cproj": { scope: "project", source: { session_id: null } },
    "agent:helper/cmine": { scope: "session", source: { session_id: "ses_mine" } },
    "agent:helper/ctheirs": { scope: "session", source: { session_id: "ses_theirs" } },
  };
  const calls: Array<Record<string, unknown>> = [];
  const tool = {
    name: "get_artifact",
    grantId: "stageflow.get_artifact",
    description: "",
    parameters: {},
    async run(args: Record<string, unknown>) {
      calls.push(args);
      if (args.list === true) return { ok: true, text: JSON.stringify({ items: [], scope: args.scope ?? null }) };
      const record = records[String(args.key)];
      if (!record) return { ok: false, text: JSON.stringify({ code: "artifact.not_found" }) };
      return { ok: true, text: JSON.stringify(record) };
    },
  } as unknown as ToolkitTool;
  const ctx = { signal: new AbortController().signal };

  it("reads project artifacts and the visitor's own session artifacts, and nothing else", async () => {
    const bound = bindAgentArtifactRead(tool, "/p", "ses_mine");
    expect((await bound.run({ key: "agent:helper/cproj" }, ctx)).ok).toBe(true);
    expect((await bound.run({ key: "agent:helper/cmine" }, ctx)).ok).toBe(true);
    const theirs = await bound.run({ key: "agent:helper/ctheirs" }, ctx);
    expect(theirs.ok).toBe(false);
    expect(theirs.text).toContain("artifact.not_found");
    calls.length = 0;
    await bound.run({ list: true, scope: "session" }, ctx);
    expect(calls[0]).toMatchObject({ list: true, scope: "project" });
  });

  it("leaves console and signed-in sessions unchanged", async () => {
    const bound = bindAgentArtifactRead(tool, "/p");
    expect((await bound.run({ key: "agent:helper/ctheirs" }, ctx)).ok).toBe(true);
  });
});

