import { describe, expect, it, vi } from "vitest";
import { parseAgentDefinition, parseAgentYaml, serializeAgentDefinition, grantedToolIds } from "../src/config/loadAgent.js";
import type { AgentDefinition } from "../src/config/loadAgent.js";
import { buildToolkit, describeToolkit, grantedStageflowTools, grantsBeyond, plainDescription, TOOL_GROUPS, TOOL_META, TOOLSETS } from "../src/toolkit/index.js";
import { toolsInToolset } from "../src/toolkit/meta.js";
import { recordMcpTools } from "../src/toolkit/record.js";
import { checkAgentCaller } from "../src/toolkit/guard.js";
import { grantIdForPiTool } from "../src/agents/runtime/types.js";

function agent(id: string, tools: Record<string, unknown> = {}): AgentDefinition {
  const parsed = parseAgentDefinition({ id, name: id, instructions: "x", tools });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

const fakeService = {
  getSession: vi.fn(async () => ({ session: { agentId: "boss" } })),
  get: vi.fn(async () => ({ definition: agent("big", { builtin: ["shell"] }) })),
  definitionAt: vi.fn(async () => agent("big", { builtin: ["shell"] })),
};
const deps = { cwd: "/x", store: {} as never, manager: {} as never, agentService: fakeService as never, agentChat: {} as never };

describe("toolkit registry", () => {
  it("has metadata for every MCP tool and a tool for every metadata entry", () => {
    const names = recordMcpTools(deps).map((tool) => tool.name).sort();
    expect(names).toEqual(Object.keys(TOOL_META).sort());
    const groups = new Set(TOOL_GROUPS.map((group) => group.id));
    for (const meta of Object.values(TOOL_META)) for (const group of meta.groups) expect(groups.has(group)).toBe(true);
    expect(buildToolkit(deps).length).toBe(names.length);
  });

  it("covers every tool with exactly one toolset", () => {
    const toolsetIds = new Set(TOOLSETS.map((entry) => entry.id));
    const assigned = new Set<string>();
    for (const [name, meta] of Object.entries(TOOL_META)) {
      expect(toolsetIds.has(meta.toolset)).toBe(true);
      assigned.add(name);
    }
    expect(assigned.size).toBe(Object.keys(TOOL_META).length);
    expect(
      [
        ...toolsInToolset("core"),
        ...toolsInToolset("runs"),
        ...toolsInToolset("catalog"),
        ...toolsInToolset("agents"),
        ...toolsInToolset("evals"),
        ...toolsInToolset("functions"),
        ...toolsInToolset("triggers"),
        ...toolsInToolset("connections"),
        ...toolsInToolset("memories"),
        ...toolsInToolset("artifacts"),
      ].sort(),
    ).toEqual(Object.keys(TOOL_META).sort());
  });

  it("describes tool arguments as JSON schema", () => {
    const startRun = buildToolkit(deps).find((tool) => tool.name === "start_run")!;
    expect(startRun.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: expect.objectContaining({
        pipeline: expect.anything(),
        stage: expect.anything(),
        from_run: expect.anything(),
      }),
    });
    expect(startRun.grantId).toBe("stageflow.start_run");
  });

  it("expands groups and single tools into one sorted list", () => {
    expect(grantedStageflowTools({ groups: ["gates.read"], tools: ["get_run", "nope"] })).toEqual(["get_run", "list_waiting"]);
  });

  it("maps Pi tool names to grant ids", () => {
    expect(grantIdForPiTool("stageflow_start_run", [], [])).toBe("stageflow.start_run");
    expect(grantIdForPiTool("stageflow_unknown", [], [])).toBe("stageflow_unknown");
  });
});

