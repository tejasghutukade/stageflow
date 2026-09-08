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
import {
  createSealedResourceLoader,
  PiAgentAdapter,
  resolveStageToolNames,
} from "../src/agent/piAdapter.js";
import { registerProviderSupport } from "../src/agent/providerSupport.js";
import type { StageRunInput } from "../src/agent/port.js";
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

function wrapAttachAndEmitStatus(status: string) {
  return vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
    async (snapshot, options) => {
      const attached = await attachIsolatedMcpImpl(snapshot, options);
      if (attached.eventBus !== undefined) {
        piIsolatedMcp.emitIsolatedMcpStatus(
          attached.eventBus,
          Object.keys(snapshot ?? {}).map((name) => ({ name, status })),
        );
      }
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
  const expectedSealedTools = resolveStageToolNames(
    "emit_stage_envelope",
    "write_stage_artifact",
  );
  const mcpInlinePath = `<inline:${piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME}>`;
  let attachSpy: ReturnType<typeof wrapAttachAndEmitStatus>;

  beforeEach(() => {
    createMcpAdapter.mockClear();
    piSdkMocks.resetLoaderOptions();
    piSdkMocks.createAgentSession.mockReset();
    piSdkMocks.createAgentSession.mockImplementation(async () => ({
      session: {
        bindExtensions: async () => {},
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

  it("omitted resolvedMcpServers does not pass extensionFactories and keeps sealed tools", async () => {
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-omit-"));
    await new PiAgentAdapter().runStage(wiringInput(runWs));

    expect(await lastAttached()).toEqual({
      extensionFactories: undefined,
      eventBus: undefined,
      connecting: undefined,
    });
    expect(createMcpAdapter).not.toHaveBeenCalled();
    expect(lastLoaderOptions()).not.toHaveProperty("extensionFactories");
    expect(lastLoaderOptions()).not.toHaveProperty("eventBus");
    expect(lastSessionTools()).toEqual(expectedSealedTools);
    expect(lastLoaderExtensionPaths()).not.toContain(mcpInlinePath);
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
    expect(lastLoaderOptions()).not.toHaveProperty("extensionFactories");
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

  it("connect-fail returns ok false and never creates a session", async () => {
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
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
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
});
