import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_STATUS_EVENT,
  mcpStatusSourceFromEvents,
  waitForIsolatedMcpConnect,
  type IsolatedMcpStatusSnapshot,
} from "../src/agent/piMcpConnect.js";
import { createSealedResourceLoader } from "../src/agent/piAdapter.js";
import { StageMcpError } from "../src/config/resolveStageMcpServers.js";

const createMcpAdapter = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("pi-mcp-adapter", () => ({
  createMcpAdapter,
}));

const {
  mcpExtensionFactoriesForSnapshot,
  STAGEFLOW_PI_MCP_EXTENSION_NAME,
  toIsolatedMcpConfig,
} = await import("../src/agent/piMcpExtension.js");

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

describe("toIsolatedMcpConfig", () => {
  it("maps stdio and HTTP servers to eager isolated entries", () => {
    const snapshot = {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "x" },
        cwd: "/tmp/github",
      },
      docs: {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      },
    };
    const config = toIsolatedMcpConfig(snapshot);
    expect(Object.keys(config.mcpServers)).toEqual(["github", "docs"]);
    expect(config.mcpServers.github).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "x" },
      cwd: "/tmp/github",
      lifecycle: "eager",
      directTools: true,
    });
    expect(config.mcpServers.docs).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer t" },
      lifecycle: "eager",
      directTools: true,
    });
    expect(config).not.toHaveProperty("configPath");
    expect(config).not.toHaveProperty("imports");
    expect(config.settings).toEqual({
      directTools: true,
      elicitation: false,
      hostConfigDiscovery: "off",
    });
    expect(config.settings).not.toHaveProperty("approveTools");
    expect(config.settings).not.toHaveProperty("autoAuth");
  });

  it("overlays eager lifecycle even when the snapshot asked for lazy", () => {
    const config = toIsolatedMcpConfig({
      github: { command: "npx", lifecycle: "lazy", directTools: false },
    });
    expect(config.mcpServers.github?.lifecycle).toBe("eager");
    expect(config.mcpServers.github?.directTools).toBe(true);
  });
});

describe("mcpExtensionFactoriesForSnapshot", () => {
  beforeEach(() => {
    createMcpAdapter.mockClear();
  });

  it("returns no factory for an omitted snapshot", () => {
    expect(mcpExtensionFactoriesForSnapshot(undefined)).toEqual([]);
    expect(createMcpAdapter).not.toHaveBeenCalled();
  });

  it("returns no factory for an empty snapshot", () => {
    expect(mcpExtensionFactoriesForSnapshot({})).toEqual([]);
    expect(createMcpAdapter).not.toHaveBeenCalled();
  });

  it("returns a named factory for a non-empty snapshot", () => {
    const snapshot = {
      docs: { url: "https://mcp.example.com/mcp" },
    };
    const factories = mcpExtensionFactoriesForSnapshot(snapshot);
    expect(factories).toHaveLength(1);
    expect(factories[0]).toMatchObject({
      name: STAGEFLOW_PI_MCP_EXTENSION_NAME,
    });
    expect(factories[0]).toEqual(
      expect.objectContaining({
        factory: expect.any(Function),
      }),
    );
    expect(createMcpAdapter).toHaveBeenCalledTimes(1);
    const adapterOptions = createMcpAdapter.mock.calls[0]?.[0];
    expect(adapterOptions).toEqual({
      config: toIsolatedMcpConfig(snapshot),
    });
    expect(adapterOptions).not.toHaveProperty("configPath");
    expect(adapterOptions?.config.settings.hostConfigDiscovery).toBe("off");
    expect(adapterOptions?.config.settings.elicitation).toBe(false);
  });
});

describe("waitForIsolatedMcpConnect", () => {
  const snapshot = {
    github: { url: "https://mcp.example.invalid/mcp" },
  };

  function statusOf(
    name: string,
    status: IsolatedMcpStatusSnapshot["servers"][number]["status"],
  ): IsolatedMcpStatusSnapshot {
    return { servers: [{ name, status }] };
  }

  it("skips connect wait for an empty snapshot", async () => {
    const subscribe = vi.fn();
    const read = vi.fn();
    await waitForIsolatedMcpConnect({}, { read, subscribe }, { timeoutMs: 20 });
    await waitForIsolatedMcpConnect(undefined, { read, subscribe }, { timeoutMs: 20 });
    expect(read).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  async function expectConnectFailed(
    run: Promise<void>,
    message: string | RegExp,
  ): Promise<void> {
    const err = await run.then(
      () => {
        throw new Error("expected StageMcpError");
      },
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(StageMcpError);
    expect(err).toMatchObject({
      name: "StageMcpError",
      code: "connect_failed",
    });
    expect((err as StageMcpError).message).toMatch(message);
  }

  it("treats a failed status for github as connect_failed", async () => {
    await expectConnectFailed(
      waitForIsolatedMcpConnect(snapshot, {
        read: () => statusOf("github", "failed"),
      }),
      /github/,
    );
  });

  it("treats needs-auth as connect_failed", async () => {
    await expectConnectFailed(
      waitForIsolatedMcpConnect(snapshot, {
        read: () => statusOf("github", "needs-auth"),
      }),
      /github[\s\S]*needs-auth|needs-auth[\s\S]*github/,
    );
  });

  it("treats a status wait that times out as connect_failed", async () => {
    await expectConnectFailed(
      waitForIsolatedMcpConnect(
        snapshot,
        { read: () => statusOf("github", "not-connected") },
        { timeoutMs: 20 },
      ),
      /github/,
    );
  });

  it("resolves when a subscribed status becomes connected", async () => {
    const listeners = new Set<(next: IsolatedMcpStatusSnapshot) => void>();
    const pending = waitForIsolatedMcpConnect(
      snapshot,
      {
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      { timeoutMs: 200 },
    );
    for (const listener of listeners) {
      listener(statusOf("github", "connected"));
    }
    await pending;
  });

  it("maps MCP_STATUS_EVENT snapshots from an event bus", async () => {
    const handlers = new Set<(data: unknown) => void>();
    const pending = waitForIsolatedMcpConnect(
      snapshot,
      mcpStatusSourceFromEvents({
        on(channel, handler) {
          expect(channel).toBe(MCP_STATUS_EVENT);
          handlers.add(handler);
          return () => {
            handlers.delete(handler);
          };
        },
      }),
      { timeoutMs: 200 },
    );
    for (const handler of handlers) {
      handler({
        version: 1,
        servers: [{ name: "github", status: "cached", toolCount: 1, disabled: false }],
      });
    }
    await pending;
  });
});

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
