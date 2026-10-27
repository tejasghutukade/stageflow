import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { MemoryError, type MemoryHost } from "../memory/host.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

async function call(deps: McpToolDeps, work: (host: MemoryHost) => Promise<unknown>) {
  const host = deps.memories;
  if (!host) return textResult({ error: "MEMORIES_UNAVAILABLE" }, true);
  try {
    return textResult(await work(host));
  } catch (error) {
    if (error instanceof MemoryError) return textResult({ error: error.code }, true);
    throw error;
  }
}

export function registerMemoryHostTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    "list_memories",
    {
      description: "List host memories (id, description, and card count).",
      inputSchema: z.object({}),
    },
    () => call(deps, async (host) => ({ memories: await host.list() })),
  );

  server.registerTool(
    "get_memory",
    {
      description: "Read one host memory: its description, cover page, and card keys.",
      inputSchema: z.object({
        id: z.string(),
      }),
    },
    ({ id }) =>
      call(deps, async (host) => {
        const meta = await host.readMeta(id);
        const body = await host.read(id);
        const keys = await host.listCards(id);
        return { ...meta, body, keys };
      }),
  );

  server.registerTool(
    "create_memory",
    {
      description: "Create a host memory with an id and description. The cover page starts empty.",
      inputSchema: z.object({
        id: z.string(),
        description: z.string(),
      }),
    },
    ({ id, description }) => call(deps, (host) => host.create({ id, description })),
  );

  server.registerTool(
    "write_memory",
    {
      description: "Replace the cover page of a host memory.",
      inputSchema: z.object({
        id: z.string(),
        body: z.string(),
      }),
    },
    ({ id, body }) =>
      call(deps, async (host) => {
        await host.replace(id, body);
        const meta = await host.readMeta(id);
        return { ...meta, body };
      }),
  );

  server.registerTool(
    "write_memory_card",
    {
      description: "Replace an existing host memory card. A missing card is not created.",
      inputSchema: z.object({
        id: z.string(),
        key: z.string(),
        body: z.string(),
      }),
    },
    ({ id, key, body }) =>
      call(deps, async (host) => {
        await host.updateCard(id, key, body);
        return { body };
      }),
  );

  server.registerTool(
    "delete_memory_card",
    {
      description: "Delete one card from a host memory.",
      inputSchema: z.object({
        id: z.string(),
        key: z.string(),
      }),
    },
    ({ id, key }) =>
      call(deps, async (host) => {
        await host.deleteCard(id, key);
        return { removed: true };
      }),
  );
}
