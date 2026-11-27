import { grantedToolIds, type AgentDefinition } from "../config/loadAgent.js";
import type { AgentIssue } from "../config/loadAgent.js";
import { consumerResourceToolIds } from "../identity/resourceContract.js";
import { ConsumerStepUpRequired } from "../identity/stepUp.js";
import { ConsumerAccessError } from "../identity/types.js";

export const CHANNEL_CONSUMER_SOURCES = new Set(["imessage", "telegram", "agentmail", "email", "slack"]);

type ChannelTurnAuth = {
  validateConversation(conversation: string, sessionId: string, agentId: string, revision?: number): Promise<void>;
};

export type ChannelTurnDecision =
  | { status: "skip" }
  | { status: "ok" }
  | { status: "refused" }
  | { status: "step_up"; reply: string };

export function isAuthenticatedChannelSource(
  source: string,
  definition: Pick<AgentDefinition, "channel"> | null | undefined,
): boolean {
  return Boolean(definition?.channel?.access === "authenticated" && CHANNEL_CONSUMER_SOURCES.has(source));
}

export function isChannelConsumerTurn(
  source: string,
  definition: Pick<AgentDefinition, "channel">,
  consumerSessionId?: string,
): boolean {
  return isAuthenticatedChannelSource(source, definition)
    && consumerSessionId !== undefined
    && consumerSessionId.length > 0;
}

export async function requireChannelConsumerTurn(
  auth: ChannelTurnAuth | undefined,
  input: {
    source: string;
    definition: Pick<AgentDefinition, "channel"> | null | undefined;
    consumerSessionId: string | undefined;
    conversationId: string;
    agentId: string;
    revision?: number;
  },
): Promise<ChannelTurnDecision> {
  if (!isChannelConsumerTurn(input.source, input.definition ?? {}, input.consumerSessionId)) return { status: "skip" };
  if (!input.consumerSessionId || !auth) return { status: "refused" };
  try {
    await auth.validateConversation(input.conversationId, input.consumerSessionId, input.agentId, input.revision);
    return { status: "ok" };
  } catch (error) {
    if (error instanceof ConsumerStepUpRequired) return { status: "step_up", reply: error.reply };
    throw error;
  }
}

