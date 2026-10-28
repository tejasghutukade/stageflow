import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ChannelError } from "../src/channels/errors.js";
import { releaseChannelHost } from "../src/channels/host.js";
import { registerChannelProvider, unregisterChannelProvider } from "../src/channels/providers.js";
import { connectionsFilePath } from "../src/channels/registry.js";
import { startChannelService, type ChannelService } from "../src/channels/service.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { registerConnectionTools } from "../src/mcp/connectionTools.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { fakeChannelProvider } from "./fixtures/fakeChannelProvider.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const SECRET = "stageflow-mcp-secret-4f91c0";
const REPLACED_SECRET = "stageflow-mcp-replaced-secret-77ab";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

type RecordedTool = {
  name: string;
  description: string;
  inputSchema: ZodType | undefined;
  readOnlyHint: boolean | undefined;
  handler: (args: Record<string, unknown>, ctx: unknown) => unknown;
};

function recordConnectionTools(deps: McpToolDeps): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const recorder = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodType; annotations?: { readOnlyHint?: boolean } },
      handler: RecordedTool["handler"],
    ) {
      tools.push({
        name,
        description: config.description ?? "",
        inputSchema: config.inputSchema,
        readOnlyHint: config.annotations?.readOnlyHint,
        handler,
      });
    },
    registerResource() {},
    registerPrompt() {},
  };
  registerConnectionTools(recorder as unknown as McpServer, deps);
  return tools;
}

function depsFor(channels?: ChannelService, cwd = process.cwd()): McpToolDeps {
  return {
    cwd,
    manager: {} as McpToolDeps["manager"],
    store: {} as McpToolDeps["store"],
    ...(channels ? { channels } : {}),
  };
}

async function invoke(tools: RecordedTool[], name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return await tool.handler(args, {}) as ToolResult;
}

function bodyOf(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text!);
}

function schemaKeys(schema: ZodType | undefined): string[] {
  if (!schema || !("shape" in schema)) return [];
  return Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
}

const savedEnv = {
  home: process.env.STAGEFLOW_HOME,
  credential: process.env.STAGEFLOW_CREDENTIAL_HOME,
  connections: process.env.STAGEFLOW_CONNECTIONS_FILE,
};

function restoreEnv(): void {
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("STAGEFLOW_HOME", savedEnv.home);
  set("STAGEFLOW_CREDENTIAL_HOME", savedEnv.credential);
  set("STAGEFLOW_CONNECTIONS_FILE", savedEnv.connections);
  resetGlobalStageflowHomeForTests();
}

function createBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: "fake", config: { inbox: "a@b.test" }, secrets: { token: SECRET }, ...extra };
}

