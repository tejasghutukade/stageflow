import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
import { createMemoryHost, type MemoryHost } from "../src/memory/host.js";
import { MEMORY_PAGE_CAP } from "../src/memory/ids.js";
import type { McpToolDeps } from "../src/mcp/deps.js";
import { registerMemoryHostTools } from "../src/mcp/memoryHostTools.js";

const TOOL_NAMES = [
  "list_memories",
  "get_memory",
  "create_memory",
  "write_memory",
  "write_memory_card",
  "delete_memory_card",
];

const SESSION_TOOL_NAMES = [
  "replace_memory",
  "add_memory_card",
  "update_memory_card",
  "read_memory",
  "read_memory_card",
];

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type RecordedTool = {
  name: string;
  description: string;
  inputSchema: ZodType | undefined;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(deps: McpToolDeps): RecordedTool[] {
  const tools: RecordedTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: ZodType },
      handler: RecordedTool["handler"],
    ) {
      tools.push({
        name,
        description: config.description ?? "",
        inputSchema: config.inputSchema,
        handler,
      });
    },
  };
  registerMemoryHostTools(server as unknown as McpServer, deps);
  return tools;
}

async function memories(): Promise<MemoryHost> {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-mcp-memory-"));
  homes.push(dir);
  return createMemoryHost(dir);
}

function deps(host?: MemoryHost): McpToolDeps {
  return { memories: host } as McpToolDeps;
}

function tool(tools: RecordedTool[], name: string): RecordedTool {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function read(result: ToolResult): { isError: boolean; body: Record<string, unknown> } {
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

describe("MCP host memory tools", () => {
  it("registers the console memory operations and no session memory tools", async () => {
    const tools = record(deps(await memories()));
    expect(tools.map((item) => item.name)).toEqual(TOOL_NAMES);
    for (const name of SESSION_TOOL_NAMES) expect(tools.map((item) => item.name)).not.toContain(name);
    expect(tools.every((item) => item.description.length > 0 && item.inputSchema)).toBe(true);
    expect(tool(tools, "get_memory").inputSchema!.safeParse({}).success).toBe(false);
    expect(tool(tools, "get_memory").inputSchema!.safeParse({ id: "pool" }).success).toBe(true);
    expect(tool(tools, "write_memory_card").inputSchema!.safeParse({ id: "pool", key: "k" }).success).toBe(false);
  });

  it("creates, lists, reads, and replaces a cover, then updates and deletes an existing card", async () => {
    const host = await memories();
    const tools = record(deps(host));
    const call = (name: string, args: Record<string, unknown> = {}) => tool(tools, name).handler(args).then(read);

    const created = await call("create_memory", { id: "pool", description: "People already sourced." });
    expect(created.isError).toBe(false);
    expect(created.body).toEqual({ id: "pool", description: "People already sourced.", body: "" });

    const listed = await call("list_memories");
    expect(listed.body).toEqual({
      memories: [{ id: "pool", description: "People already sourced.", cardCount: 0 }],
    });

    expect(await call("get_memory", { id: "pool" })).toMatchObject({
      isError: false,
      body: { id: "pool", description: "People already sourced.", body: "", keys: [] },
    });

    const written = await call("write_memory", { id: "pool", body: "new cover" });
    expect(written.body).toEqual({ id: "pool", description: "People already sourced.", body: "new cover" });

    await host.addCard("pool", "ada@example.com", "sourced");
    const covered = await call("write_memory", { id: "pool", body: "newer cover" });
    expect(covered.body).toMatchObject({ body: "newer cover" });
    expect(await call("get_memory", { id: "pool" })).toMatchObject({
      body: { body: "newer cover", keys: ["ada@example.com"] },
    });

    const card = await call("write_memory_card", { id: "pool", key: "ada@example.com", body: "shortlisted" });
    expect(card).toEqual({ isError: false, body: { body: "shortlisted" } });
    expect(await host.readCard("pool", "ada@example.com")).toBe("shortlisted");

    const removed = await call("delete_memory_card", { id: "pool", key: "ada@example.com" });
    expect(removed).toEqual({ isError: false, body: { removed: true } });
    expect(await call("get_memory", { id: "pool" })).toMatchObject({ body: { keys: [] } });
    await expect(host.readCard("pool", "ada@example.com")).rejects.toMatchObject({ code: "MEMORY_CARD_NOT_FOUND" });
  });

  it("returns MemoryError codes and does not create a missing card", async () => {
    const host = await memories();
    const addCard = vi.spyOn(host, "addCard");
    const tools = record(deps(host));
    const call = (name: string, args: Record<string, unknown> = {}) => tool(tools, name).handler(args).then(read);

    expect(await call("create_memory", { id: "1pool", description: "nope" })).toEqual({
      isError: true,
      body: { error: "MEMORY_INVALID_ID" },
    });
    expect(await call("create_memory", { id: "pool", description: "" })).toEqual({
      isError: true,
      body: { error: "MEMORY_INVALID_DESCRIPTION" },
    });

    expect((await call("create_memory", { id: "pool", description: "People already sourced." })).isError).toBe(false);
    expect(await call("create_memory", { id: "pool", description: "again" })).toEqual({
      isError: true,
      body: { error: "MEMORY_EXISTS" },
    });
    expect(await call("get_memory", { id: "missing" })).toEqual({
      isError: true,
      body: { error: "MEMORY_NOT_FOUND" },
    });
    expect(await call("write_memory", { id: "missing", body: "x" })).toEqual({
      isError: true,
      body: { error: "MEMORY_NOT_FOUND" },
    });

    const missingCard = await call("write_memory_card", { id: "pool", key: "ada@example.com", body: "sourced" });
    expect(missingCard).toEqual({ isError: true, body: { error: "MEMORY_CARD_NOT_FOUND" } });
    expect(addCard).not.toHaveBeenCalled();
    expect(await host.listCards("pool")).toEqual([]);

    await host.addCard("pool", "ada@example.com", "sourced");
    expect(await call("write_memory_card", {
      id: "pool",
      key: "ada@example.com",
      body: "x".repeat(MEMORY_PAGE_CAP + 1),
    })).toEqual({ isError: true, body: { error: "MEMORY_TOO_LARGE" } });
    expect(await host.readCard("pool", "ada@example.com")).toBe("sourced");
    expect(addCard).toHaveBeenCalledTimes(1);

    expect(await call("delete_memory_card", { id: "pool", key: "missing" })).toEqual({
      isError: true,
      body: { error: "MEMORY_CARD_NOT_FOUND" },
    });
    expect(await host.readCard("pool", "ada@example.com")).toBe("sourced");
  });

  it("returns MEMORIES_UNAVAILABLE when the host is not configured", async () => {
    const tools = record(deps());
    for (const item of tools) {
      const result = read(await item.handler({}));
      expect(result).toEqual({ isError: true, body: { error: "MEMORIES_UNAVAILABLE" } });
    }
  });
});
