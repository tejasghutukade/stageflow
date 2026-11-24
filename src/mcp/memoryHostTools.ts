import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { MemoryError, type MemoryHost } from "../memory/host.js";
import {
  getMemoryFlatSchema,
  saveMemoryFlatSchema,
} from "../toolkit/triggerConnectionMemoryToolModes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

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
    "get_memory",
    {
      description: "List host memories without id, or read one memory.",
      inputSchema: getMemoryFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getMemoryFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      if (parsed.data.id === undefined) {
        return call(deps, async (host) => ({ memories: await host.list() }));
      }
      const { id } = parsed.data;
      return call(deps, async (host) => {
        const meta = await host.readMeta(id);
        const body = await host.read(id);
        const keys = await host.listCards(id);
        return { ...meta, body, keys };
      });
    },
  );

  server.registerTool(
    "save_memory",
    {
      description:
        "Create a host memory or update its cover page or one card. mode create starts an empty cover. mode update with card replaces an existing card only.",
      inputSchema: saveMemoryFlatSchema,
    },
    async (args) => {
      const parsed = saveMemoryFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const value = parsed.data;
      if (value.mode === "create") {
        return call(deps, (host) => host.create({ id: value.id, description: value.description! }));
      }
      if (value.card !== undefined) {
        return call(deps, async (host) => {
          await host.updateCard(value.id, value.card!, value.body!);
          return { body: value.body };
        });
      }
      return call(deps, async (host) => {
        await host.replace(value.id, value.body!);
        const meta = await host.readMeta(value.id);
        return { ...meta, body: value.body };
      });
    },
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
    async ({ id, key }) =>
      call(deps, async (host) => {
        await host.deleteCard(id, key);
        return { removed: true };
      }),
  );
}