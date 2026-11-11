import {
  type ExtensionAPI,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as piIsolatedMcp from "../src/agent/piIsolatedMcp.js";
import * as piIsolatedMcpProbe from "../src/agent/piIsolatedMcpProbe.js";
import {
  createSealedResourceLoader,
  createStageSessionManager,
  PiAgentAdapter,
  reconstructStageSessionForAnswer,
  resolveStageToolNames,
  STAGEFLOW_PATH_DENY_EXTENSION_NAME,
  StageSessionReconstructError,
} from "../src/agent/piAdapter.js";
import { registerProviderSupport } from "../src/agent/providerSupport.js";
import { STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME } from "../src/agent/toolOutputBudgetExtension.js";
import { WORKING_STATE_TOOL_NAME } from "../src/compaction/types.js";
import type { StageRunInput } from "../src/agent/port.js";
import { StageMcpError } from "../src/config/resolveStageMcpServers.js";
import { FunctionService } from "../src/functions/service.js";
import { FunctionStore } from "../src/functions/store.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";

const piSdkMocks = vi.hoisted(() => {
  const capturedLoaderOptions: Record<string, unknown>[] = [];
  return {
    capturedLoaderOptions,
    createAgentSession: vi.fn(),
    resetLoaderOptions() {
      capturedLoaderOptions.length = 0;
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  class CapturingResourceLoader extends actual.DefaultResourceLoader {
    constructor(options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0]) {
      piSdkMocks.capturedLoaderOptions.push(options as Record<string, unknown>);
      super(options);
    }
  }
  return {
    ...actual,
    DefaultResourceLoader: CapturingResourceLoader,
    createAgentSession: piSdkMocks.createAgentSession,
  };
});

const createMcpAdapter = vi.hoisted(() =>
  vi.fn((options?: { config?: { mcpServers?: Record<string, unknown> } }) => {
    return (pi: ExtensionAPI) => {
      for (const name of Object.keys(options?.config?.mcpServers ?? {})) {
        pi.registerTool({
          name: `${name}__list_issues`,
          label: name,
          description: `Isolated snapshot tool for ${name}`,
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
      }
    };
  }),
);

vi.mock("pi-mcp-adapter", () => ({
  createMcpAdapter,
}));

const attachIsolatedMcpImpl = piIsolatedMcp.attachIsolatedMcp;

const pendingMcpAttach: {
  attached?: Awaited<ReturnType<typeof attachIsolatedMcpImpl>>;
  snapshot?: Parameters<typeof attachIsolatedMcpImpl>[0];
  status: string;
} = { status: "connected" };

function emitPendingMcpStatus() {
  const attached = pendingMcpAttach.attached;
  if (attached?.eventBus === undefined) return;
  piIsolatedMcp.emitIsolatedMcpStatus(
    attached.eventBus,
    Object.keys(pendingMcpAttach.snapshot ?? {}).map((name) => ({
      name,
      status: pendingMcpAttach.status,
    })),
  );
}

function wrapAttachAndEmitStatus(status: string) {
  pendingMcpAttach.status = status;
  pendingMcpAttach.attached = undefined;
  pendingMcpAttach.snapshot = undefined;
  return vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
    async (snapshot, options) => {
      const attached = await attachIsolatedMcpImpl(snapshot, options);
      pendingMcpAttach.attached = attached;
      pendingMcpAttach.snapshot = snapshot;
      pendingMcpAttach.status = status;
      return attached;
    },
  );
}

async function writeSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Host skill that must stay sealed out.\n---\n# ${name}\n`,
    "utf8",
  );
}

async function writeExtension(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, name),
    "export default function () {}\n",
    "utf8",
  );
}

async function sealedLoader(options: {
  cwd: string;
  agentDir: string;
  extensionFactories?: Parameters<typeof createSealedResourceLoader>[0]["extensionFactories"];
}) {
  const loader = createSealedResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPrompt: "sealed",
    extensionFactories: options.extensionFactories,
  });
  await loader.reload();
  return loader;
}

async function plantHostResources(cwd: string, agentDir: string): Promise<void> {
  await writeSkill(path.join(agentDir, "skills"), "host-skill");
  await writeExtension(path.join(agentDir, "extensions"), "host-canary.ts");
  await writeExtension(path.join(cwd, ".pi", "extensions"), "project-canary.ts");
}

