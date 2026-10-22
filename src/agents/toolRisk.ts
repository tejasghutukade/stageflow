import { grantedToolIds, type AgentDefinition } from "../config/loadAgent.js";
import { isOperatorOnlyTool, STAGEFLOW_GRANT_PREFIX, TOOL_META } from "../toolkit/meta.js";
import { BUILTIN_TOOL_GROUP_OF } from "./runtime/types.js";

export type ToolClass = "read" | "write" | "shell" | "destructive" | "external" | "mcp_unknown" | "sub_agent" | "browser" | "operator_only";

export type ToolClassification = { class: ToolClass; readOnly: boolean };

type Grants = Pick<AgentDefinition, "tools" | "sub_agents">;

function listed(toolId: string, readOnlyExtra: readonly string[]): boolean {
  if (readOnlyExtra.includes(toolId)) return true;
  const dot = toolId.indexOf(".");
  return dot > 0 && readOnlyExtra.includes(`${toolId.slice(0, dot)}.*`);
}

function baseClass(toolId: string): ToolClass {
  if (toolId === "browser") return "browser";
  if (toolId.startsWith("agent:")) return "sub_agent";
  if (toolId.startsWith(STAGEFLOW_GRANT_PREFIX)) {
    const name = toolId.slice(STAGEFLOW_GRANT_PREFIX.length);
    const meta = TOOL_META[name];
    if (!meta) return "mcp_unknown";
    if (isOperatorOnlyTool(name)) return "operator_only";
    return meta.risk;
  }
  const builtin = BUILTIN_TOOL_GROUP_OF[toolId];
  if (builtin) return builtin;
  return "mcp_unknown";
}

/**
 * What an eval may assume about a tool. `readOnly` is true only for what is provably read-only (builtin read tools,
 * Stageflow tools with risk `read`) or declared so by the eval author in `read_only_tools`. Sub-agents and
 * operator-only tools are never read-only.
 */
export function classifyTool(_definition: Grants | undefined, toolId: string, readOnlyExtra: readonly string[] = []): ToolClassification {
  let cls = baseClass(toolId);
  if (cls === "operator_only" || cls === "sub_agent") return { class: cls, readOnly: false };
  const declared = listed(toolId, readOnlyExtra);
  if (declared && cls === "mcp_unknown") cls = "read";
  return { class: cls, readOnly: cls === "read" || declared };
}

export type ToolRiskEntry = { tool: string; class: ToolClass; readOnly: boolean };

/** Every tool the agent is granted with how the `read_only` policy would treat it, for the eval picker. MCP wildcards stay as `<server>.*`. */
export function toolRiskSummary(definition: Grants, readOnlyExtra: readonly string[] = []): ToolRiskEntry[] {
  const ids = new Set(grantedToolIds(definition));
  for (const [server, tools] of Object.entries(definition.tools.mcp)) if (tools.includes("*")) ids.add(`${server}.*`);
  return [...ids].sort().map((tool) => ({ tool, ...classifyTool(definition, tool, readOnlyExtra) }));
}
