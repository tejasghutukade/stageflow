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
const piIsolatedMcp = await import("../src/agent/piIsolatedMcp.js");
const { probeProjectMcpServer, PROJECT_MCP_PROBE_TIMEOUT_MS } = await import(
  "../src/agent/piIsolatedMcpProbe.js"
);

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

describe("probeProjectMcpServer", () => {
  const secret = "u2-probe-secret-token-7e1d";

  async function writeCatalog(
    root: string,
    servers: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: servers }),
    );
  }

  async function withAttachEmit(
    status: string,
    run: () => Promise<unknown>,
  ): Promise<ReturnType<typeof attachIsolatedMcp> | undefined> {
    let attached: Awaited<ReturnType<typeof attachIsolatedMcp>> | undefined;
    const spy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
      async (snapshot, options) => {
        attached = await attachIsolatedMcp(snapshot, options);
        queueMicrotask(() => {
          if (attached?.eventBus) {
            emitIsolatedMcpStatus(attached.eventBus, [
              { name: Object.keys(snapshot ?? {})[0] ?? "github", status },
            ]);
          }
        });
        return attached;
      },
    );
    try {
      await run();
      return attached;
    } finally {
      spy.mockRestore();
    }
  }

  it("does not import openStage or prepareStageSessionWiring", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "../src/agent/piIsolatedMcpProbe.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/openStage/);
    expect(source).not.toMatch(/prepareStageSessionWiring/);
  });

  it("returns connected without calling openStage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-connected-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    const { PiAgentAdapter } = await import("../src/agent/piAdapter.js");
    const openStage = vi.spyOn(PiAgentAdapter.prototype, "openStage");
    let probed: unknown;
    try {
      createMcpAdapter.mockClear();
      await withAttachEmit("connected", async () => {
        probed = await probeProjectMcpServer({
          projectRoot: root,
          name: "github",
        });
      });
      expect(probed).toEqual({ name: "github", status: "connected" });
      expect(openStage).not.toHaveBeenCalled();
      const adapterOptions = createMcpAdapter.mock.calls[0]?.[0] as
        | {
            config?: {
              mcpServers?: Record<string, Record<string, unknown>>;
            };
          }
        | undefined;
      expect(adapterOptions?.config?.mcpServers?.github).toMatchObject({
        lifecycle: "eager",
      });
    } finally {
      openStage.mockRestore();
    }
  });

  it("maps Pi cached to connected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-cached-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    let probed: unknown;
    await withAttachEmit("cached", async () => {
      probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
      });
    });
    expect(probed).toEqual({ name: "github", status: "connected" });
  });

  it("maps needs-auth to needs_auth, not connect_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-auth-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    let probed: unknown;
    await withAttachEmit("needs-auth", async () => {
      probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
      });
    });
    expect(probed).toEqual({ name: "github", status: "needs_auth" });
    expect(probed).not.toMatchObject({ status: "connect_failed" });
  });

  it("maps failed status to connect_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-fail-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    let probed: unknown;
    await withAttachEmit("failed", async () => {
      probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
      });
    });
    expect(probed).toMatchObject({
      name: "github",
      status: "connect_failed",
    });
  });

  it("maps timeout to connect_failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-timeout-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    const probed = await probeProjectMcpServer({
      projectRoot: root,
      name: "github",
      timeoutMs: 20,
    });
    expect(probed).toMatchObject({
      name: "github",
      status: "connect_failed",
    });
  });

  it("abort yields cancelled and calls cancel without leaving connecting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-abort-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    const ac = new AbortController();
    let attached: Awaited<ReturnType<typeof attachIsolatedMcp>> | undefined;
    const spy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
      async (snapshot, options) => {
        attached = await attachIsolatedMcp(snapshot, {
          ...options,
          timeoutMs: 5_000,
        });
        queueMicrotask(() => ac.abort());
        return attached;
      },
    );
    try {
      const probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
        signal: ac.signal,
        timeoutMs: 5_000,
      });
      expect(probed).toEqual({ name: "github", status: "cancelled" });
      await expectConnectFailed(attached?.connecting, /cancelled/);
    } finally {
      spy.mockRestore();
    }
  });

  it("unresolved interpolation is unresolved_var and does not attach", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-unresolved-"));
    await writeCatalog(root, {
      github: {
        url: "https://secret-host.example/${MISSING_PROBE_VAR}/mcp",
        headers: { Authorization: `Bearer ${secret}` },
      },
      neighbor: { command: "npx", args: ["should-not-spawn"] },
    });
    const attachSpy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp");
    createMcpAdapter.mockClear();
    try {
      const probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
        env: {},
      });
      expect(probed.status).toBe("unresolved_var");
      expect(probed).not.toHaveProperty("resolved");
      expect(JSON.stringify(probed)).not.toContain("secret-host.example");
      expect(JSON.stringify(probed)).not.toContain(secret);
      expect(attachSpy).not.toHaveBeenCalled();
      expect(createMcpAdapter).not.toHaveBeenCalled();
    } finally {
      attachSpy.mockRestore();
    }
  });

  it("rejects an unknown name without probing neighbors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-unknown-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
      neighbor: { command: "npx", args: ["should-not-spawn"] },
    });
    const attachSpy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp");
    createMcpAdapter.mockClear();
    try {
      const probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "missing",
      });
      expect(probed.status).toBe("invalid_config");
      expect(attachSpy).not.toHaveBeenCalled();
      expect(createMcpAdapter).not.toHaveBeenCalled();
    } finally {
      attachSpy.mockRestore();
    }
  });

  it("bad catalog is invalid_config without attach", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-badcat-"));
    await writeFile(path.join(root, ".mcp.json"), "{ not json");
    const attachSpy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp");
    try {
      const probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
      });
      expect(probed).toEqual({ name: "github", status: "invalid_config" });
      expect(attachSpy).not.toHaveBeenCalled();
    } finally {
      attachSpy.mockRestore();
    }
  });

  it("scrubs interpolated env and header values from connect errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-scrub-"));
    await writeCatalog(root, {
      github: {
        url: "https://mcp.example.invalid/mcp",
        headers: { Authorization: `Bearer ${secret}` },
        env: { GITHUB_TOKEN: secret },
      },
    });
    const spy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
      async (snapshot, options) => {
        const attached = await attachIsolatedMcp(snapshot, options);
        queueMicrotask(() => {
          emitIsolatedMcpStatus(attached.eventBus!, [
            { name: "github", status: "failed" },
          ]);
        });
        return {
          ...attached,
          connecting: Promise.reject(
            new StageMcpError(
              `MCP server "github" failed to connect (status: failed) token=${secret}`,
              "connect_failed",
            ),
          ),
        };
      },
    );
    try {
      const probed = await probeProjectMcpServer({
        projectRoot: root,
        name: "github",
        env: {},
      });
      expect(probed.status).toBe("connect_failed");
      expect(JSON.stringify(probed)).not.toContain(secret);
      expect(probed.error).toContain("[redacted]");
      expect(probed).not.toHaveProperty("env");
      expect(probed).not.toHaveProperty("headers");
      expect(probed).not.toHaveProperty("args");
      expect(probed).not.toHaveProperty("url");
      expect(probed).not.toHaveProperty("resolved");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses a Settings-length timeout, not the stage 5s default", async () => {
    expect(PROJECT_MCP_PROBE_TIMEOUT_MS).toBe(30_000);
    const root = await mkdtemp(path.join(tmpdir(), "sf-probe-timeout-bound-"));
    await writeCatalog(root, {
      github: { url: "https://mcp.example.invalid/mcp" },
    });
    const spy = vi.spyOn(piIsolatedMcp, "attachIsolatedMcp").mockImplementation(
      async (snapshot, options) => {
        expect(options?.timeoutMs).toBe(30_000);
        const attached = await attachIsolatedMcp(snapshot, options);
        queueMicrotask(() => {
          emitIsolatedMcpStatus(attached.eventBus!, [
            { name: "github", status: "connected" },
          ]);
        });
        return attached;
      },
    );
    try {
      await probeProjectMcpServer({ projectRoot: root, name: "github" });
    } finally {
      spy.mockRestore();
    }
  });
});
