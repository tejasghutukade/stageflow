import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  StageMcpError,
  resolveStageMcpServers,
} from "../src/config/resolveStageMcpServers.js";

const createMcpAdapter = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("pi-mcp-adapter", () => ({
  createMcpAdapter,
}));

const {
  attachIsolatedMcp,
  emitIsolatedMcpStatus,
  STAGEFLOW_PI_MCP_EXTENSION_NAME,
} = await import("../src/agent/piIsolatedMcp.js");

function githubSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    github: { url: "https://mcp.example.invalid/mcp", ...overrides },
  };
}

async function expectConnectFailed(
  run: Promise<void> | undefined,
  message: string | RegExp,
): Promise<void> {
  if (run === undefined) {
    throw new Error("expected connecting promise");
  }
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

async function settleTick(): Promise<string> {
  return "pending";
}

describe("attachIsolatedMcp", () => {
  it("does not call createMcpAdapter on import or empty attach", async () => {
    expect(createMcpAdapter).not.toHaveBeenCalled();
    expect(await attachIsolatedMcp(undefined)).toEqual({
      extensionFactories: undefined,
      eventBus: undefined,
      connecting: undefined,
    });
    expect(await attachIsolatedMcp({})).toEqual({
      extensionFactories: undefined,
      eventBus: undefined,
      connecting: undefined,
    });
    expect(createMcpAdapter).not.toHaveBeenCalled();
  });

  it("first non-empty attach calls createMcpAdapter once with isolated config", async () => {
    createMcpAdapter.mockClear();
    const snapshot = {
      github: { command: "npx", lifecycle: "lazy", directTools: false },
    };
    const attached = await attachIsolatedMcp(snapshot);

    expect(createMcpAdapter).toHaveBeenCalledTimes(1);
    const adapterOptions = createMcpAdapter.mock.calls[0]?.[0] as
      | { config?: { mcpServers?: Record<string, Record<string, unknown>>; settings?: Record<string, unknown> } }
      | undefined;
    expect(adapterOptions).toEqual({
      config: expect.objectContaining({
        mcpServers: {
          github: expect.objectContaining({
            command: "npx",
            lifecycle: "lazy",
            directTools: true,
          }),
        },
        settings: expect.objectContaining({
          hostConfigDiscovery: "off",
          elicitation: false,
        }),
      }),
    });
    expect(Object.keys(adapterOptions?.config?.mcpServers ?? {})).toEqual(["github"]);
    expect(adapterOptions).not.toHaveProperty("configPath");
    expect(attached.extensionFactories).toEqual([
      expect.objectContaining({
        name: STAGEFLOW_PI_MCP_EXTENSION_NAME,
        factory: expect.any(Function),
      }),
    ]);
    expect(attached.eventBus).toEqual(
      expect.objectContaining({
        on: expect.any(Function),
        emit: expect.any(Function),
      }),
    );
    expect(attached.connecting).toBeInstanceOf(Promise);
    emitIsolatedMcpStatus(attached.eventBus!, [{ name: "github", status: "connected" }]);
    await attached.connecting;
  });

  it("maps stdio and HTTP snapshot servers through createMcpAdapter config only", async () => {
    createMcpAdapter.mockClear();
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
    const attached = await attachIsolatedMcp(snapshot);
    const adapterOptions = createMcpAdapter.mock.calls[0]?.[0] as
      | { config?: { settings?: Record<string, unknown> } }
      | undefined;
    expect(adapterOptions).toEqual({
      config: {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "x" },
            cwd: "/tmp/github",
            lifecycle: "lazy",
            directTools: true,
          },
          docs: {
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer t" },
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
    });
    expect(adapterOptions).not.toHaveProperty("configPath");
    expect(adapterOptions?.config).not.toHaveProperty("imports");
    expect(adapterOptions?.config.settings).not.toHaveProperty("approveTools");
    expect(adapterOptions?.config.settings).not.toHaveProperty("autoAuth");
    emitIsolatedMcpStatus(attached.eventBus!, [
      { name: "github", status: "connected" },
      { name: "docs", status: "cached" },
    ]);
    await attached.connecting;
  });

  it("forwards stamped projectRoot cwd from resolveStageMcpServers into isolated config", async () => {
    createMcpAdapter.mockClear();
    const root = await mkdtemp(path.join(tmpdir(), "sf-pi-mcp-cwd-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: {
            command: "npx",
            args: ["examples/stage-mcp/echo-mcp.mjs"],
          },
        },
      }),
    );
    const snapshot = await resolveStageMcpServers({
      projectRoot: root,
      allowlist: ["echo"],
      env: {},
    });
    expect(snapshot.echo.cwd).toBe(path.resolve(root));
    expect(snapshot.echo.args).toEqual([
      path.resolve(root, "examples/stage-mcp/echo-mcp.mjs"),
    ]);

    const attached = await attachIsolatedMcp(snapshot);
    const adapterOptions = createMcpAdapter.mock.calls[0]?.[0] as
      | { config?: { mcpServers?: Record<string, Record<string, unknown>> } }
      | undefined;
    expect(adapterOptions?.config?.mcpServers?.echo).toMatchObject({
      command: "npx",
      args: [path.resolve(root, "examples/stage-mcp/echo-mcp.mjs")],
      cwd: path.resolve(root),
      lifecycle: "lazy",
      directTools: true,
    });
    emitIsolatedMcpStatus(attached.eventBus!, [{ name: "echo", status: "connected" }]);
    await attached.connecting;
  });

  it.each(["connected", "cached"] as const)(
    "resolves connecting when %s is emitted before reload",
    async (status) => {
      const attached = await attachIsolatedMcp(githubSnapshot());
      expect(attached.connecting).toBeInstanceOf(Promise);
      const race = await Promise.race([attached.connecting, settleTick()]);
      expect(race).toBe("pending");

      emitIsolatedMcpStatus(attached.eventBus!, [{ name: "github", status }]);
      await attached.connecting;
    },
  );

  it.each(["failed", "needs-auth"] as const)(
    "rejects connecting with connect_failed when status is %s",
    async (status) => {
      const attached = await attachIsolatedMcp(githubSnapshot());
      emitIsolatedMcpStatus(attached.eventBus!, [{ name: "github", status }]);
      await expectConnectFailed(attached.connecting, /github/);
    },
  );

  it("rejects connecting with connect_failed when a short timeout never connects", async () => {
    const attached = await attachIsolatedMcp(githubSnapshot(), { timeoutMs: 20 });
    await expectConnectFailed(attached.connecting, /github/);
  });

  it("cancel settles connecting without waiting for the timeout", async () => {
    const attached = await attachIsolatedMcp(githubSnapshot(), { timeoutMs: 5_000 });
    expect(attached.cancel).toEqual(expect.any(Function));
    const started = Date.now();
    attached.cancel?.();
    await expectConnectFailed(attached.connecting, /cancelled/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("piAdapter isolated MCP imports", () => {
  it("no longer imports piMcpExtension or piMcpConnect", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "../src/agent/piAdapter.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/piMcpExtension/);
    expect(source).not.toMatch(/piMcpConnect/);
  });
});
