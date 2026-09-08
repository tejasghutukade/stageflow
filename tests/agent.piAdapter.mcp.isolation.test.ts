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
} from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import {
  buildStageRoots,
  PI_CODING_AGENT_DIR_ENV,
} from "../src/runtime/stageRoots.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

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
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  class CapturingResourceLoader extends actual.DefaultResourceLoader {
    constructor(
      options: ConstructorParameters<typeof actual.DefaultResourceLoader>[0],
    ) {
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
  vi.fn(
    (options?: {
      config?: { mcpServers?: Record<string, unknown> };
      configPath?: string;
    }) => {
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
    },
  ),
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

const GITHUB_SNAPSHOT = {
  github: { url: "https://mcp.example.invalid/github" },
} as const;

const EXPECTED_ISOLATED_GITHUB_ADAPTER_OPTIONS = {
  config: {
    mcpServers: {
      github: {
        url: "https://mcp.example.invalid/github",
        lifecycle: "lazy",
        directTools: true,
      },
    },
    settings: {
      directTools: true,
      elicitation: false,
      hostConfigDiscovery: "off",
    },
  },
} as const;

const CANARY_SERVER_NAMES = [
  "canary-home",
  "canary-xdg",
  "canary-agents",
  "canary-project",
  "canary-pi-project",
  "canary-cursor",
  "canary-agent-dir",
  "notion",
] as const;

function canaryMcpPaths(
  home: string,
  cwd: string,
  agentDir: string,
): Record<(typeof CANARY_SERVER_NAMES)[number], string> {
  return {
    "canary-home": path.join(home, ".pi", "agent", "mcp.json"),
    "canary-xdg": path.join(home, ".config", "mcp", "mcp.json"),
    "canary-agents": path.join(home, ".agents", "mcp.json"),
    "canary-project": path.join(cwd, ".mcp.json"),
    "canary-pi-project": path.join(cwd, ".pi", "mcp.json"),
    "canary-cursor": path.join(cwd, ".cursor", "mcp.json"),
    "canary-agent-dir": path.join(agentDir, "mcp.json"),
    notion: path.join(home, ".pi", "agent", "mcp.json"),
  };
}

async function writeMcpJson(
  filePath: string,
  servers: Record<string, { command: string; args: string[] }>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    "utf8",
  );
}

async function plantAmbientMcpFiles(
  home: string,
  cwd: string,
  agentDir: string,
): Promise<void> {
  const files = canaryMcpPaths(home, cwd, agentDir);
  await writeMcpJson(files["canary-home"], {
    "canary-home": { command: "echo", args: ["canary-home"] },
    notion: { command: "echo", args: ["notion"] },
  });
  await writeMcpJson(files["canary-xdg"], {
    "canary-xdg": { command: "echo", args: ["canary-xdg"] },
  });
  await writeMcpJson(files["canary-agents"], {
    "canary-agents": { command: "echo", args: ["canary-agents"] },
  });
  await writeMcpJson(files["canary-project"], {
    "canary-project": { command: "echo", args: ["canary-project"] },
  });
  await writeMcpJson(files["canary-pi-project"], {
    "canary-pi-project": { command: "echo", args: ["canary-pi-project"] },
  });
  await writeMcpJson(files["canary-cursor"], {
    "canary-cursor": { command: "echo", args: ["canary-cursor"] },
  });
  await writeMcpJson(files["canary-agent-dir"], {
    "canary-agent-dir": { command: "echo", args: ["canary-agent-dir"] },
  });
}

async function withPlantedAmbientMcp(
  fn: (ctx: { home: string; cwd: string; agentDir: string }) => Promise<void>,
  options?: { useStageAgentDir?: boolean },
): Promise<void> {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-mcp-iso-cwd-"));
    const agentDir = options?.useStageAgentDir
      ? buildStageRoots(cwd, "clarify").agentDir
      : await mkdtemp(path.join(tmpdir(), "sf-mcp-iso-agent-"));
    await mkdir(agentDir, { recursive: true });
    await plantAmbientMcpFiles(home, cwd, agentDir);
    const prevCwd = process.cwd();
    const prevAgentDirEnv = process.env[PI_CODING_AGENT_DIR_ENV];
    process.chdir(cwd);
    process.env[PI_CODING_AGENT_DIR_ENV] = agentDir;
    try {
      await fn({ home, cwd, agentDir });
    } finally {
      process.chdir(prevCwd);
      if (prevAgentDirEnv === undefined) {
        delete process.env[PI_CODING_AGENT_DIR_ENV];
      } else {
        process.env[PI_CODING_AGENT_DIR_ENV] = prevAgentDirEnv;
      }
    }
  });
}