export function isConsumerSafeAgent(definition: Pick<AgentDefinition, "model" | "project_context" | "memories" | "tools">): boolean {
  const tools = definition.tools;
  const allowed = consumerResourceToolIds();
  for (const [server, entries] of Object.entries(tools.mcp)) {
    for (const tool of entries) {
      if (!allowed.has(`${server}.${tool}`)) return false;
    }
  }
  return definition.model.backend === "pi"
    && !definition.project_context
    && (definition.memories?.length ?? 0) === 0
    && tools.skills.length === 0
    && !tools.browser
    && tools.builtin.length === 0
    && tools.builtin_tools.length === 0
    && tools.stageflow.groups.length === 0
    && tools.stageflow.tools.length === 0
    && (tools.functions?.length ?? 0) === 0;
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

/**
 * What stops an agent from answering anyone with its public chat link. Visitors there are anonymous, so the agent
 * may only talk and draw cards kept in the conversation. Empty when the link can open.
 */
export function publicChatBlockers(definition: AgentDefinition): string[] {
  const tools = definition.tools;
  const found: string[] = [];
  if (tools.builtin.length > 0 || tools.builtin_tools.length > 0 || Object.keys(tools.mcp).length > 0 || tools.stageflow.groups.length > 0
    || tools.stageflow.tools.length > 0 || (tools.functions?.length ?? 0) > 0 || tools.browser) found.push("tools");
  if (tools.skills.length > 0) found.push("skills");
  if ((definition.memories?.length ?? 0) > 0) found.push("memories");
  if (definition.project_context) found.push("project context");
  if (definition.sub_agents.length > 0) found.push("sub-agents");
  if (definition.ui.present && definition.ui.persistence === "artifacts") found.push("cards saved as artifacts");
  if (definition.model.backend !== "pi") found.push(`the ${definition.model.backend} backend`);
  return found;
}

export const PUBLIC_CHAT_BLOCKED = "agent.web_chat_needs_setup";

/** Explains, on the agent, why its public chat link does not open. */
export function publicChatIssues(definition: AgentDefinition): AgentIssue[] {
  if (!definition.web_chat.enabled || definition.web_chat.access === "authenticated") return [];
  const blockers = publicChatBlockers(definition);
  if (blockers.length === 0) return [];
  const list = blockers.join(", ");
  return [{
    path: "web_chat",
    code: PUBLIC_CHAT_BLOCKED,
    message: `The public chat link will not open: anyone with it could use this agent's ${list}. Remove the ${list} to let anyone chat, or keep it to the console. Cards kept in the conversation are allowed.`,
  }];
}

async function assertConsumerPublication(
  definition: AgentDefinition,
  authenticated: boolean,
  options: { hasConsumerAuthorization: boolean; loadSubAgent: (id: string) => Promise<AgentDefinition | null> },
): Promise<void> {
  if (!authenticated) {
    if (publicChatBlockers(definition).length > 0) throw new ConsumerAccessError("identity.setup_required");
    return;
  }
  if (!isConsumerSafeAgent(definition) || (definition.sub_agents.length > 0 && !authenticated)) throw new ConsumerAccessError("identity.setup_required");
  const safeSubAgents = definition.sub_agents.length === 0 ? [] : await loadConsumerSubAgents(definition, options.loadSubAgent);
  if (!safeSubAgents) throw new ConsumerAccessError("identity.setup_required");
  const allowed = new Set([...consumerResourceToolIds(), ...safeSubAgents.map((id) => `agent:${id}`)]);
  if (definition.ui.present) allowed.add("present_ui");
  const tools = [...grantedToolIds(definition)];
  if (tools.some((tool) => !authenticated || !allowed.has(tool)) || (authenticated && !options.hasConsumerAuthorization)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
}

export async function assertConsumerWebChatPublication(
  definition: AgentDefinition,
  options: { hasConsumerAuthorization: boolean; loadSubAgent: (id: string) => Promise<AgentDefinition | null> },
): Promise<void> {
  await assertConsumerPublication(definition, definition.web_chat.access === "authenticated", options);
}

export async function assertConsumerChannelPublication(
  definition: AgentDefinition,
  options: {
    hasConsumerAuthorization: boolean;
    hasChannelConnection: (agentId: string, channelConnectionId: string) => boolean;
    loadSubAgent: (id: string) => Promise<AgentDefinition | null>;
  },
): Promise<void> {
  const authenticated = definition.channel?.access === "authenticated";
  if (!authenticated) return;
  if (!definition.channel?.connection_id || !options.hasChannelConnection(definition.id, definition.channel.connection_id)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  await assertConsumerPublication(definition, true, options);
}

export async function consumerChannelIssues(
  definition: AgentDefinition,
  options: {
    hasConsumerAuthorization: boolean;
    hasChannelConnection: (agentId: string, channelConnectionId: string) => boolean;
    loadSubAgent: (id: string) => Promise<AgentDefinition | null>;
  },
): Promise<AgentIssue[]> {
  if (definition.channel?.access !== "authenticated") return [];
  try {
    await assertConsumerChannelPublication(definition, options);
    return [];
  } catch {
    return [{ path: "channel.access", code: "identity.setup_required", message: "Protected channel needs identity, a channel connection, and only declared customer resource tools" }];
  }
}

export function allowConsumerToolCall(tool: string, subAgentIds: string[]): boolean {
  if (tool.startsWith("agent:")) return subAgentIds.includes(tool.slice("agent:".length));
  return consumerResourceToolIds().has(tool);
}