describe("operator-only tools", () => {
  const defn = (tools: Record<string, unknown>) => parseAgentDefinition({ id: "x", name: "x", instructions: "x", tools: { stageflow: tools } });

  it("cannot be granted as a group or one by one", () => {
    const group = defn({ groups: ["gates.decide"] });
    const single = defn({ tools: ["decide_agent_action", "answer_gate", "get_started"] });
    expect(group.ok).toBe(false);
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.issues.map((i) => i.code)).toEqual(["agent.stageflow_operator_only", "agent.stageflow_operator_only", "agent.stageflow_operator_only"]);
  });

  it("are left out when a group is expanded and hidden from the grant ids", () => {
    expect(grantedStageflowTools({ groups: ["discover", "gates.decide"], tools: [] })).not.toContain("get_started");
    expect(grantedStageflowTools({ groups: ["gates.decide"], tools: [] })).toEqual([]);
  });

  it("is split from the destructive tools, which have their own groups", () => {
    expect(TOOL_META.delete_runs!.groups).toEqual(["runs.cleanup"]);
    expect(TOOL_META.archive_agent!.groups).toEqual(["agents.cleanup"]);
    expect(TOOL_META.start_run!.groups).toEqual(["runs.control"]);
    expect(describeToolkit().groups.find((g) => g.id === "gates.decide")).toMatchObject({ operatorOnly: true });
  });

  it("strips HTTP route mentions from tool text", () => {
    expect(plainDescription("List triggers (same source as GET /api/triggers): manual or schedule. Same write path as PUT /api/triggers/:id.")).toBe("List triggers: manual or schedule.");
    expect(describeToolkit().groups.flatMap((g) => g.tools).some((tool) => tool.description.includes("/api/"))).toBe(false);
  });

  it("lists every toolset with tool names for the console MCP picker", () => {
    const catalog = describeToolkit();
    expect(catalog.toolsets.map((row) => row.id).sort()).toEqual(TOOLSETS.map((row) => row.id).sort());
    for (const row of catalog.toolsets) {
      const meta = TOOLSETS.find((entry) => entry.id === row.id);
      expect(row.title).toBe(meta?.title);
      expect(row.summary).toBe(meta?.summary);
      expect(row.tools).toEqual(
        Object.entries(TOOL_META)
          .filter(([, tool]) => tool.toolset === row.id)
          .map(([name]) => name)
          .sort(),
      );
    }
    const core = catalog.toolsets.find((row) => row.id === "core");
    expect(core?.tools.length).toBe(18);
  });
});

