import type { AgentDefinition, AgentIssue } from "../../config/loadAgent.js";
import { openToAnyone } from "./allowlist.js";

export const OPEN_CHANNEL_WITH_TOOLS = "agent.channel_open_with_tools";

/** Anything beyond talking: a channel sender gets all of it, with no check of who they are. */
function capabilities(definition: AgentDefinition): string[] {
  const tools = definition.tools;
  const found: string[] = [];
  if (tools.builtin.length > 0 || tools.builtin_tools.length > 0 || Object.keys(tools.mcp).length > 0 || tools.stageflow.groups.length > 0 || tools.stageflow.tools.length > 0 || (tools.functions?.length ?? 0) > 0 || tools.browser) found.push("tools");
  if (tools.skills.length > 0) found.push("skills");
  if ((definition.memories?.length ?? 0) > 0) found.push("memories");
  if (definition.project_context) found.push("project context");
  if (definition.sub_agents.length > 0) found.push("sub-agents");
  return found;
}

/**
 * A channel that anyone can write to must not reach tools, memories or project files: every sender on a channel
 * is trusted alike. Such an agent can be saved but not enabled, and does not answer on its channel.
 */
export function openChannelIssues(definition: AgentDefinition): AgentIssue[] {
  if (!definition.channel || !openToAnyone(definition.channel.allow_from)) return [];
  // An authenticated channel ties each sender to their own account and limits the agent to customer-scoped tools
  // (checked when it is enabled), so it may be open to every customer.
  if (definition.channel.access === "authenticated") return [];
  const has = capabilities(definition);
  if (has.length === 0) return [];
  return [{
    path: "channel.allow_from",
    code: OPEN_CHANNEL_WITH_TOOLS,
    message: `Anyone can message this agent and it has ${has.join(", ")}. List the people or company domains it should answer, or remove its ${has.join(", ")}.`,
  }];
}
