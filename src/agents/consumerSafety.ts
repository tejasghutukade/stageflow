import {
  grantedBuiltinTools,
  grantedToolIds,
  type AgentDefinition,
  type AgentIssue,
} from "../config/loadAgent.js";
import { consumerResourceToolIds } from "../identity/resourceContract.js";
import { ConsumerStepUpRequired } from "../identity/stepUp.js";
import { ConsumerAccessError } from "../identity/types.js";
import { grantedStageflowTools, isOperatorOnlyTool, stageflowGrantId } from "../toolkit/meta.js";
import { PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS } from "./publicIdentityOnly.js";

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

const BROWSER_GRANT = "browser";

/** Stageflow tools withheld from anonymous visitors (operator-only ones, and PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS). */
function isIdentityOnlyStageflowTool(tool: string): boolean {
  return isOperatorOnlyTool(tool) || PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS.has(tool);
}

/**
 * Tools never given to an anonymous visitor on a public link: builtin file and shell tools and the browser (they act on
 * the owner's machine and logins) and the Stageflow tools that run code, change the Host's setup or reach other
 * agents' conversations.
 */
export function identityOnlyGrantIds(definition: Pick<AgentDefinition, "tools">): string[] {
  const found = new Set<string>(grantedBuiltinTools(definition));
  if (definition.tools.browser) found.add(BROWSER_GRANT);
  for (const tool of grantedStageflowTools(definition.tools.stageflow)) {
    if (isIdentityOnlyStageflowTool(tool)) found.add(stageflowGrantId(tool));
  }
  return [...found].sort();
}

export function agentHasIdentityOnlyTools(definition: Pick<AgentDefinition, "tools">): boolean {
  return identityOnlyGrantIds(definition).length > 0;
}

export function isIdentityOnlyGrantId(definition: Pick<AgentDefinition, "tools">, grantId: string): boolean {
  return identityOnlyGrantIds(definition).includes(grantId);
}

function hasNonPresentTools(definition: AgentDefinition): boolean {
  const tools = definition.tools;
  if (tools.builtin.length > 0 || tools.builtin_tools.length > 0 || Object.keys(tools.mcp).length > 0 || tools.stageflow.groups.length > 0
    || tools.stageflow.tools.length > 0 || (tools.functions?.length ?? 0) > 0 || tools.browser) return true;
  if (tools.skills.length > 0) return true;
  if ((definition.memories?.length ?? 0) > 0) return true;
  if (definition.project_context) return true;
  if (definition.sub_agents.length > 0) return true;
  if (definition.ui.present && definition.ui.persistence === "artifacts") return true;
  return false;
}

/** Non-blocking note on the agent summary: what anonymous visitors can do today. */
export function publicChatVisitorNote(definition: AgentDefinition): string | null {
  if (!definition.web_chat.enabled || definition.web_chat.access === "authenticated") return null;
  if (definition.web_chat.public_tools) return null;
  if (!hasNonPresentTools(definition)) return null;
  return "Visitors can chat but can't use this agent's tools. Turn on \"Visitors can use tools\" to allow them.";
}

export const PUBLIC_TOOLS_IDENTITY_ONLY = "agent.public_tools_identity_only";

function identityToolsIssue(tools: string[], extra?: { subAgentId?: string }): AgentIssue {
  const list = tools.join(", ");
  const message = extra?.subAgentId
    ? `Visitors on the public link won't get sub-agent ${extra.subAgentId}: it has ${list}, which act on your computer or the Host, or reach other conversations. It keeps working in the console and on a signed-in link (web_chat.access: authenticated).`
    : `Visitors on the public link won't get ${list}: these act on your computer or the Host, or reach other conversations. They keep working in the console and on a signed-in link (web_chat.access: authenticated).`;
  return { path: "web_chat.public_tools", code: PUBLIC_TOOLS_IDENTITY_ONLY, message };
}

export function publicToolsIdentityIssue(definition: AgentDefinition): AgentIssue | null {
  if (!definition.web_chat.enabled || definition.web_chat.access !== "public" || !definition.web_chat.public_tools) return null;
  const identity = identityOnlyGrantIds(definition);
  if (identity.length === 0) return null;
  return identityToolsIssue(identity);
}

export async function publicToolsIdentityIssues(
  definition: AgentDefinition,
  loadSubAgent: (id: string) => Promise<AgentDefinition | null>,
): Promise<AgentIssue[]> {
  if (!definition.web_chat.enabled || definition.web_chat.access !== "public" || !definition.web_chat.public_tools) return [];
  const issues: AgentIssue[] = [];
  const direct = publicToolsIdentityIssue(definition);
  if (direct) issues.push(direct);
  for (const childId of definition.sub_agents) {
    const issue = await publicToolsIdentityInTree(childId, loadSubAgent, new Set<string>([definition.id]));
    if (issue) issues.push(issue);
  }
  return issues;
}

async function publicToolsIdentityInTree(
  id: string,
  load: (id: string) => Promise<AgentDefinition | null>,
  seen: Set<string>,
): Promise<AgentIssue | null> {
  if (seen.has(id)) return null;
  seen.add(id);
  let child: AgentDefinition | null;
  try {
    child = await load(id);
  } catch {
    return null;
  }
  if (!child) return null;
  if (agentHasIdentityOnlyTools(child)) return identityToolsIssue(identityOnlyGrantIds(child), { subAgentId: id });
  for (const nested of child.sub_agents) {
    const nestedIssue = await publicToolsIdentityInTree(nested, load, seen);
    if (nestedIssue) return nestedIssue;
  }
  return null;
}

/** Sub-agents an anonymous visitor may call when public_tools is on (no identity-only tools in the tree). */
export async function loadAnonymousPublicSubAgents(
  definition: AgentDefinition,
  load: (id: string) => Promise<AgentDefinition | null>,
): Promise<string[]> {
  const safe: string[] = [];
  for (const childId of definition.sub_agents) {
    // Each child gets its own walk, so one shared grandchild does not hide a sibling.
    if (await childAllowsAnonymousPublic(childId, load, new Set<string>([definition.id]))) safe.push(childId);
  }
  return safe;
}

async function childAllowsAnonymousPublic(
  id: string,
  load: (id: string) => Promise<AgentDefinition | null>,
  seen: Set<string>,
): Promise<boolean> {
  if (seen.has(id)) return false;
  seen.add(id);
  let child: AgentDefinition | null;
  try {
    child = await load(id);
  } catch {
    return false;
  }
  if (!child || agentHasIdentityOnlyTools(child)) return false;
  for (const nested of child.sub_agents) {
    if (!(await childAllowsAnonymousPublic(nested, load, seen))) return false;
  }
  return true;
}

async function assertConsumerPublication(
  definition: AgentDefinition,
  authenticated: boolean,
  options: { hasConsumerAuthorization: boolean; loadSubAgent: (id: string) => Promise<AgentDefinition | null> },
): Promise<void> {
  if (!authenticated) return;
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

/** Strips identity-only builtins and browser from a copy used to build an anonymous public tool surface. */
export function stripIdentityToolsFromDefinition(definition: AgentDefinition): AgentDefinition {
  const stageflow = grantedStageflowTools(definition.tools.stageflow).filter((tool) => !isIdentityOnlyStageflowTool(tool));
  return {
    ...definition,
    tools: {
      ...definition.tools,
      builtin: [],
      builtin_tools: [],
      browser: false,
      stageflow: { groups: [], tools: stageflow },
    },
  };
}