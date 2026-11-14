import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { TOOL_META, type ToolRisk } from "../toolkit/meta.js";

const ANNOTATIONS: Record<ToolRisk, Required<Omit<ToolAnnotations, "title">>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  external: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

/** MCP annotations for a tool, derived only from its risk in TOOL_META. */
export function toolAnnotations(name: string): ToolAnnotations {
  const meta = TOOL_META[name];
  if (!meta) throw new Error(`Tool metadata missing for: ${name}`);
  return { ...ANNOTATIONS[meta.risk] };
}

type JsonSchemaMethod = (params: { target: string }) => Record<string, unknown>;
type StandardWithJson = {
  jsonSchema?: { input: JsonSchemaMethod; output: JsonSchemaMethod };
  [key: string]: unknown;
};

function withoutSchemaKey(method: JsonSchemaMethod): JsonSchemaMethod {
  return (params) => {
    const { $schema: _ignored, ...rest } = method(params);
    return rest;
  };
}

/**
 * Drop the `$schema` URL zod adds to every listed input schema. The schema
 * object stays a zod schema, so validation and the agent toolkit are unchanged.
 */
function slimInputSchema<S>(schema: S): S {
  if (schema === undefined || schema === null || typeof schema !== "object") return schema;
  const holder = schema as unknown as { "~standard"?: StandardWithJson };
  const standard = holder["~standard"];
  const json = standard?.jsonSchema;
  if (!standard || !json) return schema;
  holder["~standard"] = {
    ...standard,
    jsonSchema: { input: withoutSchemaKey(json.input), output: withoutSchemaKey(json.output) },
  };
  return schema;
}

type ToolConfig = { description?: string; inputSchema?: unknown; annotations?: ToolAnnotations } & Record<string, unknown>;

/**
 * Wrap a server so every tool registration carries annotations from TOOL_META,
 * a listed input schema without `$schema`, and a description free of REST
 * route references (a model cannot call those routes).
 */
export function withToolDefaults(server: McpServer): McpServer {
  const registerTool = (name: string, config: ToolConfig, handler: unknown) => {
    if (config.description?.includes("/api/")) {
      throw new Error(`Tool ${name} description names a REST route; describe what the tool does instead`);
    }
    return (server.registerTool as (n: string, c: ToolConfig, h: unknown) => unknown)(
      name,
      { ...config, inputSchema: slimInputSchema(config.inputSchema), annotations: toolAnnotations(name) },
      handler,
    );
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return registerTool;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