async function sealedLoader(options: {
  cwd: string;
  agentDir: string;
  extensionFactories?: Parameters<
    typeof createSealedResourceLoader
  >[0]["extensionFactories"];
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

function lastLoaderOptions(): Record<string, unknown> {
  const options = piSdkMocks.capturedLoaderOptions.at(-1);
  if (options === undefined) {
    throw new Error("DefaultResourceLoader was not constructed");
  }
  return options;
}

function registeredToolNames(loader: {
  getExtensions: () => {
    extensions: Array<{ path: string; tools: Map<string, unknown> }>;
  };
}): string[] {
  return loader
    .getExtensions()
    .extensions.flatMap((ext) => [...ext.tools.keys()]);
}

function extensionErrorBlob(loader: {
  getExtensions: () => { errors: Array<{ path: string; error: string }> };
}): string {
  return loader
    .getExtensions()
    .errors.map((entry) => `${entry.path}\n${entry.error}`)
    .join("\n");
}

function recordedAdapterOptions(): unknown[] {
  return createMcpAdapter.mock.calls.map((call) => call[0]);
}

function recordedServerNames(): string[] {
  const names: string[] = [];
  for (const options of recordedAdapterOptions()) {
    if (
      options !== undefined &&
      options !== null &&
      typeof options === "object" &&
      "config" in options
    ) {
      const config = (options as { config?: { mcpServers?: object } }).config;
      names.push(...Object.keys(config?.mcpServers ?? {}));
    }
  }
  return names;
}

function expectNoCanaryLeak(args: {
  home: string;
  cwd: string;
  agentDir: string;
  loader: {
    getExtensions: () => {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
    };
  };
}): void {
  const tools = registeredToolNames(args.loader);
  const errors = extensionErrorBlob(args.loader);
  const loadedPaths = args.loader
    .getExtensions()
    .extensions.map((ext) => ext.path)
    .join("\n");
  const adapterBlob = JSON.stringify(recordedAdapterOptions());
  const additionalPaths = JSON.stringify(
    lastLoaderOptions().additionalExtensionPaths ?? [],
  );

  for (const name of CANARY_SERVER_NAMES) {
    expect(tools.some((tool) => tool === name || tool.startsWith(`${name}__`))).toBe(
      false,
    );
    expect(recordedServerNames()).not.toContain(name);
    expect(errors).not.toContain(name);
  }

  for (const filePath of Object.values(
    canaryMcpPaths(args.home, args.cwd, args.agentDir),
  )) {
    expect(errors).not.toContain(filePath);
    expect(loadedPaths).not.toContain(filePath);
    expect(adapterBlob).not.toContain(filePath);
  }

  expect(errors).not.toContain(".cursor/mcp.json");
  expect(loadedPaths).not.toContain(".cursor/mcp.json");
  expect(additionalPaths).not.toMatch(/pi-mcp-adapter/);
  expect(loadedPaths).not.toMatch(/pi-mcp-adapter/);
}

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

describe("ambient MCP isolation", () => {
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

  it("AE1: github snapshot factory config is exactly github; ambient canaries stay out", async () => {
    await withPlantedAmbientMcp(async ({ home, cwd, agentDir }) => {
      const attached = await piIsolatedMcp.attachIsolatedMcp(GITHUB_SNAPSHOT);
      expect(attached.extensionFactories).toHaveLength(1);
      expect(attached.extensionFactories?.[0]?.name).toBe(
        piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME,
      );

      const loader = await sealedLoader({
        cwd,
        agentDir,
        extensionFactories: attached.extensionFactories,
      });

      expect(lastLoaderOptions().noExtensions).toBe(true);
      expect(createMcpAdapter).toHaveBeenCalledTimes(1);
      const adapterOptions = createMcpAdapter.mock.calls[0]?.[0];
      expect(Object.keys(adapterOptions?.config?.mcpServers ?? {})).toEqual([
        "github",
      ]);
      expect(adapterOptions).toEqual(EXPECTED_ISOLATED_GITHUB_ADAPTER_OPTIONS);
      expect(adapterOptions).not.toHaveProperty("configPath");
      expect(adapterOptions?.config).not.toHaveProperty("configPath");

      const tools = registeredToolNames(loader);
      expect(tools).toEqual(["github__list_issues"]);
      expect(loader.getExtensions().extensions.map((ext) => ext.path)).toEqual([
        `<inline:${piIsolatedMcp.STAGEFLOW_PI_MCP_EXTENSION_NAME}>`,
      ]);
      expect(loader.getExtensions().errors).toEqual([]);
      expectNoCanaryLeak({ home, cwd, agentDir, loader });
    });
  });

  it("empty snapshot installs no MCP factory and no canary tools", async () => {
    await withPlantedAmbientMcp(async ({ home, cwd, agentDir }) => {
      expect(await piIsolatedMcp.attachIsolatedMcp({})).toEqual({
        extensionFactories: undefined,
        eventBus: undefined,
        connecting: undefined,
      });
      expect(await piIsolatedMcp.attachIsolatedMcp(undefined)).toEqual({
        extensionFactories: undefined,
        eventBus: undefined,
        connecting: undefined,
      });
      expect(createMcpAdapter).not.toHaveBeenCalled();

      const loader = await sealedLoader({ cwd, agentDir });

      expect(lastLoaderOptions().noExtensions).toBe(true);
      expect(lastLoaderOptions()).not.toHaveProperty("extensionFactories");
      expect(createMcpAdapter).not.toHaveBeenCalled();
      expect(loader.getExtensions().extensions).toEqual([]);
      expect(loader.getExtensions().errors).toEqual([]);
      expect(registeredToolNames(loader)).toEqual([]);
      expectNoCanaryLeak({ home, cwd, agentDir, loader });
    });
  });

  it("Cursor .cursor/mcp.json canary is not loaded", async () => {
    await withPlantedAmbientMcp(async ({ cwd, agentDir }) => {
      const attached = await piIsolatedMcp.attachIsolatedMcp(GITHUB_SNAPSHOT);
      const loader = await sealedLoader({
        cwd,
        agentDir,
        extensionFactories: attached.extensionFactories,
      });
      const cursorPath = path.join(cwd, ".cursor", "mcp.json");
      const blob = [
        ...registeredToolNames(loader),
        extensionErrorBlob(loader),
        ...loader.getExtensions().extensions.map((ext) => ext.path),
        JSON.stringify(recordedAdapterOptions()),
      ].join("\n");
      expect(recordedServerNames()).not.toContain("canary-cursor");
      expect(blob).not.toContain("canary-cursor");
      expect(blob).not.toContain(cursorPath);
      expect(blob).not.toContain(".cursor/mcp.json");
      expect(lastLoaderOptions().noExtensions).toBe(true);
    });
  });

  it("createMcpAdapter records only the Stageflow snapshot object", async () => {
    await withPlantedAmbientMcp(async ({ cwd, agentDir }) => {
      const attached = await piIsolatedMcp.attachIsolatedMcp(GITHUB_SNAPSHOT);
      await sealedLoader({
        cwd,
        agentDir,
        extensionFactories: attached.extensionFactories,
      });

      expect(createMcpAdapter).toHaveBeenCalled();
      for (const options of recordedAdapterOptions()) {
        expect(options).toEqual(EXPECTED_ISOLATED_GITHUB_ADAPTER_OPTIONS);
        expect(options).not.toHaveProperty("configPath");
        expect(Object.keys((options as { config: { mcpServers: object } }).config.mcpServers)).toEqual(
          ["github"],
        );
      }
    });
  });

  it("wiring with a github snapshot does not load ambient MCP files", async () => {
    await withPlantedAmbientMcp(async ({ home, cwd, agentDir }) => {
      await new PiAgentAdapter().runStage(
        wiringInput(cwd, { resolvedMcpServers: GITHUB_SNAPSHOT }),
      );

      expect(lastLoaderOptions().noExtensions).toBe(true);
      expect(createMcpAdapter).toHaveBeenCalledTimes(1);
      const adapterOptions = createMcpAdapter.mock.calls[0]?.[0];
      expect(adapterOptions).toEqual(EXPECTED_ISOLATED_GITHUB_ADAPTER_OPTIONS);
      expect(adapterOptions).not.toHaveProperty("configPath");
      expect(Object.keys(adapterOptions?.config?.mcpServers ?? {})).toEqual([
        "github",
      ]);

      const sessionOptions = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | {
            resourceLoader?: {
              getExtensions: () => {
                extensions: Array<{ path: string; tools: Map<string, unknown> }>;
                errors: Array<{ path: string; error: string }>;
              };
            };
          }
        | undefined;
      const loader = sessionOptions?.resourceLoader;
      expect(loader).toBeDefined();
      if (loader === undefined) {
        throw new Error("createAgentSession was not given a resourceLoader");
      }
      expect(registeredToolNames(loader)).toEqual(["github__list_issues"]);
      expectNoCanaryLeak({ home, cwd, agentDir, loader });
    }, { useStageAgentDir: true });
  });

  it("wiring with an empty snapshot installs no MCP factory", async () => {
    await withPlantedAmbientMcp(async ({ home, cwd, agentDir }) => {
      await new PiAgentAdapter().runStage(
        wiringInput(cwd, { resolvedMcpServers: {} }),
      );

      expect(createMcpAdapter).not.toHaveBeenCalled();
      expect(lastLoaderOptions().noExtensions).toBe(true);
      expect(lastLoaderOptions()).not.toHaveProperty("extensionFactories");
      expect(await attachSpy.mock.results.at(-1)?.value).toEqual({
        extensionFactories: undefined,
        eventBus: undefined,
        connecting: undefined,
      });

      const sessionOptions = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as
        | {
            resourceLoader?: {
              getExtensions: () => {
                extensions: Array<{ path: string; tools: Map<string, unknown> }>;
                errors: Array<{ path: string; error: string }>;
              };
            };
          }
        | undefined;
      const loader = sessionOptions?.resourceLoader;
      expect(loader).toBeDefined();
      if (loader === undefined) {
        throw new Error("createAgentSession was not given a resourceLoader");
      }
      expect(loader.getExtensions().extensions).toEqual([]);
      expect(registeredToolNames(loader)).toEqual([]);
      expectNoCanaryLeak({ home, cwd, agentDir, loader });
    }, { useStageAgentDir: true });
  });
});
