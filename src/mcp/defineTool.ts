import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { TOOL_META, type ToolRisk } from "../toolkit/meta.js";

const ANNOTATIONS: Record<ToolRisk, Required<Omit<ToolAnnotations, "title">>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  external: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

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

const slimmedSchemas = new WeakSet<object>();

// Overrides only this instance's JSON Schema hook, so zod validation and the agent toolkit still use the schema as written.
function slimInputSchema<S>(schema: S): S {
  if (schema === undefined || schema === null || typeof schema !== "object") return schema;
  if (slimmedSchemas.has(schema as object)) return schema;
  const holder = schema as unknown as { "~standard"?: StandardWithJson };
  const standard = holder["~standard"];
  const json = standard?.jsonSchema;
  if (!standard || !json) return schema;
  holder["~standard"] = {
    ...standard,
    jsonSchema: { input: withoutSchemaKey(json.input), output: withoutSchemaKey(json.output) },
  };
  slimmedSchemas.add(schema as object);
  return schema;
}

type ToolConfig = { description?: string; inputSchema?: unknown; annotations?: ToolAnnotations } & Record<string, unknown>;

export function withToolDefaults(server: McpServer): McpServer {
  const registerTool = (name: string, config: ToolConfig, handler: unknown) => {
    if (config.description?.includes("/api/")) {
      throw new Error(`Tool ${name} description names a REST route, which a model cannot call; describe what the tool does instead`);
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
