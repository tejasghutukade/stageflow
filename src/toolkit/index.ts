import type { ZodType } from "zod";
import { z } from "zod";
import type { McpToolDeps } from "../mcp/deps.js";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import { checkAgentCaller, type ToolCaller } from "./guard.js";
import { stageflowGrantId, TOOL_GROUPS, TOOL_META, type ToolMeta } from "./meta.js";
import { recordMcpTools } from "./record.js";

export * from "./meta.js";
export { grantsBeyond, type ToolCaller } from "./guard.js";

export type ToolkitResult = { ok: boolean; text: string };

export type ToolkitTool = ToolMeta & {
  name: string;
  /** The id the policy gate and `approvals.ask_first` use. */
  grantId: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal; caller?: ToolCaller }): Promise<ToolkitResult>;
};

type RawResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

function toResult(raw: unknown): ToolkitResult {
  const result = (raw ?? {}) as RawResult;
  const text = (result.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");
  return { ok: result.isError !== true, text };
}

function jsonSchema(schema: ZodType | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

/**
 * Every Stageflow tool, derived from the MCP registrations. A tool with no
 * metadata (or metadata with no tool) is a programming error, caught here
 * and by the coverage test.
 */
export function buildToolkit(deps: McpToolDeps): ToolkitTool[] {
  const recorded = recordMcpTools(deps);
  const missing = recorded.filter((tool) => !(tool.name in TOOL_META)).map((tool) => tool.name);
  if (missing.length > 0) throw new Error(`Toolkit metadata missing for: ${missing.join(", ")}`);
  const root = () => defaultAgentProjectRoot(deps.cwd);
  return recorded.map((tool) => {
    const meta = TOOL_META[tool.name]!;
    return {
      ...meta,
      name: tool.name,
      grantId: stageflowGrantId(tool.name),
      description: tool.description,
      parameters: jsonSchema(tool.inputSchema),
      async run(args, ctx) {
        const parsed = tool.inputSchema ? tool.inputSchema.safeParse(args) : { success: true as const, data: args };
        if (!parsed.success) return { ok: false, text: JSON.stringify({ error: "Invalid arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }) };
        if (ctx.caller) {
          const refused = await checkAgentCaller(tool.name, parsed.data as Record<string, unknown>, ctx.caller, deps.agentService, root());
          if (refused) return { ok: false, text: JSON.stringify({ error: refused.message }) };
        }
        const mcpCtx = { mcpReq: { signal: ctx.signal, _meta: undefined, notify: async () => undefined } };
        const raw = tool.inputSchema ? await tool.handler(parsed.data as Record<string, unknown>, mcpCtx) : await (tool.handler as unknown as (c: unknown) => unknown)(mcpCtx);
        return toResult(raw);
      },
    };
  });
}

export function toolkitNames(toolkit: readonly ToolkitTool[]): string[] {
  return toolkit.map((tool) => tool.name);
}

export type ToolkitCatalog = {
  groups: Array<{ id: string; title: string; summary: string; tools: Array<{ name: string; grantId: string; risk: ToolMeta["risk"]; description: string }> }>;
};

let catalogCache: ToolkitCatalog | undefined;

/** The groups and tools the console offers for granting. Handlers are never run, so no Host services are needed. */
export function describeToolkit(): ToolkitCatalog {
  if (catalogCache) return catalogCache;
  const described = recordMcpTools({ cwd: process.cwd(), store: {} as never, manager: {} as never });
  const byName = new Map(described.map((tool) => [tool.name, tool.description]));
  catalogCache = {
    groups: TOOL_GROUPS.map((group) => ({
      ...group,
      tools: Object.entries(TOOL_META)
        .filter(([, meta]) => meta.group === group.id)
        .map(([name, meta]) => ({ name, grantId: stageflowGrantId(name), risk: meta.risk, description: byName.get(name) ?? "" })),
    })),
  };
  return catalogCache;
}
