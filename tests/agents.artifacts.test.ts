import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deletePublishedArtifact, publishArtifact } from "../src/artifacts/publish.js";
import type { CatalogRoot } from "../src/config/resolveCatalogRoots.js";
import { grantedToolIds, parseAgentDefinition } from "../src/config/loadAgent.js";
import { AgentChatController } from "../src/agents/chatTurn.js";
import {
  AGENT_ARTIFACT_DELETE_SENTENCE,
  AGENT_ARTIFACT_READ_SENTENCE,
  appendAgentArtifactPrompt,
  bindAgentArtifactDelete,
  createAgentPublishArtifactTool,
} from "../src/agents/artifactTools.js";
import { createEvalGate, EvalGateRegistry } from "../src/agents/evalGate.js";
import { EVAL_SESSION_SOURCE } from "../src/agents/evalSession.js";
import { createPiAgentRuntime, type OpenSessionInput } from "../src/agents/runtime/piRuntime.js";
import type { TurnHooks } from "../src/agents/runtime/types.js";
import { classifyTool, toolRiskSummary } from "../src/agents/toolRisk.js";
import { ArtifactQueryError } from "../src/artifacts/query.js";
import { publishSessionArtifact, type SessionPublishBody } from "../src/artifacts/sessionPublish.js";
import { STATIC_CONTENT_MAX_BYTES } from "../src/artifacts/limits.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { describeToolkit } from "../src/toolkit/index.js";
import type { ToolkitTool } from "../src/toolkit/index.js";
import { publishPathBytesReadForTests, resetPublishPathBytesReadForTests } from "../src/tools/publishArtifact.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
const previousHome = process.env.STAGEFLOW_HOME;

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  if (previousHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = previousHome;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function definition(overrides: Record<string, unknown> = {}) {
  const parsed = parseAgentDefinition({ id: "helper", name: "Helper", instructions: "Help.", enabled: true, ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

function hooks(): TurnHooks {
  return {
    gate: async () => ({ allow: true }),
    toolStarted: () => undefined,
    toolFinished: () => undefined,
    modelFinished: () => undefined,
    delegate: async () => "sub",
  };
}

const assistantEnd = {
  type: "message_end",
  message: { role: "assistant", model: "m", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1, cost: { total: 0 } } },
};

function fakeOpen(script: (emit: (event: unknown) => void, input: OpenSessionInput) => Promise<void>) {
  const opened: OpenSessionInput[] = [];
  const prompts: string[] = [];
  const open = async (input: OpenSessionInput) => {
    opened.push(input);
    const listeners = new Set<(event: unknown) => void>();
    return {
      toolNames: input.toolNames,
      shutdown: async () => undefined,
      session: {
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        prompt: async (text: string) => {
          prompts.push(text);
          await script((event) => listeners.forEach((listener) => listener(event)), input);
        },
        dispose: () => undefined,
        abort: async () => undefined,
      },
    } as never;
  };
  return { open, opened, prompts };
}

const stubTools = ["get_artifact", "save_artifact", "delete_artifact", "get_run"].map((name) => ({
  name,
  grantId: `stageflow.${name}`,
  description: name,
  parameters: {},
  risk: "read" as const,
  groups: [] as [],
  toolset: "artifacts" as const,
  run: async () => ({ ok: true, text: "no" }),
}));

async function openRuntime(overrides: Record<string, unknown>, sessionId = "s1") {
  const fake = fakeOpen(async (emit) => {
    emit(assistantEnd);
  });
  const runtime = createPiAgentRuntime({ cwd: "/p", agentDir: "/a", openSession: fake.open, toolkit: () => stubTools });
  await runtime.complete({
    sessionId,
    projectRoot: "/p",
    definition: definition(overrides),
    messages: [{ role: "user", text: "go" }],
    signal: new AbortController().signal,
    onDelta: () => undefined,
    hooks: hooks(),
  });
  return fake;
}

function roots(project: string): CatalogRoot[] {
  return [{ project_root: project, path: project, kind: "registered", read_only: false }];
}

async function setup(agents: Record<string, Record<string, unknown>>) {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  process.env.STAGEFLOW_HOME = fixture.home;
  resetGlobalStageflowHomeForTests();
  for (const [id, overrides] of Object.entries(agents)) {
    await fixture.service.create(fixture.project, agentInput(id, overrides), { source: "console" });
    await fixture.service.setEnabled(fixture.project, id, true, { source: "console" });
  }
  return fixture;
}

function toolFor(fx: AgentsFixture, agentId: string, sessionId: string) {
  return createAgentPublishArtifactTool({
    agentId,
    projectRoot: fx.project,
    stageflowHome: fx.home,
    publish: (body) =>
      publishSessionArtifact(
        { db: fx.connection, roots: roots(fx.project) },
        { owner: { kind: "agent", agent: agentId }, projectRoot: fx.project, source: { sessionId } },
        body,
      ),
  });
}

const writeGrant = { tools: { stageflow: { groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup"] } } };

describe("agent artifact grants", () => {
  it("accepts artifact groups, grants publish_artifact, and rejects an unknown group", () => {
    const granted = parseAgentDefinition({
      id: "helper",
      name: "Helper",
      instructions: "Help.",
      tools: { stageflow: { groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup", "artifacts.refresh"] } },
      approvals: { ask_first: ["publish_artifact", "stageflow.get_artifact", "stageflow.delete_artifact"] },
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const ids = grantedToolIds(granted.value);
    expect(ids.has("publish_artifact")).toBe(true);
    expect(ids.has("stageflow.get_artifact")).toBe(true);
    expect(ids.has("stageflow.delete_artifact")).toBe(true);
    expect(ids.has("stageflow.save_artifact")).toBe(false);
    expect([...ids].some((id) => id.includes("refresh"))).toBe(false);
    const bare = parseAgentDefinition({
      id: "helper",
      name: "Helper",
      instructions: "Help.",
      approvals: { ask_first: ["publish_artifact"] },
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.issues.map((issue) => issue.code)).toContain("agent.ask_first_not_granted");
    const unknown = parseAgentDefinition({
      id: "helper",
      name: "Helper",
      instructions: "Help.",
      tools: { stageflow: { groups: ["artifacts.nope"] } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.map((issue) => issue.code)).toEqual(["agent.stageflow_group_unknown"]);
    const catalog = describeToolkit().groups.find((group) => group.id === "artifacts.write");
    expect(catalog?.tools.map((tool) => tool.name)).toEqual(["publish_artifact"]);
    expect(catalog?.tools[0]?.grantId).toBe("publish_artifact");
    expect(describeToolkit().toolsets.find((row) => row.id === "artifacts")?.tools).toContain("save_artifact");
  });

  it("keeps the prompt and tool list unchanged without the grant", async () => {
    const plain = await openRuntime({});
    const again = await openRuntime({ tools: { stageflow: { groups: ["runs.read"], tools: [] } } });
    expect(plain.opened[0]!.systemPrompt).toBe("Help.");
    expect(plain.opened[0]!.toolNames).toEqual([]);
    expect(plain.opened[0]!.agentPublishTool).toBeUndefined();
    expect(plain.opened[0]!.stageflowTools).toBeUndefined();
    expect(plain.prompts[0]).toBe("go");
    expect(again.opened[0]!.systemPrompt).toBe("Help.");
    expect(again.opened[0]!.agentPublishTool).toBeUndefined();
    expect(again.opened[0]!.systemPrompt).not.toContain("Published artifacts");
    expect(again.opened[0]!.systemPrompt).not.toContain(AGENT_ARTIFACT_READ_SENTENCE);
    const base = "Help.";
    expect(appendAgentArtifactPrompt(base, definition())).toBe(base);
  });

  it("adds the prompt section and publish_artifact only when artifacts.write is granted", async () => {
    const readOnly = await openRuntime({ tools: { stageflow: { groups: ["artifacts.read"] } } });
    expect(readOnly.opened[0]!.systemPrompt).toBe(`Help.\n\n${AGENT_ARTIFACT_READ_SENTENCE}`);
    expect(readOnly.opened[0]!.systemPrompt).toContain("stageflow_get_artifact");
    expect(readOnly.opened[0]!.systemPrompt).not.toContain("with get_artifact");
    expect(readOnly.opened[0]!.systemPrompt).not.toContain(AGENT_ARTIFACT_DELETE_SENTENCE);
    expect(readOnly.opened[0]!.agentPublishTool).toBeUndefined();
    expect(readOnly.opened[0]!.stageflowTools?.map((tool) => tool.name)).toEqual(["get_artifact"]);
    const cleanupOnly = await openRuntime({ tools: { stageflow: { groups: ["artifacts.cleanup"] } } });
    expect(cleanupOnly.opened[0]!.systemPrompt).toBe(`Help.\n\n${AGENT_ARTIFACT_DELETE_SENTENCE}`);
    expect(cleanupOnly.opened[0]!.systemPrompt).toContain("stageflow_delete_artifact");
    const published: Array<{ sessionId: string; agentId: string }> = [];
    const fake = fakeOpen(async (emit, input) => {
      const result = await input.agentPublishTool!.execute("call", {
        id: "weekly",
        kind: "static.markdown",
        title: "Weekly",
        content: "# Weekly\n",
      });
      expect(result.isError).toBeUndefined();
      emit(assistantEnd);
    });
    const runtime = createPiAgentRuntime({
      cwd: "/p",
      agentDir: "/a",
      openSession: fake.open,
      toolkit: () =>
        [
          { name: "save_artifact", grantId: "stageflow.save_artifact" },
          { name: "get_artifact", grantId: "stageflow.get_artifact" },
          { name: "delete_artifact", grantId: "stageflow.delete_artifact" },
        ].map((tool) => ({ ...tool, description: tool.name, parameters: {}, risk: "write", groups: [], toolset: "artifacts", run: async () => ({ ok: true, text: "no" }) })) as ToolkitTool[],
      publishAgentArtifact: async (input) => {
        published.push({ sessionId: input.sessionId, agentId: input.agentId });
        return { key: "agent:helper/weekly", version: 1, project_root: "/p" };
      },
    });
    await runtime.complete({
      sessionId: "sess-1",
      projectRoot: "/p",
      definition: definition({ tools: { stageflow: { groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup"] } } }),
      messages: [{ role: "user", text: "go" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      hooks: hooks(),
    });
    const opened = fake.opened[0]!;
    expect(opened.systemPrompt).toContain("# Published artifacts");
    expect(opened.systemPrompt).toContain("owned by this agent");
    expect(opened.systemPrompt).toContain(AGENT_ARTIFACT_READ_SENTENCE);
    expect(opened.systemPrompt).toContain("stageflow_get_artifact");
    expect(opened.systemPrompt).toContain(AGENT_ARTIFACT_DELETE_SENTENCE);
    expect(opened.systemPrompt).toContain("stageflow_delete_artifact");
    expect(opened.systemPrompt).not.toContain("with get_artifact");
    expect(opened.toolNames).toContain("publish_artifact");
    expect(opened.stageflowTools?.map((tool) => tool.name).sort()).toEqual(["delete_artifact", "get_artifact"]);
    expect(fake.prompts[0]).not.toContain("Published artifacts");
    expect(published).toEqual([{ sessionId: "sess-1", agentId: "helper" }]);
  });

  it("does not give a sub-agent the caller's artifact grant", async () => {
    const fx = await setup({
      boss: { ...writeGrant, sub_agents: ["worker"] },
      worker: { instructions: "Work." },
    });
    const seen: string[] = [];
    const backend = scriptedBackend(async (messages, ctx) => {
      seen.push(ctx.messages.at(-1)?.text ?? "");
      if (messages.at(-1)!.text === "do it") return ctx.hooks.delegate("worker", "subtask");
      return "worker done";
    });
    const chat = new AgentChatController({ service: fx.service, backend });
    await chat.send({ projectRoot: fx.project, agentId: "boss", text: "do it" });
    const worker = (await fx.service.get(fx.project, "worker")).definition!;
    const boss = (await fx.service.get(fx.project, "boss")).definition!;
    expect(grantedToolIds(boss).has("publish_artifact")).toBe(true);
    expect(grantedToolIds(worker).has("publish_artifact")).toBe(false);
    expect(seen).toContain("subtask");
    const child = await openRuntime({ id: "worker", instructions: "Work." }, "child");
    expect(child.opened[0]!.agentPublishTool).toBeUndefined();
    expect(child.opened[0]!.systemPrompt).toBe("Work.");
  });
});

describe("agent publish tool", () => {
  it("publishes from a session with that session as the source", async () => {
    const fx = await setup({ helper: writeGrant });
    let sessionId = "";
    const backend = scriptedBackend(async (_messages, ctx) => {
      const tool = toolFor(fx, "helper", sessionId);
      const result = await ctx.tool("publish_artifact", { id: "weekly", kind: "static.markdown", title: "Weekly", content: "# Weekly\n" }, async () => {
        const published = await tool.execute("call", { id: "weekly", kind: "static.markdown", title: "Weekly", content: "# Weekly\n" });
        return published.content[0]!.text;
      });
      return result.output;
    });
    const detail = await new AgentChatController({ service: fx.service, backend }).send({
      projectRoot: fx.project,
      agentId: "helper",
      text: "publish",
      onSessionOpened: (id) => {
        sessionId = id;
      },
    });
    expect(detail.turns[0]?.status).toBe("succeeded");
    const row = fx.connection.prepare(`SELECT owner_kind, owner_agent, source, source_session_id, hidden FROM artifacts WHERE id = ?`).get("weekly") as {
      owner_kind: string;
      owner_agent: string;
      source: string;
      source_session_id: string;
      hidden: number;
    };
    expect(row).toEqual({ owner_kind: "agent", owner_agent: "helper", source: "agent", source_session_id: sessionId, hidden: 0 });
    const visible = fx.connection.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE hidden = 0 AND id = ?`).get("weekly") as { n: number };
    expect(visible.n).toBe(1);
  });

  it("rejects a publish that names another owner and deletes only this agent's artifact", async () => {
    const fx = await setup({ helper: writeGrant });
    const session = await fx.service.openSession(fx.project, "helper", { source: "console" });
    const tool = toolFor(fx, "helper", session.id);
    const other = await tool.execute("call", {
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      content: "x",
      owner: { kind: "agent", agent: "other" },
    });
    const stage = await tool.execute("call", {
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      content: "x",
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    });
    expect(JSON.parse(other.content[0]!.text).code).toBe("artifact.invalid_shape");
    expect(JSON.parse(stage.content[0]!.text).code).toBe("artifact.invalid_shape");
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    await publishSessionArtifact(
      { db: fx.connection, roots: roots(fx.project) },
      { owner: { kind: "agent", agent: "helper" }, projectRoot: fx.project, source: { sessionId: session.id } },
      { id: "mine", kind: "static.text", title: "Mine", bytes: Buffer.from("mine") },
    );
    await publishArtifact(fx.connection, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      projectRoot: fx.project,
      id: "theirs",
      kind: "static.text",
      title: "Theirs",
      bytes: Buffer.from("theirs"),
      publishSource: "api",
      source: { kind: "api" },
      roots: roots(fx.project),
    });
    const ran: string[] = [];
    const wrapped = bindAgentArtifactDelete(
      {
        name: "delete_artifact",
        grantId: "stageflow.delete_artifact",
        groups: ["artifacts.cleanup"],
        risk: "destructive",
        toolset: "artifacts",
        description: "delete",
        parameters: {},
        async run(args) {
          const key = String(args.key);
          ran.push(key);
          const parts = key.split("/");
          await deletePublishedArtifact(fx.connection, parts[0]!, parts[1]!, fx.project, roots(fx.project));
          return { ok: true, text: "{}" };
        },
      },
      "helper",
      fx.project,
    );
    const refused = await wrapped.run({ key: "stage:sales:summarize/theirs" }, { signal: new AbortController().signal });
    expect(JSON.parse(refused.text).code).toBe("artifact.not_found");
    expect(ran).toEqual([]);
    expect(fx.connection.prepare(`SELECT id FROM artifacts WHERE id = ?`).get("theirs")).toBeTruthy();
    const removed = await wrapped.run({ key: "agent:helper/mine" }, { signal: new AbortController().signal });
    expect(removed.ok).toBe(true);
    expect(fx.connection.prepare(`SELECT id FROM artifacts WHERE id = ?`).get("mine")).toBeUndefined();
  });

  it("binds publish and delete to the session project through the runtime", async () => {
    const fx = await setup({ helper: writeGrant });
    const projectB = await mkdtemp(path.join(tmpdir(), "sf-agent-art-b-"));
    cleanups.push(() => rm(projectB, { recursive: true, force: true }));
    await mkdir(path.join(projectB, "agents"), { recursive: true });
    await fx.service.create(projectB, agentInput("helper", writeGrant), { source: "console" });
    await fx.service.setEnabled(projectB, "helper", true, { source: "console" });
    const both = [
      ...roots(fx.project),
      { project_root: projectB, path: projectB, kind: "registered" as const, read_only: false },
    ];
    const publishOwned = async (project: string) => {
      await publishArtifact(fx.connection, {
        owner: { kind: "agent", agent: "helper" },
        projectRoot: project,
        id: "x",
        kind: "static.text",
        title: "X",
        bytes: Buffer.from(project),
        publishSource: "api",
        source: { kind: "api" },
        roots: both,
      });
    };
    await publishOwned(fx.project);
    await publishOwned(projectB);
    const idsIn = (project: string) =>
      (
        fx.connection.prepare(`SELECT id FROM artifacts WHERE project_root_id = ? ORDER BY id`).all(project) as Array<{
          id: string;
        }>
      ).map((row) => row.id);
    const getTool: ToolkitTool = {
      name: "get_artifact",
      grantId: "stageflow.get_artifact",
      groups: ["artifacts.read"],
      risk: "read",
      toolset: "artifacts",
      description: "get",
      parameters: {},
      async run(args) {
        return { ok: true, text: JSON.stringify(args) };
      },
    };
    const deleteTool: ToolkitTool = {
      name: "delete_artifact",
      grantId: "stageflow.delete_artifact",
      groups: ["artifacts.cleanup"],
      risk: "destructive",
      toolset: "artifacts",
      description: "delete",
      parameters: {},
      async run(args) {
        const key = String(args.key);
        const slash = key.lastIndexOf("/");
        const projectRoot = typeof args.project_root === "string" ? args.project_root : undefined;
        try {
          await deletePublishedArtifact(fx.connection, key.slice(0, slash), key.slice(slash + 1), projectRoot, both);
          return { ok: true, text: "{}" };
        } catch (error) {
          if (error instanceof ArtifactQueryError) return { ok: false, text: JSON.stringify({ code: error.code }) };
          throw error;
        }
      },
    };
    const publishedProjects: string[] = [];
    const fake = fakeOpen(async (emit) => {
      emit(assistantEnd);
    });
    const runtime = createPiAgentRuntime({
      cwd: fx.project,
      agentDir: fx.home,
      openSession: fake.open,
      toolkit: () => [
        getTool,
        deleteTool,
        {
          name: "save_artifact",
          grantId: "stageflow.save_artifact",
          groups: ["artifacts.write"],
          risk: "write",
          toolset: "artifacts",
          description: "save",
          parameters: {},
          run: async () => ({ ok: true, text: "no" }),
        },
      ],
      publishAgentArtifact: async (input) => {
        publishedProjects.push(input.projectRoot);
        return publishSessionArtifact(
          { db: fx.connection, roots: both },
          { owner: { kind: "agent", agent: input.agentId }, projectRoot: input.projectRoot, source: { sessionId: input.sessionId } },
          input.body,
        );
      },
    });
    await runtime.complete({
      sessionId: "sess-bind",
      projectRoot: fx.project,
      definition: definition(writeGrant),
      messages: [{ role: "user", text: "go" }],
      signal: new AbortController().signal,
      onDelta: () => undefined,
      hooks: hooks(),
    });
    const opened = fake.opened[0]!;
    expect(opened.stageflowTools?.find((tool) => tool.name === "get_artifact")).toBe(getTool);
    const listed = await getTool.run({ list: true, project_root: projectB }, { signal: new AbortController().signal });
    expect(JSON.parse(listed.text).project_root).toBe(projectB);
    const published = await opened.agentPublishTool!.execute("call", {
      id: "y",
      kind: "static.text",
      title: "Y",
      content: "from-a",
      project_root: projectB,
    });
    expect(published.isError).toBeUndefined();
    expect(publishedProjects).toEqual([fx.project]);
    expect(idsIn(fx.project)).toEqual(["x", "y"]);
    expect(idsIn(projectB)).toEqual(["x"]);
    const wrappedDelete = opened.stageflowTools!.find((tool) => tool.name === "delete_artifact")!;
    const ctx = { signal: new AbortController().signal };
    const cross = await wrappedDelete.run({ key: "agent:helper/x", project_root: projectB }, ctx);
    expect(JSON.parse(cross.text).code).toBe("artifact.not_found");
    expect(idsIn(fx.project)).toEqual(["x", "y"]);
    expect(idsIn(projectB)).toEqual(["x"]);
    const removed = await wrappedDelete.run({ key: "agent:helper/x" }, ctx);
    expect(removed.ok).toBe(true);
    expect(idsIn(fx.project)).toEqual(["y"]);
    expect(idsIn(projectB)).toEqual(["x"]);
    const missing = await wrappedDelete.run({ key: "agent:helper/x" }, ctx);
    expect(JSON.parse(missing.text).code).toBe("artifact.not_found");
    expect(idsIn(projectB)).toEqual(["x"]);
  });

  it("reads a project file, refuses paths outside the guard, and caps size before reading", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-agent-art-"));
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-home-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    });
    process.env.STAGEFLOW_HOME = home;
    resetGlobalStageflowHomeForTests();
    await mkdir(path.join(dir, "agents"), { recursive: true });
    await writeFile(path.join(dir, "notes.md"), "hello note");
    await writeFile(path.join(dir, "agents", "helper.agent.yaml"), "id: helper\n");
    await writeFile(path.join(home, "secret.txt"), "secret");
    const outside = path.join(home, "outside.txt");
    await writeFile(outside, "out");
    await symlink(outside, path.join(dir, "linked.txt"));
    const six = path.join(dir, "six.bin");
    const fd = fs.openSync(six, "w");
    fs.ftruncateSync(fd, 6 * 1024 * 1024);
    fs.closeSync(fd);
    const stored: SessionPublishBody[] = [];
    const tool = createAgentPublishArtifactTool({
      agentId: "helper",
      projectRoot: dir,
      stageflowHome: home,
      publish: async (body) => {
        stored.push(body);
        return { key: "agent:helper/note", version: 1, project_root: dir };
      },
    });
    resetPublishPathBytesReadForTests();
    const ok = await tool.execute("call", { id: "note", kind: "static.text", title: "Note", path: "notes.md" });
    expect(ok.isError).toBeUndefined();
    expect(stored[0]?.bytes.toString("utf8")).toBe("hello note");
    for (const rawPath of ["../secret.txt", home, path.join(home, "secret.txt"), "agents/helper.agent.yaml", "linked.txt"]) {
      resetPublishPathBytesReadForTests();
      const before = stored.length;
      const denied = await tool.execute("call", { id: "note", kind: "static.text", title: "Note", path: rawPath });
      expect(JSON.parse(denied.content[0]!.text).code).toBe("artifact.invalid_shape");
      expect(publishPathBytesReadForTests()).toBe(0);
      expect(stored.length).toBe(before);
    }
    resetPublishPathBytesReadForTests();
    const huge = await tool.execute("call", { id: "note", kind: "static.text", title: "Note", path: "six.bin" });
    expect(JSON.parse(huge.content[0]!.text).code).toBe("artifact.too_large");
    expect(publishPathBytesReadForTests()).toBe(0);
    expect(STATIC_CONTENT_MAX_BYTES).toBe(5 * 1024 * 1024);
    await writeFile(path.join(dir, "binary.md"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    const binary = await tool.execute("call", { id: "note", kind: "static.markdown", title: "Note", path: "binary.md" });
    expect(JSON.parse(binary.content[0]!.text).code).toBe("artifact.invalid_shape");
    expect(JSON.parse(binary.content[0]!.text).issues[0].path).toBe("path");
    expect(stored.length).toBe(1);
    const secret = `ghp_${"b".repeat(24)}`;
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIBogIBAAJBALFakeKeyMaterialForTestsOnly1234567890", "-----END RSA PRIVATE KEY-----"].join("\n");
    await writeFile(path.join(dir, "key.pem"), `before\n${pem}\nafter`);
    const fromFile = await tool.execute("call", { id: "key", kind: "static.text", title: "Key", path: "key.pem" });
    expect(fromFile.isError).toBeUndefined();
    expect(stored.at(-1)?.bytes.toString("utf8")).toBe("before\n[redacted]\nafter");
    expect(stored.at(-1)?.bytes.toString("utf8")).not.toContain("FakeKeyMaterial");
    const fromBase64 = await tool.execute("call", {
      id: "key64",
      kind: "static.text",
      title: "Key",
      content_base64: Buffer.from(`token ${secret}\n${pem}`, "utf8").toString("base64"),
    });
    expect(fromBase64.isError).toBeUndefined();
    expect(stored.at(-1)?.bytes.toString("utf8")).not.toContain(secret);
    expect(stored.at(-1)?.bytes.toString("utf8")).not.toContain("FakeKeyMaterial");
    expect(stored.at(-1)?.bytes.toString("utf8")).toContain("[redacted]");
    const image = await tool.execute("call", {
      id: "pixels",
      kind: "static.image",
      title: "Pixels",
      content_base64: Buffer.from(`token ${secret}`, "utf8").toString("base64"),
    });
    expect(image.isError).toBeUndefined();
    expect(stored.at(-1)?.bytes.toString("utf8")).toContain(secret);
  });

  it("accepts inline text and base64, and scrubs secrets before storage", async () => {
    const fx = await setup({ helper: writeGrant });
    const session = await fx.service.openSession(fx.project, "helper", { source: "console" });
    const tool = toolFor(fx, "helper", session.id);
    const secret = `ghp_${"a".repeat(24)}`;
    const text = await tool.execute("call", {
      id: "note",
      kind: "static.markdown",
      title: "Note",
      content: `token ${secret}`,
    });
    expect(text.isError).toBeUndefined();
    const version = fx.connection.prepare(`SELECT content_hash FROM artifact_versions WHERE version = 1`).get() as { content_hash: string };
    expect(version.content_hash).not.toContain(secret);
    const file = findStoredText(fx.home);
    expect(file).not.toContain(secret);
    expect(file).toContain("[redacted]");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const image = await tool.execute("call", {
      id: "shot",
      kind: "static.image",
      title: "Shot",
      content_base64: png.toString("base64"),
    });
    expect(image.isError).toBeUndefined();
    const both = await tool.execute("call", {
      id: "note",
      kind: "static.text",
      title: "T",
      content: secret,
      path: "notes.md",
    });
    expect(both.isError).toBe(true);
    expect(both.content[0]?.text).not.toContain(secret);
    const encoded = await tool.execute("call", {
      id: "encoded",
      kind: "static.markdown",
      title: "Encoded",
      content_base64: Buffer.from(`token ${secret}`, "utf8").toString("base64"),
    });
    expect(encoded.isError).toBeUndefined();
    const stored = findStoredText(fx.home);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("[redacted]");
    const binary = await tool.execute("call", {
      id: "binary",
      kind: "static.markdown",
      title: "Binary",
      content_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]).toString("base64"),
    });
    expect(binary.isError).toBe(true);
    const binaryPayload = JSON.parse(binary.content[0]!.text) as { code: string; issues: Array<{ path: string }> };
    expect(binaryPayload.code).toBe("artifact.invalid_shape");
    expect(binaryPayload.issues[0]?.path).toBe("content");
    expect(fx.connection.prepare(`SELECT id FROM artifacts WHERE id = ?`).get("binary")).toBeUndefined();
  });

  it("pauses the turn when publish_artifact is ask-first and publishes after approval", async () => {
    const fx = await setup({
      helper: {
        tools: { stageflow: { groups: ["artifacts.write"] } },
        approvals: { ask_first: ["publish_artifact"], timeout_minutes: 30, on_timeout: "skip" },
      },
    });
    let sessionId = "";
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool(
        "publish_artifact",
        { id: "weekly", kind: "static.markdown", title: "Weekly", content: "approved" },
        async () => {
          const published = await toolFor(fx, "helper", sessionId).execute("call", {
            id: "weekly",
            kind: "static.markdown",
            title: "Weekly",
            content: "approved",
          });
          return published.content[0]!.text;
        },
      );
      return result.output;
    });
    const chat = new AgentChatController({ service: fx.service, backend });
    const turn = chat.send({
      projectRoot: fx.project,
      agentId: "helper",
      text: "go",
      onSessionOpened: (id) => {
        sessionId = id;
      },
    });
    await vi.waitFor(async () => expect((await fx.service.getSession(fx.project, sessionId)).turns[0]?.status).toBe("waiting"));
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    await fx.service.decideApproval(fx.project, sessionId, "approve", { kind: "operator" });
    const detail = await turn;
    expect(detail.turns[0]?.status).toBe("succeeded");
    const row = fx.connection.prepare(`SELECT source_session_id FROM artifacts WHERE id = ?`).get("weekly") as { source_session_id: string };
    expect(row.source_session_id).toBe(sessionId);
  });
});

describe("eval sessions and artifact tools", () => {
  it("classifies publish as write and delete as destructive, and lists them for the picker", () => {
    const parsed = definition(writeGrant);
    expect(classifyTool(parsed, "publish_artifact").class).toBe("write");
    expect(classifyTool(parsed, "publish_artifact").readOnly).toBe(false);
    expect(classifyTool(parsed, "stageflow.delete_artifact").class).toBe("destructive");
    expect(classifyTool(parsed, "stageflow.get_artifact")).toEqual({ class: "read", readOnly: true });
    const summary = toolRiskSummary(parsed);
    expect(summary).toEqual(
      expect.arrayContaining([
        { tool: "publish_artifact", class: "write", readOnly: false },
        { tool: "stageflow.delete_artifact", class: "destructive", readOnly: false },
        { tool: "stageflow.get_artifact", class: "read", readOnly: true },
      ]),
    );
  });

  it("stubs publish under read_only, hides an eval publish when real, and creates no approval", async () => {
    const fx = await setup({
      helper: { tools: { stageflow: { groups: ["artifacts.read", "artifacts.write", "artifacts.cleanup"] } } },
      asker: {
        tools: { stageflow: { groups: ["artifacts.write"] } },
        approvals: { ask_first: ["publish_artifact"], timeout_minutes: 30, on_timeout: "skip" },
      },
    });
    const definitionRow = (await fx.service.get(fx.project, "helper")).definition!;
    const session = await fx.service.openSession(fx.project, "helper", { source: EVAL_SESSION_SOURCE, eval: {} });
    const evalGates = new EvalGateRegistry();
    let ran = false;
    evalGates.set(
      session.id,
      createEvalGate({
        policy: { tools: "read_only", approvals: "record_only", readOnlyTools: [], mocks: {} },
        definition: definitionRow,
        projectRoot: fx.project,
      }),
    );
    const stubbed = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool("publish_artifact", { id: "weekly", content: "x" }, async () => {
        ran = true;
        return "ran";
      });
      const read = await ctx.tool("stageflow.get_artifact", { list: true }, async () => "listed");
      const removed = await ctx.tool("stageflow.delete_artifact", { key: "agent:helper/weekly" }, async () => "deleted");
      expect(read.ran).toBe(true);
      expect(removed.ran).toBe(false);
      expect(removed.output).toContain("was not executed");
      return result.output;
    });
    const stubDetail = await new AgentChatController({ service: fx.service, backend: stubbed, evalGates }).send({
      projectRoot: fx.project,
      agentId: "helper",
      sessionId: session.id,
      text: "go",
      source: "eval",
    });
    expect(ran).toBe(false);
    expect(stubDetail.turns[0]?.status).toBe("succeeded");
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get()).toEqual({ n: 0 });
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM agent_approvals`).get()).toEqual({ n: 0 });

    const realSession = await fx.service.openSession(fx.project, "helper", { source: EVAL_SESSION_SOURCE, eval: {} });
    evalGates.set(
      realSession.id,
      createEvalGate({
        policy: { tools: "real", approvals: "record_only", readOnlyTools: [], mocks: {} },
        definition: definitionRow,
        projectRoot: fx.project,
      }),
    );
    const real = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool("publish_artifact", { id: "weekly", kind: "static.markdown", title: "Weekly", content: "hidden" }, async () => {
        const published = await toolFor(fx, "helper", realSession.id).execute("call", {
          id: "weekly",
          kind: "static.markdown",
          title: "Weekly",
          content: "hidden",
        });
        return published.content[0]!.text;
      });
      return result.output;
    });
    await new AgentChatController({ service: fx.service, backend: real, evalGates }).send({
      projectRoot: fx.project,
      agentId: "helper",
      sessionId: realSession.id,
      text: "go",
      source: "eval",
    });
    const row = fx.connection.prepare(`SELECT hidden, key FROM artifacts WHERE id = ?`).get("weekly") as { hidden: number; key: string };
    expect(row.hidden).toBe(1);
    expect(row.key).toContain(`eval:agent:helper/weekly`);
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE hidden = 0`).get()).toEqual({ n: 0 });
    const asker = (await fx.service.get(fx.project, "asker")).definition!;
    const askSession = await fx.service.openSession(fx.project, "asker", { source: EVAL_SESSION_SOURCE, eval: {} });
    evalGates.set(
      askSession.id,
      createEvalGate({
        policy: { tools: "real", approvals: "record_only", readOnlyTools: [], mocks: {} },
        definition: asker,
        projectRoot: fx.project,
      }),
    );
    const asked = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool("publish_artifact", { id: "nope", kind: "static.text", title: "No", content: "x" }, async () => "ran");
      expect(result.ran).toBe(false);
      return result.output;
    });
    await new AgentChatController({ service: fx.service, backend: asked, evalGates }).send({
      projectRoot: fx.project,
      agentId: "asker",
      sessionId: askSession.id,
      text: "go",
      source: "eval",
    });
    expect(evalGates.get(askSession.id)!.records()[0]?.policyOutcome).toBe("would_ask_first");
    expect(fx.connection.prepare(`SELECT COUNT(*) AS n FROM agent_approvals`).get()).toEqual({ n: 0 });
    expect(await fx.service.pendingApprovals(fx.project)).toEqual([]);
  });

  it("hides a publish when the session source cannot be read", async () => {
    const fx = await setup({ helper: writeGrant });
    const session = await fx.service.openSession(fx.project, "helper", { source: "console" });
    const db = new Proxy(fx.connection, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("agent_sessions")) throw new Error("db down");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await publishSessionArtifact(
      { db: db as unknown as typeof fx.connection, roots: roots(fx.project) },
      { owner: { kind: "agent", agent: "helper" }, projectRoot: fx.project, source: { sessionId: session.id } },
      { id: "hidden-note", kind: "static.text", title: "Hidden", bytes: Buffer.from("x") },
    );
    expect(result.key).toContain("eval:agent:helper/hidden-note");
    const row = fx.connection.prepare(`SELECT hidden FROM artifacts WHERE id = ?`).get("hidden-note") as { hidden: number };
    expect(row.hidden).toBe(1);
  });
});

function findStoredText(home: string): string {
  const root = path.join(home, "artifacts");
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && stat.size < 1024 * 1024) chunks.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(root);
  return chunks.join("\n");
}