describe("createSealedResourceLoader extensionFactories", () => {
  it("loads zero extensions and zero skills when host dirs exist and no factory is passed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-empty-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-empty-agent-"));
    await plantHostResources(cwd, agentDir);

    const loader = await sealedLoader({ cwd, agentDir });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("loads only a named inline stub factory and reports no errors", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-stub-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-stub-agent-"));
    await plantHostResources(cwd, agentDir);

    const loader = await sealedLoader({
      cwd,
      agentDir,
      extensionFactories: [{ name: "stub-factory", factory: () => {} }],
    });
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map((ext) => ext.path)).toEqual([
      "<inline:stub-factory>",
    ]);
    expect(loaded.extensions[0]?.tools.size).toBe(0);
    expect(loader.getSkills().skills).toEqual([]);
  });

  it("does not load host .pi/extensions when a factory is present", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-seal-cwd-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-seal-agent-"));
    await plantHostResources(cwd, agentDir);

    const loader = await sealedLoader({
      cwd,
      agentDir,
      extensionFactories: [{ name: "stub-factory", factory: () => {} }],
    });
    const paths = loader.getExtensions().extensions.map((ext) => ext.path);
    expect(paths).toEqual(["<inline:stub-factory>"]);
    expect(paths.some((p) => p.includes("host-canary"))).toBe(false);
    expect(paths.some((p) => p.includes("project-canary"))).toBe(false);
  });
});

const MCP_TOOL_NAME = "github__list_issues";

function wiringInput(
  runWs: string,
  overrides: Partial<StageRunInput> = {},
): StageRunInput {
  const base: StageRunInput = {
    roots: buildStageRoots(runWs, "clarify"),
    stage: {
      id: "clarify",
      system_prompt: "x",
      model: "anthropic/claude-sonnet-4-5",
    },
    task: { id: "t", goal: "g" },
    priorEnvelope: null,
  };
  return {
    ...base,
    ...overrides,
    stage: { ...base.stage, ...overrides.stage },
    roots: overrides.roots ?? base.roots,
  };
}

