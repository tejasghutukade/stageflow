import { grantedToolIds, type AgentDefinition } from "../config/loadAgent.js";
import { ORDER_TOOL_ID } from "../identity/orders.js";
import { ConsumerAccessError } from "../identity/types.js";

export function isConsumerSafeAgent(definition: Pick<AgentDefinition, "model" | "project_context" | "memories" | "tools">): boolean {
  const tools = definition.tools;
  const mcp = Object.entries(tools.mcp);
  const ordersOnly = mcp.length === 0 || (mcp.length === 1 && mcp[0]![0] === "orders" && mcp[0]![1].length === 1 && mcp[0]![1][0] === "status");
  return definition.model.backend === "pi"
    && !definition.project_context
    && (definition.memories?.length ?? 0) === 0
    && tools.skills.length === 0
    && !tools.browser
    && tools.builtin.length === 0
    && tools.builtin_tools.length === 0
    && tools.stageflow.groups.length === 0
    && tools.stageflow.tools.length === 0
    && (tools.functions?.length ?? 0) === 0
    && ordersOnly;
}

/** Direct sub-agents that are themselves consumer-safe, or null when any of them is not. */
export async function loadConsumerSubAgents(
  definition: AgentDefinition,
  load: (id: string) => Promise<AgentDefinition | null>,
): Promise<string[] | null> {
  if (!isConsumerSafeAgent(definition)) return null;
  const seen = new Set<string>([definition.id]);
  const safe: string[] = [];
  for (const childId of definition.sub_agents) {
    if (!(await childIsSafe(childId, load, seen))) return null;
    safe.push(childId);
  }
  return safe;
}

async function childIsSafe(id: string, load: (id: string) => Promise<AgentDefinition | null>, seen: Set<string>): Promise<boolean> {
  if (seen.has(id)) return false;
  seen.add(id);
  let child: AgentDefinition | null;
  try {
    child = await load(id);
  } catch {
    return false;
  }
  if (!child || !isConsumerSafeAgent(child)) return false;
  for (const nested of child.sub_agents) {
    if (!(await childIsSafe(nested, load, seen))) return false;
  }
  return true;
}

export async function assertConsumerWebChatPublication(
  definition: AgentDefinition,
  options: { hasConsumerAuthorization: boolean; loadSubAgent: (id: string) => Promise<AgentDefinition | null> },
): Promise<void> {
  const authenticated = definition.web_chat.access === "authenticated";
  if (!isConsumerSafeAgent(definition) || (definition.sub_agents.length > 0 && !authenticated)) throw new ConsumerAccessError("identity.setup_required");
  const safeSubAgents = definition.sub_agents.length === 0 ? [] : await loadConsumerSubAgents(definition, options.loadSubAgent);
  if (!safeSubAgents) throw new ConsumerAccessError("identity.setup_required");
  const allowed = new Set(["orders.status", ...safeSubAgents.map((id) => `agent:${id}`)]);
  const tools = [...grantedToolIds(definition)];
  if (tools.some((tool) => !authenticated || !allowed.has(tool)) || (authenticated && !options.hasConsumerAuthorization)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
}

export function allowConsumerToolCall(tool: string, subAgentIds: string[]): boolean {
  if (tool.startsWith("agent:")) return subAgentIds.includes(tool.slice("agent:".length));
  return tool === ORDER_TOOL_ID;
}
