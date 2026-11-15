import type { McpServer } from "@modelcontextprotocol/server";
import { ChannelError } from "../channels/errors.js";
import type { ChannelService } from "../channels/service.js";
import {
  getConnectionFlatSchema,
  saveConnectionCreateSchema,
  saveConnectionFlatSchema,
  saveConnectionUpdateSchema,
} from "../toolkit/triggerConnectionMemoryToolModes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

function schemaError(message: string) {
  return textResult({ code: "invalid_arguments", message, status: 400 }, true);
}

function jsonBody(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export function registerConnectionTools(server: McpServer, deps: McpToolDeps): void {
  const run = async (work: (service: ChannelService) => Promise<unknown> | unknown) => {
    const channels = deps.channels;
    if (channels === undefined) return textResult({ error: "CHANNELS_UNAVAILABLE" }, true);
    try {
      return textResult(await work(channels));
    } catch (error) {
      const code = error instanceof ChannelError ? error.code : "CHANNEL_STORAGE_FAILED";
      return textResult({ error: code }, true);
    }
  };

  server.registerTool(
    "get_connection",
    {
      description:
        "List host connections without id. Read-only. Each secret field is \"env\" or \"store\", never the secret value.",
      inputSchema: getConnectionFlatSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = getConnectionFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      return run((service) => service.list());
    },
  );

  server.registerTool(
    "save_connection",
    {
      description:
        "Create or update a host connection. Returns { id, health } on create and { health } when enabled after update. Secret values are stored and never returned.",
      inputSchema: saveConnectionFlatSchema,
    },
    async (args) => {
      const parsed = saveConnectionFlatSchema.safeParse(args);
      if (!parsed.success) return schemaError(parsed.error.issues[0]?.message ?? "Invalid arguments");
      const { mode, ...rest } = args;
      if (mode === "create") {
        const body = saveConnectionCreateSchema.safeParse(rest);
        if (!body.success) return schemaError(body.error.issues[0]?.message ?? "Invalid arguments");
        const channels = deps.channels;
        if (channels === undefined) return textResult({ error: "CHANNELS_UNAVAILABLE" }, true);
        try {
          return textResult(await channels.create(jsonBody(body.data)));
        } catch (error) {
          if (error instanceof ChannelError) {
            if (error.code === "CHANNEL_OPERATION_CONFLICT") {
              return textResult({ error: "connection_EXISTS", code: "connection_EXISTS" }, true);
            }
            return textResult({ error: error.code }, true);
          }
          return textResult({ error: "CHANNEL_STORAGE_FAILED" }, true);
        }
      }
      const body = saveConnectionUpdateSchema.safeParse(rest);
      if (!body.success) return schemaError(body.error.issues[0]?.message ?? "Invalid arguments");
      const { id, ...patch } = body.data;
      return run((service) => service.update(id, jsonBody(patch)));
    },
  );

  server.registerTool(
    "remove_connection",
    {
      description:
        "Remove one connection and its stored secrets. Returns { removed: true }.",
      inputSchema: saveConnectionUpdateSchema.pick({ id: true }),
    },
    async ({ id }) => run(async (service) => {
      await service.remove(id);
      return { removed: true };
    }),
  );

  server.registerTool(
    "test_connection",
    {
      description:
        "Check connection values without saving them. Does not write the connection or its secrets. Returns the health check.",
      inputSchema: saveConnectionCreateSchema,
    },
    async (input) => run((service) => service.test(jsonBody(input))),
  );
}