describe("definition grants", () => {
  it("grants groups and tools as stageflow.<tool> ids and round-trips through YAML", () => {
    const definition = agent("ops", { stageflow: { groups: ["runs.read"], tools: ["start_run"] } });
    const ids = grantedToolIds(definition);
    expect(ids.has("stageflow.get_run")).toBe(true);
    expect(ids.has("stageflow.start_run")).toBe(true);
    expect(ids.has("stageflow.cancel_run")).toBe(false);
    const yaml = serializeAgentDefinition(definition);
    expect(yaml).toContain("stageflow:");
    const again = parseAgentYaml(yaml);
    expect(again.ok && again.value.tools.stageflow).toEqual({ groups: ["runs.read"], tools: ["start_run"] });
    expect(serializeAgentDefinition(agent("plain"))).not.toContain("stageflow");
  });

  it("rejects unknown groups and tools, and an MCP server named stageflow", () => {
    const bad = parseAgentDefinition({ id: "x", name: "x", instructions: "x", tools: { stageflow: { groups: ["nope"], tools: ["nada"] }, mcp: { stageflow: ["*"] } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.code).sort()).toEqual(["agent.mcp_name_reserved", "agent.stageflow_group_unknown", "agent.stageflow_tool_unknown"]);
  });

  it("allows ask_first on a granted Stageflow tool only", () => {
    expect(parseAgentDefinition({ id: "x", name: "x", instructions: "x", tools: { stageflow: { tools: ["cancel_run"] } }, approvals: { ask_first: ["stageflow.cancel_run"] } }).ok).toBe(true);
    expect(parseAgentDefinition({ id: "x", name: "x", instructions: "x", approvals: { ask_first: ["stageflow.cancel_run"] } }).ok).toBe(false);
  });
});

describe("escalation guard", () => {
  const boss = agent("boss", { builtin: ["read"], stageflow: { groups: ["agents.manage", "agents.converse"], tools: [] }, mcp: { web: ["*"] } });
  const caller = { agentId: "boss", definition: boss };

  it("lists what a candidate holds beyond the caller", () => {
    expect(grantsBeyond(boss, agent("c", { builtin: ["read", "shell"], browser: true }))).toEqual(["bash", "browser"]);
    expect(grantsBeyond(boss, agent("c", { builtin: ["read"], mcp: { web: ["fetch"] } }))).toEqual([]);
    expect(grantsBeyond(boss, agent("c", { mcp: { other: ["*"] } }))).toEqual(["other.*"]);
    expect(grantsBeyond(boss, agent("c", { stageflow: { tools: ["cancel_run"] } }))).toEqual(["stageflow.cancel_run"]);
  });

  it("refuses creating or saving an agent with tools the caller lacks", async () => {
    const refused = await checkAgentCaller(
      "save_agent",
      { mode: "create", definition: { id: "kid", name: "kid", instructions: "x", tools: { builtin: ["shell"] } } },
      caller,
      fakeService as never,
      "/x",
    );
    expect(refused?.message).toContain("bash");
    const ok = await checkAgentCaller(
      "save_agent",
      { mode: "create", definition: { id: "kid", name: "kid", instructions: "x", tools: { builtin: ["read"] } } },
      caller,
      fakeService as never,
      "/x",
    );
    expect(ok).toBeNull();
  });

  it("refuses a copy that drops an ask-first the caller is bound by", async () => {
    const asked = parseAgentDefinition({ id: "careful", name: "c", instructions: "x", tools: { builtin: ["shell"] }, approvals: { ask_first: ["bash"] } });
    if (!asked.ok) throw new Error("bad fixture");
    const who = { agentId: "careful", definition: asked.value };
    const loose = await checkAgentCaller(
      "save_agent",
      { mode: "create", definition: { id: "kid", name: "kid", instructions: "x", tools: { builtin: ["shell"] } } },
      who,
      fakeService as never,
      "/x",
    );
    expect(loose?.message).toContain("without asking first");
    const same = await checkAgentCaller(
      "save_agent",
      {
        mode: "create",
        definition: { id: "kid", name: "kid", instructions: "x", tools: { builtin: ["shell"] }, approvals: { ask_first: ["bash"] } },
      },
      who,
      fakeService as never,
      "/x",
    );
    expect(same).toBeNull();
  });

  it("refuses a real function test even when the agent service is missing", async () => {
    const refused = await checkAgentCaller(
      "test_function",
      { id: "score", real: true, source: "export default function execute() { return {}; }\n" },
      caller,
      undefined,
      "/x",
    );
    expect(refused?.message).toContain("real function test");
  });

  it("allows a draft function test without real", async () => {
    const allowed = await checkAgentCaller(
      "test_function",
      { id: "score", source: "export default function execute() { return {}; }\n" },
      caller,
      undefined,
      "/x",
    );
    expect(allowed).toBeNull();
  });

  it("refuses editing itself, restoring or enabling a stronger agent, and deciding its own approvals", async () => {
    const def = { id: "boss", name: "boss", instructions: "x" };
    expect(
      (
        await checkAgentCaller(
          "save_agent",
          { mode: "update", id: "boss", baseRevision: 1, definition: def },
          caller,
          fakeService as never,
          "/x",
        )
      )?.message,
    ).toContain("own definition");
    expect(
      (
        await checkAgentCaller(
          "save_agent",
          { mode: "update", id: "kid", baseRevision: 1, revision: 1 },
          caller,
          fakeService as never,
          "/x",
        )
      )?.message,
    ).toContain("bash");
    expect((await checkAgentCaller("set_agent_enabled", { id: "big", enabled: true }, caller, fakeService as never, "/x"))?.message).toContain(
      "bash",
    );
    expect(
      (await checkAgentCaller("decide_agent_action", { id: "kid", sessionId: "ses_1", action: "approve" }, caller, fakeService as never, "/x"))
        ?.message,
    ).toContain("own sessions");
  });

  it("denies before schema parsing when the mode resolver rejects", async () => {
    const { registerModeResolver } = await import("../src/toolkit/modes.js");
    registerModeResolver("save_agent", () => ({ ok: false, message: "bad args" }));
    try {
      const toolkit = buildToolkit(deps);
      const result = await toolkit.find((tool) => tool.name === "save_agent")!.run(
        { mode: "create", definition: { id: "kid", name: "kid", instructions: "x" } },
        { signal: new AbortController().signal, caller },
      );
      expect(result.ok).toBe(false);
      expect(result.text).toContain("bad args");
    } finally {
      registerModeResolver("save_agent", undefined);
    }
  });

  it("applies the guard through the tool, and never calls the service when refused", async () => {
    const create = vi.fn();
    const toolkit = buildToolkit({ ...deps, agentService: { ...fakeService, create } as never });
    const result = await toolkit.find((tool) => tool.name === "save_agent")!.run(
      { mode: "create", definition: { id: "kid", name: "kid", instructions: "x", tools: { builtin: ["shell"] } } },
      { signal: new AbortController().signal, caller },
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("does not hold");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("pipeline authoring tools", () => {
  it("creates, edits and reads a pipeline on disk with the Workshop's validation", async () => {
    const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "toolkit-pipe-"));
    await writeFile(path.join(dir, "stageflow.yaml"), "version: 1\ncatalog:\n  pipelines:\n    - flows\n  tasks:\n    - tasks\n");
    const toolkit = buildToolkit({ ...deps, cwd: dir, projectRoot: dir });
    const call = (name: string, args: Record<string, unknown>) => toolkit.find((t) => t.name === name)!.run({ ...args, project_root: dir }, { signal: new AbortController().signal });
    const created = await call("write_pipeline", {
      mode: "create",
      directory: "flows/hello",
      id: "hello",
      model: "openrouter/nvidia/nemotron-3.5-lightning:free",
      allow_invalid: true,
    });
    expect(created.text).toContain("pipeline.yaml");
    const stage = await call("write_stage", {
      mode: "create",
      path: "flows/hello/hello.pipeline.yaml",
      id: "greet",
      system_prompt: "Say hello",
    });
    expect(stage.text).not.toContain("error");
    const read = JSON.parse((await call("read_pipeline", { path: "flows/hello/hello.pipeline.yaml" })).text);
    expect(read.draft.pipeline.stages.map((s: { id: string }) => s.id)).toEqual(["greet"]);
    const again = await call("write_pipeline", { mode: "create", directory: "flows/hello", id: "hello" });
    expect(again.ok).toBe(false);
    expect(await readFile(path.join(dir, "flows/hello/hello.pipeline.yaml"), "utf8")).toContain("greet");
  });
});

describe("conversation-reading grants", () => {
  it("warns only when get_agent_session is granted, not get_agent alone", async () => {
    const { AgentService } = await import("../src/agents/service.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const home = await mkdtemp(path.join(os.tmpdir(), "sf-toolkit-webchat-"));
    const project = await mkdtemp(path.join(os.tmpdir(), "sf-toolkit-webchat-proj-"));
    try {
      const service = new AgentService({ stageflowHome: home });
      const base = { web_chat: { enabled: true, slug: "abcdefghijklmnop" } };
      const warn = (extra: Record<string, unknown>) =>
        service
          .validate(project, parseAgentDefinition({ id: "h", name: "h", instructions: "x", ...extra, ...base }).value!)
          .then((r) => r.warnings.filter((w) => w.code === "agent.web_chat_reads_conversations").map((w) => w.path));
      expect(await warn({ tools: { stageflow: { tools: ["get_agent"] } } })).toEqual([]);
      expect(await warn({ tools: { stageflow: { tools: ["get_agent_session"] } } })).toEqual(["tools.stageflow"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("profile grants", () => {
  it("match the Workshop and Agent-author tool lists and refuse everything else", async () => {
    const { WORKSHOP_AUTHOR_TOOL_NAMES } = await import("../src/operatorAgent/profiles/workshopAuthorTools.js");
    const { AGENT_AUTHOR_TOOL_NAMES } = await import("../src/operatorAgent/profiles/agentAuthor.js");
    const { PROFILE_GRANTS, profileMayUse } = await import("../src/toolkit/profiles.js");
    expect([...PROFILE_GRANTS["workshop-author"]!.tools].sort()).toEqual([...WORKSHOP_AUTHOR_TOOL_NAMES].sort());
    expect([...PROFILE_GRANTS["agent-author"]!.tools].sort()).toEqual([...AGENT_AUTHOR_TOOL_NAMES].sort());
    const { STAGEFLOW_GUIDE_TOOL_NAMES } = await import("../src/operatorAgent/profiles/stageflowGuide.js");
    expect([...PROFILE_GRANTS["stageflow-guide"]!.tools]).toEqual([...STAGEFLOW_GUIDE_TOOL_NAMES]);
    expect(profileMayUse("workshop-author", "save")).toBe(true);
    expect(profileMayUse("workshop-author", "bash")).toBe(false);
    expect(profileMayUse("agent-author", "save")).toBe(false);
    expect(profileMayUse("stageflow-guide", "save")).toBe(false);
    expect(profileMayUse("someone-else", "save")).toBe(false);
  });
});

describe("single builtin tools", () => {
  it("grants individual tools next to groups and round-trips through YAML", async () => {
    const { grantedBuiltinTools } = await import("../src/config/loadAgent.js");
    const definition = agent("scout", { builtin: ["write"], builtin_tools: ["grep", "ls"] });
    expect(grantedBuiltinTools(definition)).toEqual(["grep", "ls", "write", "edit"]);
    const ids = grantedToolIds(definition);
    expect(ids.has("grep")).toBe(true);
    expect(ids.has("read")).toBe(false);
    expect(ids.has("bash")).toBe(false);
    const yaml = serializeAgentDefinition(definition);
    expect(yaml).toContain("builtin_tools:");
    const again = parseAgentYaml(yaml);
    expect(again.ok && again.value.tools.builtin_tools).toEqual(["grep", "ls"]);
    expect(serializeAgentDefinition(agent("plain"))).not.toContain("builtin_tools");
  });

  it("rejects unknown and duplicate tool names", () => {
    expect(parseAgentDefinition({ id: "x", name: "x", instructions: "x", tools: { builtin_tools: ["teleport"] } }).ok).toBe(false);
    expect(parseAgentDefinition({ id: "x", name: "x", instructions: "x", tools: { builtin_tools: ["grep", "grep"] } }).ok).toBe(false);
  });

  it("counts single tools in the escalation check", () => {
    const caller = agent("c", { builtin_tools: ["grep"] });
    expect(grantsBeyond(caller, agent("k", { builtin_tools: ["grep"] }))).toEqual([]);
    expect(grantsBeyond(caller, agent("k", { builtin: ["read"] }))).toEqual(["find", "ls", "read"]);
  });
});