describe("prepareStageSessionWiring MCP snapshot", () => {
  const expectedSealedTools = [
    ...resolveStageToolNames("emit_stage_envelope", "write_stage_artifact"),
    WORKING_STATE_TOOL_NAME,
  ];
  const mcpInlinePath = `<inline:${piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME}>`;
  let attachSpy: ReturnType<typeof wrapAttachAndEmitStatus>;

  beforeEach(() => {
    createMcpAdapter.mockClear();
    piSdkMocks.resetLoaderOptions();
    piSdkMocks.createAgentSession.mockReset();
    piSdkMocks.createAgentSession.mockImplementation(async () => ({
      session: {
        bindExtensions: async () => {
          emitPendingMcpStatus();
        },
        setModel: async () => {},
        setThinkingLevel: () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        agent: { state: { messages: [] }, continue: async () => {} },
      },
    }));
    attachSpy = wrapAttachAndEmitStatus("connected");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastLoaderOptions(): Record<string, unknown> {
    const options = piSdkMocks.capturedLoaderOptions.at(-1);
    if (options === undefined) {
      throw new Error("DefaultResourceLoader was not constructed");
    }
    return options;
  }

  function lastSessionTools(): string[] {
    const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
      | { tools?: string[] }
      | undefined;
    return options?.tools ?? [];
  }

  function lastLoaderExtensionPaths(): string[] {
    const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
      | { resourceLoader?: { getExtensions: () => { extensions: Array<{ path: string }> } } }
      | undefined;
    return options?.resourceLoader?.getExtensions().extensions.map((ext) => ext.path) ?? [];
  }

  async function lastAttached() {
    return attachSpy.mock.results.at(-1)?.value;
  }

  it("omitted resolvedMcpServers skips MCP factory and keeps sealed tools", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-omit-"));
    await new PiAgentAdapter().runStage(wiringInput(runWs));

    expect(await lastAttached()).toEqual({
      extensionFactories: undefined,
      eventBus: undefined,
      connecting: undefined,
    });
    expect(createMcpAdapter).not.toHaveBeenCalled();
    expect(lastLoaderOptions().extensionFactories).toEqual([
      expect.objectContaining({
        name: STAGEFLOW_PATH_DENY_EXTENSION_NAME,
        factory: expect.any(Function),
      }),
      expect.objectContaining({
        name: STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME,
        factory: expect.any(Function),
      }),
      expect.objectContaining({ name: "stageflow-openrouter-routing", factory: expect.any(Function) }),
      expect.objectContaining({ name: "stageflow-compaction", factory: expect.any(Function) }),
      expect.objectContaining({ name: "stageflow-working-state", factory: expect.any(Function) }),
    ]);
    expect(lastLoaderOptions()).not.toHaveProperty("eventBus");
    expect(lastSessionTools()).toEqual(expectedSealedTools);
    expect(lastLoaderExtensionPaths()).not.toContain(mcpInlinePath);
    const customNames = (
      piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | { customTools?: Array<{ name: string }> }
        | undefined
    )?.customTools?.map((tool) => tool.name);
    expect(customNames).not.toContain("read");
    expect(customNames).not.toContain("bash");
  });

  it("overwrites read, write, edit, and bash with /workspace tools when a sandbox container is set", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-sandbox-tools-"));
    const roots = {
      ...buildStageRoots(runWs, "clarify"),
      containerName: "stageflow-run-clarify-1-abc",
      containerDockerBin: "/fake/docker",
    };
    await new PiAgentAdapter().runStage(wiringInput(runWs, { roots }));

    expect(lastSessionTools()).toEqual(expectedSealedTools);
    expect(lastLoaderOptions().extensionFactories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: STAGEFLOW_PATH_DENY_EXTENSION_NAME }),
      ]),
    );
    const customTools = (
      piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | { customTools?: Array<{ name: string; description: string }> }
        | undefined
    )?.customTools;
    const byName = new Map((customTools ?? []).map((tool) => [tool.name, tool]));
    for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      expect(byName.get(name)?.description).toContain("/workspace");
    }
    const toolNames = lastSessionTools();
    for (const name of ["grep", "find", "ls"]) {
      expect(toolNames.filter((entry) => entry === name)).toHaveLength(1);
    }
    expect(byName.has("write_stage_artifact")).toBe(true);
    expect(byName.has("emit_stage_envelope")).toBe(true);
  });

  it("offers grep, find, and ls on the stage working tree when there is no sandbox", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-search-host-"));
    const roots = buildStageRoots(runWs, "clarify");
    await new PiAgentAdapter().runStage(wiringInput(runWs, { roots }));
    const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
      | { cwd?: string; tools?: string[]; customTools?: Array<{ name: string; description?: string }> }
      | undefined;
    expect(options?.cwd).toBe(roots.cwd);
    expect(options?.tools).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
    const custom = options?.customTools ?? [];
    const byName = new Map(custom.map((tool) => [tool.name, tool]));
    for (const name of ["grep", "find", "ls"]) {
      expect(byName.get(name)?.description).toContain("working tree");
    }
    expect(custom.filter((tool) => tool.name === "read")).toHaveLength(0);
    expect(custom.filter((tool) => tool.name === "bash")).toHaveLength(0);
  });

  it("returns the first search result of a turn and can defer a later one", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-search-cap-"));
    await new PiAgentAdapter().runStage(wiringInput(runWs));
    const factories = lastLoaderOptions().extensionFactories as Array<{
      name: string;
      factory: (pi: ExtensionAPI) => void;
    }>;
    const toolOutput = factories.find((entry) => entry.name === STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME);
    if (!toolOutput) throw new Error("tool output extension missing");
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
    toolOutput.factory({
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as unknown as ExtensionAPI);
    const ctx = { getContextUsage: () => ({ tokens: 120_000, contextWindow: 128_000 }) };
    const shard = [{ type: "text", text: "x".repeat(60_000) }];
    const call = async (toolName: string, toolCallId: string) => {
      const [handler] = handlers.get("tool_result") ?? [];
      if (!handler) throw new Error("tool_result handler missing");
      return handler(
        {
          type: "tool_result",
          toolCallId,
          toolName,
          input: {},
          isError: false,
          content: shard,
          details: {},
        },
        ctx,
      );
    };
    expect(await call("find", "f1")).toBeUndefined();
    const deferred = (await call("ls", "l1")) as { content: Array<{ text?: string }> };
    expect(deferred.content[0]?.text).toContain("ls output not returned");
    const [end] = handlers.get("message_end") ?? [];
    if (!end) throw new Error("message_end handler missing");
    await end({ type: "message_end", message: { role: "assistant" } }, ctx);
    expect(await call("grep", "g1")).toBeUndefined();
  });

  it("empty resolvedMcpServers matches omitted", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-empty-snap-"));
    await new PiAgentAdapter().runStage(
      wiringInput(runWs, { resolvedMcpServers: {} }),
    );

    expect(await lastAttached()).toEqual({
      extensionFactories: undefined,
      eventBus: undefined,
      connecting: undefined,
    });
    expect(createMcpAdapter).not.toHaveBeenCalled();
    expect(lastLoaderOptions().extensionFactories).toEqual([
      expect.objectContaining({
        name: STAGEFLOW_PATH_DENY_EXTENSION_NAME,
        factory: expect.any(Function),
      }),
      expect.objectContaining({
        name: STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME,
        factory: expect.any(Function),
      }),
      expect.objectContaining({ name: "stageflow-openrouter-routing", factory: expect.any(Function) }),
      expect.objectContaining({ name: "stageflow-compaction", factory: expect.any(Function) }),
      expect.objectContaining({ name: "stageflow-working-state", factory: expect.any(Function) }),
    ]);
    expect(lastLoaderOptions()).not.toHaveProperty("eventBus");
    expect(lastSessionTools()).toEqual(expectedSealedTools);
  });

  it("non-empty snapshot passes a factory into the sealed loader", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-factory-"));
    const snapshot = { github: { url: "https://mcp.example.invalid/mcp" } };

    await new PiAgentAdapter().runStage(
      wiringInput(runWs, { resolvedMcpServers: snapshot }),
    );

    const attached = await lastAttached();
    expect(attached?.extensionFactories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME,
          factory: expect.any(Function),
        }),
      ]),
    );
    expect(attached?.eventBus).toEqual(
      expect.objectContaining({ on: expect.any(Function), emit: expect.any(Function) }),
    );
    expect(attached?.connecting).toBeInstanceOf(Promise);
    expect(lastLoaderOptions().extensionFactories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME,
          factory: expect.any(Function),
        }),
      ]),
    );
    expect(lastLoaderOptions().eventBus).toEqual(
      expect.objectContaining({ on: expect.any(Function), emit: expect.any(Function) }),
    );
    expect(lastLoaderExtensionPaths()).toContain(mcpInlinePath);
  });

  function adapterRegistering(sequence: string[][]) {
    let call = 0;
    return () => (pi: ExtensionAPI) => {
      const names = sequence[Math.min(call, sequence.length - 1)] ?? [];
      call += 1;
      for (const name of names) {
        pi.registerTool({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
      }
    };
  }

  it("attaches stage MCP with the eager lifecycle", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-eager-"));
    await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );
    expect(attachSpy).toHaveBeenCalledWith(expect.any(Object), { lifecycle: "eager" });
  });

  it("fails the stage when the adapter registers mcpScript", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-script-"));
    createMcpAdapter.mockImplementationOnce(
      adapterRegistering([[MCP_TOOL_NAME, "mcpScript"]]),
    );

    const result = await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "MCP adapter registered unrequested tool(s): mcpScript",
    });
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("warms MCP metadata and reloads when only the gateway is registered", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-warm-"));
    const snapshot = { github: { url: "https://mcp.example.invalid/mcp" } };
    createMcpAdapter.mockImplementationOnce(
      adapterRegistering([["mcp"], [MCP_TOOL_NAME]]),
    );
    const warmSpy = vi
      .spyOn(piIsolatedMcpProbe, "warmIsolatedMcpMetadata")
      .mockResolvedValue(undefined);

    await new PiAgentAdapter().runStage(
      wiringInput(runWs, { resolvedMcpServers: snapshot }),
    );

    expect(warmSpy).toHaveBeenCalledTimes(1);
    expect(warmSpy).toHaveBeenCalledWith(snapshot, { cwd: expect.any(String) });
    expect(lastSessionTools()).toEqual([...expectedSealedTools, MCP_TOOL_NAME]);
  });

  it("fails the stage when MCP metadata is still missing after warming", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-cold-"));
    createMcpAdapter.mockImplementationOnce(adapterRegistering([["mcp"]]));
    vi.spyOn(piIsolatedMcpProbe, "warmIsolatedMcpMetadata").mockResolvedValue(
      undefined,
    );

    const result = await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "MCP tool metadata unavailable for: github",
    });
  });

  it("fails the stage when warming MCP metadata cannot connect", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-warmfail-"));
    createMcpAdapter.mockImplementationOnce(adapterRegistering([["mcp"]]));
    vi.spyOn(piIsolatedMcpProbe, "warmIsolatedMcpMetadata").mockRejectedValue(
      new StageMcpError('MCP server "github" failed to connect (status: failed)', "connect_failed"),
    );

    const result = await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'MCP server "github" failed to connect (status: failed)',
    });
  });

  it("connect-fail returns ok false after bindExtensions", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-fail-"));
    attachSpy = wrapAttachAndEmitStatus("failed");
    const restore = vi.fn();
    registerProviderSupport({
      id: "u3-mcp-restore",
      matches: (ref) => ref === "u3-restore/model",
      prepare: () => ({ extensionPaths: [], restore }),
    });

    const result = await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        stage: { id: "clarify", system_prompt: "x", model: "u3-restore/model" },
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'MCP server "github" failed to connect (status: failed)',
    });
    expect(piSdkMocks.createAgentSession).toHaveBeenCalled();
    expect(restore).toHaveBeenCalled();
  });

  it("successful connect unions MCP tool names and keeps Stageflow tools", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-tools-"));

    await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    const tools = lastSessionTools();
    expect(tools).toContain(MCP_TOOL_NAME);
    expect(tools).toContain("emit_stage_envelope");
    expect(tools).toContain("write_stage_artifact");
    expect(tools).toEqual([...expectedSealedTools, MCP_TOOL_NAME]);
    expect(lastLoaderOptions().extensionFactories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME }),
      ]),
    );
  });

  it("keeps Cursor additionalExtensionPaths when a snapshot is also present", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-cursor-"));
    const cursorExt = path.join(runWs, "cursor-stub.ts");
    await writeFile(cursorExt, "export default function () {}\n", "utf8");
    registerProviderSupport({
      id: "u3-cursor-stub",
      matches: (ref) => ref.startsWith("u3-cursor/"),
      prepare: () => ({ extensionPaths: [cursorExt] }),
    });

    await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        stage: { id: "clarify", system_prompt: "x", model: "u3-cursor/composer" },
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(lastLoaderOptions().additionalExtensionPaths).toEqual([cursorExt]);
    expect(lastLoaderOptions().extensionFactories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME,
        }),
      ]),
    );
    const loadedPaths = lastLoaderExtensionPaths();
    expect(loadedPaths).toContain(cursorExt);
    expect(loadedPaths).toContain(mcpInlinePath);
  });

  it("awaits isolated MCP connecting after bindExtensions, not at attach", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-wait-bind-"));
    let bindStarted = false;
    let connectingAwaitedBeforeBind = false;
    const connecting = {
      then(
        onFulfilled?: (value: void) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        if (!bindStarted) connectingAwaitedBeforeBind = true;
        return Promise.resolve().then(onFulfilled, onRejected);
      },
    };

    attachSpy.mockResolvedValue({
      extensionFactories: [
        { name: piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME, factory: () => {} },
      ],
      eventBus: { on() {}, emit() {}, off() {} },
      connecting: connecting as Promise<void>,
    });
    piSdkMocks.createAgentSession.mockImplementation(async () => ({
      session: {
        bindExtensions: async () => {
          bindStarted = true;
        },
        setModel: async () => {},
        setThinkingLevel: () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        agent: { state: { messages: [] }, continue: async () => {} },
      },
    }));

    await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(bindStarted).toBe(true);
    expect(connectingAwaitedBeforeBind).toBe(false);
  });

  it("reconstruct awaits connecting after bindExtensions and fail-closes connect", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-recon-"));
    const roots = buildStageRoots(runWs, "clarify");
    const sm = await createStageSessionManager(roots, "clarify");
    sm.appendMessage({
      role: "user",
      content: "start",
      timestamp: Date.now(),
    });
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_wait_mcp_1",
          name: "ask_operator",
          arguments: { prompt: "need approval" },
        },
      ],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });

    let bindStarted = false;
    const connectError = new StageMcpError(
      'MCP server "github" failed to connect (status: failed)',
      "connect_failed",
    );
    const connecting = {
      then(
        onFulfilled?: (value: void) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        if (!bindStarted) {
          return Promise.resolve().then(onFulfilled, onRejected);
        }
        return Promise.reject(connectError).then(onFulfilled, onRejected);
      },
    };

    attachSpy.mockResolvedValue({
      extensionFactories: [
        { name: piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME, factory: () => {} },
      ],
      eventBus: { on() {}, emit() {}, off() {} },
      connecting: connecting as Promise<void>,
    });
    piSdkMocks.createAgentSession.mockImplementation(async () => ({
      session: {
        bindExtensions: async () => {
          bindStarted = true;
        },
        setModel: async () => {},
        setThinkingLevel: () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        agent: { state: { messages: [] }, continue: async () => {} },
      },
    }));

    await expect(
      reconstructStageSessionForAnswer(
        wiringInput(runWs, {
          roots,
          resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
        }),
        { text: "approved" },
      ),
    ).rejects.toSatisfy(
      (err) =>
        err instanceof StageSessionReconstructError &&
        err.message.includes("failed to connect"),
    );
    expect(piSdkMocks.createAgentSession).toHaveBeenCalled();
    expect(bindStarted).toBe(true);
  });

  it("cancels connecting when skill validation fails after attach", async () => {
    attachSpy.mockRestore();
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-cancel-"));
    const skillDir = path.join(runWs, "other-skill");
    await mkdir(skillDir, { recursive: true });
    const skillFilePath = path.join(skillDir, "SKILL.md");
    await writeFile(
      skillFilePath,
      "---\nname: other-skill\ndescription: Not the named skill.\n---\n# Other\n",
      "utf8",
    );
    const attachReal = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp");

    const result = await new PiAgentAdapter().runStage(
      wiringInput(runWs, {
        stage: {
          id: "clarify",
          system_prompt: "x",
          model: "anthropic/claude-sonnet-4-5",
          skill: "wanted-skill",
        },
        skillFilePath,
        resolvedMcpServers: { github: { url: "https://mcp.example.invalid/mcp" } },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'Skill "wanted-skill" is not installed',
    });
    const attached = await attachReal.mock.results.at(-1)?.value;
    expect(attached?.connecting).toBeInstanceOf(Promise);
    const settled = await Promise.race([
      attached.connecting.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("pending"), 80);
      }),
    ]);
    expect(settled).toBe("settled");
  });

  it("tells an open stage to change approach, keeps the stop line otherwise, and adds no tool", async () => {
    const authorPrompt = "Fail closed if the source file is missing.";
    const missingFileStop =
      "If a file you were given is not in that folder, stop and say so. Do not create stand-in documents.";
    const changeApproach =
      "A rejected emit, a failed command, or a missing file ends that approach. Try another approach with the tools and inputs already given. Emit failure only when the stage can name a blocker none of those can get past. Do not create a stand-in for an input that could not be read.";
    const bashStop = "If a file is missing, stop. Do not create a stand-in.";
    const bashGuidelineStop = "If a file is not there, stop. Do not create stand-in documents.";
    const marker = "PROJECT-INSTRUCTION-MUST-NOT-LOAD";
    const notAddedByLevel = [
      "ask_operator",
      "send_message",
      "read_memory",
      "replace_memory",
      "add_memory_card",
      "update_memory_card",
      "read_memory_card",
      "search_memory_cards",
      "send_email",
      "reply_email",
    ];

    function sessionToolNames(): string[] {
      const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | { tools?: string[]; customTools?: Array<{ name: string }> }
        | undefined;
      return [...(options?.tools ?? []), ...(options?.customTools ?? []).map((tool) => tool.name)].sort();
    }

    function bashTool(): { description: string; promptGuidelines?: string[] } {
      const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | { customTools?: Array<{ name: string; description: string; promptGuidelines?: string[] }> }
        | undefined;
      const bash = options?.customTools?.find((tool) => tool.name === "bash");
      if (bash === undefined) throw new Error("bash tool was not registered");
      return bash;
    }

    function loader(): {
      getAgentsFiles(): { agentsFiles: Array<{ content: string }> };
      getSkills(): { skills: Array<{ name: string }> };
      getAppendSystemPrompt(): string[];
      getSystemPrompt(): string | undefined;
      getExtensions(): { extensions: Array<{ path: string }> };
    } {
      const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | { resourceLoader?: ReturnType<typeof loader> }
        | undefined;
      if (options?.resourceLoader === undefined) throw new Error("resource loader missing");
      return options.resourceLoader;
    }

    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-open-"));
    const roots = {
      ...buildStageRoots(runWs, "clarify"),
      containerName: "stageflow-run-clarify-1-abc",
      readonlyDir: "/sandbox/inputs",
    };
    await writeFile(path.join(roots.cwd, "AGENTS.md"), marker);
    await writeFile(path.join(roots.cwd, "CLAUDE.md"), marker);
    await mkdir(path.join(roots.cwd, ".pi"), { recursive: true });
    await writeFile(path.join(roots.cwd, ".pi", "APPEND_SYSTEM.md"), marker);
    await writeFile(path.join(roots.cwd, ".pi", "SYSTEM.md"), marker);
    await writeSkill(path.join(roots.agentDir, "skills"), "host-skill");
    await writeExtension(path.join(roots.cwd, ".pi", "extensions"), "project-canary.ts");

    const stage = (independence?: "strict" | "persistent" | "open") =>
      wiringInput(runWs, {
        roots,
        sessionMode: "new_session",
        stage: {
          id: "clarify",
          system_prompt: authorPrompt,
          model: "anthropic/claude-sonnet-4-5",
          ...(independence !== undefined ? { independence } : {}),
        },
      });

    await new PiAgentAdapter().runStage(stage("persistent"));
    const persistentNames = sessionToolNames();
    for (const name of ["grep", "find", "ls"]) {
      expect(persistentNames).toContain(name);
    }
    const persistentPrompt = loader().getSystemPrompt() ?? "";
    expect(persistentPrompt.startsWith(authorPrompt)).toBe(true);
    expect(persistentPrompt).toContain(missingFileStop);
    expect(persistentPrompt).not.toContain("ends that approach");
    expect(bashTool().description).toContain(bashStop);
    expect(bashTool().promptGuidelines?.join("\n")).toContain(bashGuidelineStop);

    await new PiAgentAdapter().runStage(stage("strict"));
    expect(sessionToolNames()).toEqual(persistentNames);
    const strictPrompt = loader().getSystemPrompt() ?? "";
    expect(strictPrompt.startsWith(authorPrompt)).toBe(true);
    expect(strictPrompt).toContain(missingFileStop);
    expect(strictPrompt).not.toContain("ends that approach");
    expect(bashTool().description).toContain(bashStop);
    expect(bashTool().description).not.toContain("ends that approach");
    expect(bashTool().promptGuidelines?.join("\n")).toContain(bashGuidelineStop);

    await new PiAgentAdapter().runStage(stage("open"));
    expect(sessionToolNames()).toEqual(persistentNames);
    for (const name of notAddedByLevel) {
      expect(persistentNames).not.toContain(name);
    }
    const openPrompt = loader().getSystemPrompt() ?? "";
    expect(openPrompt.startsWith(authorPrompt)).toBe(true);
    expect(openPrompt).toContain(changeApproach);
    expect(openPrompt).not.toContain(missingFileStop);
    expect(openPrompt).not.toContain(marker);
    expect(bashTool().description).toContain(changeApproach);
    expect(bashTool().description).not.toContain(bashStop);
    expect(bashTool().promptGuidelines?.join("\n")).toContain(changeApproach);
    expect(bashTool().promptGuidelines?.join("\n")).not.toContain(bashGuidelineStop);
    expect(loader().getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader().getSkills().skills).toEqual([]);
    expect(loader().getAppendSystemPrompt()).toEqual([]);
    expect(loader().getAppendSystemPrompt().join("\n")).not.toContain(marker);
    expect(loader().getExtensions().extensions.map((ext) => ext.path).join("\n")).not.toContain(
      "project-canary",
    );
  });

  it("registers a function tool by its schema and keeps it outside the output budget exemption", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-fn-tool-"));
    const home = await mkdtemp(path.join(tmpdir(), "sf-pi-fn-home-"));
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    try {
      const functions = new FunctionService({ store: new FunctionStore(connection) });
      await functions.create(
        runWs,
        {
          id: "invoice_tool",
          name: "Invoice",
          kind: "tool",
          source: "export default function execute(context) { return { id: context.input.invoice.id, amount: context.input.invoice.amount, envelope: context.envelope }; }\n",
          tool_name: "total_invoice",
          tool_description: "Total an invoice object the agent supplies.",
          input_schema: {
            type: "object",
            properties: {
              invoice: {
                type: "object",
                properties: { id: { type: "string" }, amount: { type: "integer" } },
                required: ["id", "amount"],
              },
            },
            required: ["invoice"],
          },
          capabilities: [],
          bindings: [],
        },
        { source: "api", author: "test" },
      );
      await new PiAgentAdapter().runStage(
        wiringInput(runWs, { stage: { id: "clarify", system_prompt: "x", model: "anthropic/claude-sonnet-4-5", tools: { functions: [{ id: "invoice_tool", grants: [] }] } } }),
      );
      const custom = (
        piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
          | { customTools?: Array<{ name: string; execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> }> }
          | undefined
      )?.customTools?.find((tool) => tool.name === "total_invoice");
      expect(custom).toBeDefined();
      expect(lastSessionTools()).toContain("total_invoice");
      const result = await custom!.execute("call-1", { invoice: { id: "inv-9", amount: 42 } });
      expect(result.content[0]?.text).toBe(JSON.stringify({ id: "inv-9", amount: 42, envelope: null }));

      const factories = lastLoaderOptions().extensionFactories as Array<{ name: string; factory: (pi: { on: (event: string, handler: Function) => void }) => void }>;
      const budget = factories.find((entry) => entry.name === STAGEFLOW_TOOL_OUTPUT_EXTENSION_NAME);
      const handlers = new Map<string, Function>();
      budget?.factory({ on: (event, handler) => void handlers.set(event, handler) });
      const huge = "x".repeat(200_000);
      const ctx = { getContextUsage: () => ({ tokens: 1_000, contextWindow: 8_000 }) };
      const spilled = await handlers.get("tool_result")?.({
        toolName: "total_invoice",
        toolCallId: "c1",
        content: [{ type: "text", text: huge }],
        details: {},
      }, ctx);
      const kept = await handlers.get("tool_result")?.({
        toolName: WORKING_STATE_TOOL_NAME,
        toolCallId: "c2",
        content: [{ type: "text", text: huge }],
        details: {},
      }, ctx);
      expect(spilled).toBeDefined();
      expect(kept).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("fails a cursor stage before the model session opens", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-fn-cursor-"));
    const home = await mkdtemp(path.join(tmpdir(), "sf-pi-fn-cursor-home-"));
    const { connection } = createRunStoreWithConnection({ rootDir: home, openerMode: "migrate" });
    try {
      const functions = new FunctionService({ store: new FunctionStore(connection) });
      await functions.create(
        runWs,
        {
          id: "invoice_tool",
          name: "Invoice",
          kind: "tool",
          source: "export default function execute() { return { ok: true }; }\n",
          tool_name: "total_invoice",
          tool_description: "Total an invoice.",
          input_schema: { type: "object", properties: {} },
          capabilities: [],
          bindings: [],
        },
        { source: "api", author: "test" },
      );
      piSdkMocks.createAgentSession.mockClear();
      const result = await new PiAgentAdapter().runStage(
        wiringInput(runWs, { stage: { id: "clarify", system_prompt: "x", model: "cursor/auto", tools: { functions: [{ id: "invoice_tool", grants: [] }] } } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("pi__total_invoice");
      expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
    } finally {
      connection.close();
    }
  });
});

describe("checkout context AGENTS.md", () => {
  const authorPrompt = "Fail closed if the source file is missing.";
  const wins = "The stage assignment wins where it conflicts with the file.";
  const checkoutMarker = "CHECKOUT-AGENTS-RULE";
  const parentMarker = "PARENT-AGENTS-RULE";
  const claudeMarker = "CLAUDE-MD-MUST-STAY-OUT";
  const piMarker = "PI-APPEND-MUST-STAY-OUT";
  const runMarker = "RUN-WS-AGENTS-MUST-STAY-OUT";

  beforeEach(() => {
    piSdkMocks.resetLoaderOptions();
    piSdkMocks.createAgentSession.mockReset();
    piSdkMocks.createAgentSession.mockImplementation(async () => ({
      session: {
        bindExtensions: async () => {
          emitPendingMcpStatus();
        },
        setModel: async () => {},
        setThinkingLevel: () => {},
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        agent: { state: { messages: [] }, continue: async () => {} },
      },
    }));
    wrapAttachAndEmitStatus("connected");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function systemPrompt(): string {
    const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
      | { resourceLoader?: { getSystemPrompt(): string | undefined; getAgentsFiles(): { agentsFiles: unknown[] }; getSkills(): { skills: unknown[] }; getAppendSystemPrompt(): string[] } }
      | undefined;
    return options?.resourceLoader?.getSystemPrompt() ?? "";
  }

  function loaderFlags(): Record<string, unknown> {
    const options = piSdkMocks.capturedLoaderOptions.at(-1);
    if (options === undefined) throw new Error("DefaultResourceLoader was not constructed");
    return options;
  }

  async function plant(checkoutAgents: string | undefined) {
    const parent = await mkdtemp(path.join(tmpdir(), "sf-pi-checkout-ctx-"));
    const checkout = path.join(parent, "checkout");
    const runWs = path.join(parent, "run");
    await mkdir(checkout, { recursive: true });
    await mkdir(runWs, { recursive: true });
    await writeFile(path.join(parent, "AGENTS.md"), parentMarker);
    await writeFile(path.join(runWs, "AGENTS.md"), runMarker);
    await writeFile(path.join(checkout, "CLAUDE.md"), claudeMarker);
    await mkdir(path.join(checkout, ".pi"), { recursive: true });
    await writeFile(path.join(checkout, ".pi", "APPEND_SYSTEM.md"), piMarker);
    await writeExtension(path.join(checkout, ".pi", "extensions"), "project-canary.ts");
    await writeSkill(path.join(checkout, ".pi", "skills"), "project-skill");
    if (checkoutAgents !== undefined) {
      await writeFile(path.join(checkout, "AGENTS.md"), checkoutAgents);
    }
    return { parent, checkout, runWs };
  }

  function inputFor(
    runWs: string,
    checkout: string | undefined,
    independence: "strict" | "persistent" | "open" | undefined,
    checkoutContext: boolean,
  ) {
    const stage = {
      id: "clarify",
      system_prompt: authorPrompt,
      model: "anthropic/claude-sonnet-4-5",
      ...(independence !== undefined ? { independence } : {}),
      ...(checkoutContext ? { checkout_context: true as const } : {}),
    };
    return wiringInput(runWs, {
      roots: checkout !== undefined ? buildStageRoots(runWs, "clarify", checkout) : buildStageRoots(runWs, "clarify"),
      sessionMode: "new_session",
      stage,
    });
  }

  it("includes the checkout file for every independence level and leaves the author prompt intact", async () => {
    const { checkout, runWs } = await plant(`${checkoutMarker}\nUse the repo style.`);
    for (const independence of ["strict", "persistent", "open", undefined] as const) {
      const stageInput = inputFor(runWs, checkout, independence, true);
      await new PiAgentAdapter().runStage(stageInput);
      const prompt = systemPrompt();
      expect(prompt.startsWith(authorPrompt)).toBe(true);
      expect(stageInput.stage.system_prompt).toBe(authorPrompt);
      expect(prompt).toContain(checkoutMarker);
      expect(prompt).toContain(wins);
      expect(prompt).not.toContain(parentMarker);
      expect(prompt).not.toContain(claudeMarker);
      expect(prompt).not.toContain(piMarker);
      expect(prompt).not.toContain(runMarker);
      expect(loaderFlags()).toMatchObject({
        noContextFiles: true,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
      });
      const session = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as {
        resourceLoader: {
          getAgentsFiles(): { agentsFiles: unknown[] };
          getSkills(): { skills: unknown[] };
          getAppendSystemPrompt(): string[];
          getExtensions(): { extensions: Array<{ path: string }> };
        };
      };
      expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(session.resourceLoader.getSkills().skills).toEqual([]);
      expect(session.resourceLoader.getAppendSystemPrompt().join("\n")).not.toContain(piMarker);
      expect(session.resourceLoader.getExtensions().extensions.map((ext) => ext.path).join("\n")).not.toContain(
        "project-canary",
      );
    }
  });

  it("loads nothing when the flag is off, at every independence level", async () => {
    const { checkout, runWs } = await plant(checkoutMarker);
    for (const independence of ["strict", "persistent", "open", undefined] as const) {
      await new PiAgentAdapter().runStage(inputFor(runWs, checkout, independence, false));
      const prompt = systemPrompt();
      expect(prompt.startsWith(authorPrompt)).toBe(true);
      expect(prompt).not.toContain(checkoutMarker);
      expect(prompt).not.toContain(wins);
      expect(prompt).not.toContain(parentMarker);
    }
  });

  it("starts with no extra context when the checkout has no AGENTS.md", async () => {
    const { checkout, runWs } = await plant(undefined);
    const result = await new PiAgentAdapter().runStage(inputFor(runWs, checkout, "persistent", true));
    const prompt = systemPrompt();
    expect(prompt.startsWith(authorPrompt)).toBe(true);
    expect(prompt).not.toContain(wins);
    expect(prompt).not.toContain(parentMarker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing emit_stage_envelope");
  });

  it("does not read AGENTS.md from the run workspace when the stage has no checkout", async () => {
    const { runWs } = await plant(checkoutMarker);
    await new PiAgentAdapter().runStage(inputFor(runWs, undefined, "open", true));
    const prompt = systemPrompt();
    expect(prompt).not.toContain(checkoutMarker);
    expect(prompt).not.toContain(runMarker);
    expect(prompt).not.toContain(parentMarker);
    expect(prompt).not.toContain(wins);
  });
});
