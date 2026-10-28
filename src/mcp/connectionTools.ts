import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ChannelError } from "../channels/errors.js";
import type { ChannelService } from "../channels/service.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

const secretValues = z
  .record(z.string(), z.string())
  .describe("Provider field name to secret value. Values are stored and never returned.");

const configValues = z.record(z.string(), z.unknown()).describe("Non-secret provider settings.");

const credentialInput = z.union([
  z.string().describe("Id of a credential that already exists."),
  z.object({
    id: z.string().optional().describe("Id for a new credential. The host chooses one when omitted."),
    secrets: secretValues,
  }),
]).describe("Credential id, or a new credential to store with this connection.");

const createSchema = z.object({
  provider: z.string().describe("Provider id."),
  id: z.string().optional().describe("Connection id. The host chooses one when omitted."),
  displayName: z.string().optional().describe("Label shown for the connection."),
  config: configValues.optional(),
  secrets: secretValues.optional(),
  credential: credentialInput.optional(),
}).strict();

const updateSchema = z.object({
  id: z.string().describe("Connection id."),
  enabled: z.boolean().optional().describe("Whether stages may use this connection."),
  displayName: z.string().nullable().optional().describe("Replacement label, or null to clear it."),
  config: configValues.optional(),
  secrets: secretValues.optional().describe("Secret fields to replace. Omitted fields are left unchanged."),
}).strict();

const targetValue = z.union([z.string(), z.number().int()]);

const validateSchema = z.object({
  id: z.string().describe("Connection id."),
  to: z.union([targetValue, z.array(targetValue).min(1)]).describe("Pinned recipient."),
  cc: z.array(targetValue).min(1).optional().describe("Copied recipients, when the provider allows them."),
  template: z.record(z.string(), z.unknown()).optional().describe("Provider template fields, when required."),
}).strict();

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
    "list_connections",
    {
      description:
        "List host connections, same as GET /api/connections. Read-only. Each secret field is \"env\" or \"store\", never the secret value.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run((service) => service.list()),
  );

  server.registerTool(
    "create_connection",
    {
      description:
        "Create a host connection, same as POST /api/connections. Returns { id, health }. Secret values are stored and are not in the result.",
      inputSchema: createSchema,
    },
    async (input) => run((service) => service.create(jsonBody(input))),
  );

  server.registerTool(
    "update_connection",
    {
      description:
        "Update one connection, same as PATCH /api/connections/:id. Changes enabled, displayName, config, or replaces secrets. Returns { health } when the connection stays enabled, otherwise {}. Secret values are not in the result.",
      inputSchema: updateSchema,
    },
    async ({ id, ...patch }) => run((service) => service.update(id, jsonBody(patch))),
  );

  server.registerTool(
    "remove_connection",
    {
      description:
        "Remove one connection and its stored secrets, same as DELETE /api/connections/:id. Returns { removed: true }.",
      inputSchema: z.object({
        id: z.string().describe("Connection id."),
      }).strict(),
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
        "Check connection values without saving them, same as POST /api/connections/test. Does not write the connection or its secrets. Returns the health check.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => run((service) => service.test(jsonBody(input))),
  );

  server.registerTool(
    "validate_connection_target",
    {
      description:
        "Check a pinned recipient for a saved connection, same as POST /api/connections/:id/validate-target. No network and no secret read. Returns { ok: true } or { ok: false, issues }.",
      inputSchema: validateSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ id, ...target }) => run((service) => service.validateTarget(id, jsonBody(target))),
  );
}