describe("connection MCP tools", () => {
  it("registers the connection tools and their arguments", () => {
    const tools = recordConnectionTools(depsFor());
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_connections",
      "create_connection",
      "update_connection",
      "remove_connection",
      "test_connection",
      "validate_connection_target",
    ]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(schemaKeys(byName.list_connections!.inputSchema)).toEqual([]);
    expect(schemaKeys(byName.create_connection!.inputSchema)).toEqual(["config", "credential", "displayName", "id", "provider", "secrets"]);
    expect(schemaKeys(byName.update_connection!.inputSchema)).toEqual(["config", "displayName", "enabled", "id", "secrets"]);
    expect(schemaKeys(byName.remove_connection!.inputSchema)).toEqual(["id"]);
    expect(schemaKeys(byName.test_connection!.inputSchema)).toEqual(["config", "credential", "displayName", "id", "provider", "secrets"]);
    expect(schemaKeys(byName.validate_connection_target!.inputSchema)).toEqual(["cc", "id", "template", "to"]);
    expect(byName.list_connections!.readOnlyHint).toBe(true);
    expect(byName.test_connection!.readOnlyHint).toBe(true);
    expect(byName.validate_connection_target!.readOnlyHint).toBe(true);
    expect(byName.create_connection!.readOnlyHint).toBeUndefined();
    expect(byName.update_connection!.readOnlyHint).toBeUndefined();
    expect(byName.remove_connection!.readOnlyHint).toBeUndefined();
  });

  it("returns CHANNELS_UNAVAILABLE without echoing arguments when the service is missing", async () => {
    const tools = recordConnectionTools(depsFor());
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_connections", {}],
      ["create_connection", createBody()],
      ["update_connection", { id: "box", secrets: { token: SECRET } }],
      ["remove_connection", { id: "box" }],
      ["test_connection", createBody()],
      ["validate_connection_target", { id: "box", to: "a@b.test" }],
    ];
    for (const [name, args] of calls) {
      const result = await invoke(tools, name, args);
      expect(result.isError).toBe(true);
      expect(bodyOf(result)).toEqual({ error: "CHANNELS_UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("returns only the channel error code when a call fails, even if the error text is a secret", async () => {
    const leaky = (): ChannelError => {
      const error = new ChannelError("CHANNEL_SECRET_UNAVAILABLE");
      Object.defineProperty(error, "message", { configurable: true, get: () => SECRET });
      return error;
    };
    expect(leaky().message).toBe(SECRET);
    const service = {
      meta: () => { throw leaky(); },
      list: () => { throw leaky(); },
      checkNow: () => Promise.reject(leaky()),
      test: () => Promise.reject(leaky()),
      validateTarget: () => { throw leaky(); },
      create: () => Promise.reject(leaky()),
      update: () => Promise.reject(leaky()),
      remove: () => Promise.reject(leaky()),
      stop: async () => {},
    } as ChannelService;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const tools = recordConnectionTools(depsFor(service));
      for (const name of ["list_connections", "create_connection", "update_connection", "remove_connection", "test_connection", "validate_connection_target"]) {
        const result = await invoke(tools, name, createBody({ id: "box", to: "a@b.test" }));
        expect(result.isError).toBe(true);
        expect(bodyOf(result)).toEqual({ error: "CHANNEL_SECRET_UNAVAILABLE" });
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }
      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SECRET);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("hides a non-channel failure message behind CHANNEL_STORAGE_FAILED", async () => {
    const service = {
      list: () => { throw new Error("unused"); },
      create: () => Promise.reject(new Error(SECRET)),
      update: () => Promise.reject(new Error("unused")),
      remove: () => Promise.reject(new Error("unused")),
      test: () => Promise.reject(new Error("unused")),
      validateTarget: () => { throw new Error("unused"); },
      checkNow: () => Promise.reject(new Error("unused")),
      meta: () => { throw new Error("unused"); },
      stop: async () => {},
    } as ChannelService;
    const result = await invoke(recordConnectionTools(depsFor(service)), "create_connection", createBody());
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toEqual({ error: "CHANNEL_STORAGE_FAILED" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("connection MCP tools against a local channel service", () => {
  let home: string;
  let service: ChannelService;
  let provider: ReturnType<typeof fakeChannelProvider>;
  let deps: McpToolDeps;
  let tools: RecordedTool[];

  afterEach(async () => {
    await service?.stop();
    if (home) await releaseChannelHost(home);
    unregisterChannelProvider("fake");
    restoreEnv();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    home = await mkdtemp(path.join(tmpdir(), "sf-mcp-conn-"));
    process.env.STAGEFLOW_CREDENTIAL_HOME = home;
    delete process.env.STAGEFLOW_CONNECTIONS_FILE;
    bindStageflowHomeForTests(home);
    provider = fakeChannelProvider();
    registerChannelProvider(provider);
    service = startChannelService(home, { intervalMs: 3_600_000 });
    deps = depsFor(service, home);
    tools = recordConnectionTools(deps);
  }

  it("creates, lists, updates, checks, and removes a connection without returning the secret", async () => {
    await start();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const listed = await invoke(tools, "list_connections");
      expect(listed.isError).toBeUndefined();
      expect(bodyOf(listed)).toEqual(service.list());

      const created = await invoke(tools, "create_connection", createBody({ id: "box", displayName: "Box" }));
      expect(created.isError).toBeUndefined();
      expect(JSON.stringify(created)).not.toContain(SECRET);
      expect(bodyOf(created)).toMatchObject({ id: "box", health: { state: "ok" } });
      expect(bodyOf(created)).not.toHaveProperty("secrets");

      const yaml = await readFile(connectionsFilePath(home), "utf8");
      expect(yaml).toContain("store:connection.box.token");
      expect(yaml).not.toContain(SECRET);
      const stored = JSON.parse(await readFile(path.join(home, "channel-secrets.json"), "utf8")) as Record<string, string>;
      expect(stored["connection.box.token"]).toBe(SECRET);

      const afterCreate = await invoke(tools, "list_connections");
      expect(JSON.stringify(afterCreate)).not.toContain(SECRET);
      expect(bodyOf(afterCreate)).toEqual(service.list());
      const summary = (bodyOf(afterCreate) as { connections: Array<{ secrets: Record<string, string> }> }).connections[0]!;
      expect(summary.secrets).toEqual({ token: "store" });
      expect(Object.values(summary.secrets).every((kind) => kind === "env" || kind === "store")).toBe(true);

      const replaced = await invoke(tools, "update_connection", { id: "box", secrets: { token: REPLACED_SECRET } });
      expect(replaced.isError).toBeUndefined();
      expect(JSON.stringify(replaced)).not.toContain(SECRET);
      expect(JSON.stringify(replaced)).not.toContain(REPLACED_SECRET);
      expect(bodyOf(replaced)).toMatchObject({ health: { state: "ok" } });
      const replacedStore = JSON.parse(await readFile(path.join(home, "channel-secrets.json"), "utf8")) as Record<string, string>;
      expect(replacedStore["connection.box.token"]).toBe(REPLACED_SECRET);

      const disabled = await invoke(tools, "update_connection", { id: "box", enabled: false });
      expect(bodyOf(disabled)).toEqual({});
      const renamed = await invoke(tools, "update_connection", {
        id: "box",
        enabled: true,
        displayName: "Renamed",
        config: { inbox: "c@d.test" },
      });
      expect(JSON.stringify(renamed)).not.toContain(REPLACED_SECRET);
      expect(bodyOf(renamed)).toMatchObject({ health: { state: "ok" } });
      const current = (bodyOf(await invoke(tools, "list_connections")) as { connections: Array<Record<string, unknown>> }).connections[0]!;
      expect(current).toMatchObject({ enabled: true, displayName: "Renamed", identity: "c@d.test", secrets: { token: "store" } });

      const cleared = await invoke(tools, "update_connection", { id: "box", displayName: null });
      expect(JSON.stringify(cleared)).not.toContain(REPLACED_SECRET);
      expect((bodyOf(await invoke(tools, "list_connections")) as { connections: Array<{ displayName: string }> }).connections[0]!.displayName).toBe("box");

      expect(bodyOf(await invoke(tools, "validate_connection_target", { id: "box", to: "person@b.test" }))).toEqual({ ok: true });
      expect(bodyOf(await invoke(tools, "validate_connection_target", { id: "box", to: "person@b.test", cc: ["other@b.test"] }))).toEqual({ ok: false, issues: ["target"] });

      const tested = await invoke(tools, "test_connection", createBody({ id: "draft-only" }));
      expect(tested.isError).toBeUndefined();
      expect(JSON.stringify(tested)).not.toContain(SECRET);
      expect(bodyOf(tested)).toMatchObject({ state: "ok" });
      expect((bodyOf(await invoke(tools, "list_connections")) as { connections: unknown[] }).connections.map((item) => (item as { id: string }).id)).toEqual(["box"]);
      await expect(stat(path.join(home, "connections.yaml"))).resolves.toBeTruthy();

      const removed = await invoke(tools, "remove_connection", { id: "box" });
      expect(removed.isError).toBeUndefined();
      expect(bodyOf(removed)).toEqual({ removed: true });
      expect(JSON.stringify(removed)).not.toContain(REPLACED_SECRET);
      expect((bodyOf(await invoke(tools, "list_connections")) as { connections: unknown[] }).connections).toEqual([]);

      const missing = await invoke(tools, "remove_connection", { id: "box" });
      expect(missing.isError).toBe(true);
      expect(bodyOf(missing)).toEqual({ error: "CHANNEL_NOT_FOUND" });
      expect(JSON.stringify(missing)).not.toContain(REPLACED_SECRET);
      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SECRET);
      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(REPLACED_SECRET);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("lists an env secret reference as env and never the variable name's value", async () => {
    await start();
    await writeFile(
      connectionsFilePath(home),
      "version: 1\nconnections:\n  - id: box\n    provider: fake\n    config: { inbox: a@b.test }\n    secrets: { token: env:BOX_TOKEN }\n",
    );
    await service.stop();
    await releaseChannelHost(home);
    service = startChannelService(home, { intervalMs: 3_600_000 });
    deps.channels = service;
    const listed = await invoke(tools, "list_connections");
    expect(listed.isError).toBeUndefined();
    expect(bodyOf(listed)).toEqual(service.list());
    const summary = (bodyOf(listed) as { connections: Array<{ secrets: Record<string, string> }> }).connections[0]!;
    expect(summary.secrets).toEqual({ token: "env" });
    expect(JSON.stringify(listed)).not.toContain("BOX_TOKEN");
  });

  it("rejects an invalid create with a code and does not save or return the secret", async () => {
    await start();
    const result = await invoke(tools, "create_connection", createBody({ config: { inbox: 1 } }));
    expect(result.isError).toBe(true);
    expect(bodyOf(result)).toEqual({ error: "CHANNEL_INVALID_INPUT" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(service.list().connections).toEqual([]);
    await expect(stat(connectionsFilePath(home))).rejects.toThrow();
  });

  it("returns a failed health check from test without saving", async () => {
    await start();
    provider.health = "failed";
    provider.check = async () => {
      throw new Error(`provider said ${SECRET}`);
    };
    const result = await invoke(tools, "test_connection", createBody());
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(bodyOf(result)).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
    expect(service.list().connections).toEqual([]);
    await expect(stat(connectionsFilePath(home))).rejects.toThrow();
  });
});
