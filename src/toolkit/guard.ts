import type { AgentDefinition } from "../config/loadAgent.js";
import { grantedToolIds, parseAgentDefinition } from "../config/loadAgent.js";
import type { AgentService } from "../agents/service.js";

/** The running agent on whose behalf a toolkit tool is called. Absent for operators (MCP, CLI, console). */
export type ToolCaller = { agentId: string; definition: AgentDefinition };

/**
 * Everything `candidate` would be able to do that `caller` cannot: tool grants
 * (builtin, MCP, Stageflow, sub-agents), skills and the browser. An agent may
 * only hand out what it holds itself.
 */
export function grantsBeyond(caller: AgentDefinition, candidate: AgentDefinition): string[] {
  const held = grantedToolIds(caller);
  const beyond: string[] = [];
  for (const id of grantedToolIds(candidate)) {
    if (held.has(id)) continue;
    const [server, tool] = [id.slice(0, id.indexOf(".")), id.slice(id.indexOf(".") + 1)];
    // A wildcard on the caller's MCP server covers every tool of that server.
    if (id.includes(".") && caller.tools.mcp[server]?.includes("*") && candidate.tools.mcp[server]?.includes(tool)) continue;
    beyond.push(id);
  }
  for (const server of Object.keys(candidate.tools.mcp)) {
    if (candidate.tools.mcp[server]?.includes("*") && !caller.tools.mcp[server]?.includes("*")) beyond.push(`${server}.*`);
  }
  for (const skill of candidate.tools.skills) if (!caller.tools.skills.includes(skill)) beyond.push(`skill ${skill}`);
  if (candidate.tools.browser && !caller.tools.browser) beyond.push("browser");
  return [...new Set(beyond)].sort();
}

/**
 * Tools the caller must ask a person about that the candidate could run without asking.
 * Handing out a tool is not enough to check: the copy must not drop the approval too.
 */
export function approvalsWeakened(caller: AgentDefinition, candidate: AgentDefinition): string[] {
  const held = grantedToolIds(candidate);
  const holds = (id: string) => {
    if (held.has(id)) return true;
    const dot = id.indexOf(".");
    return dot > 0 && candidate.tools.mcp[id.slice(0, dot)]?.includes("*") === true;
  };
  return caller.approvals.ask_first.filter((id) => holds(id) && !candidate.approvals.ask_first.includes(id)).sort();
}

const refusal = (message: string) => ({ ok: false as const, message });

/**
 * Checks that only apply when an agent (not an operator) calls an agent-management tool:
 * no editing itself, no granting what it does not hold, no deciding its own approvals.
 * Returns a refusal message, or null when the call may proceed.
 */
export async function checkAgentCaller(
  tool: string,
  args: Record<string, unknown>,
  caller: ToolCaller,
  service: AgentService | undefined,
  projectRoot: string,
): Promise<{ ok: false; message: string } | null> {
  if (!service) return null;
  const self = caller.agentId;
  const checkDefinition = (candidate: AgentDefinition, what: string) => {
    const beyond = grantsBeyond(caller.definition, candidate);
    if (beyond.length > 0) return refusal(`${what} would grant tools this agent does not hold: ${beyond.join(", ")}.`);
    const weakened = approvalsWeakened(caller.definition, candidate);
    return weakened.length > 0 ? refusal(`${what} would let tools run without asking first that this agent must ask about: ${weakened.join(", ")}.`) : null;
  };
  switch (tool) {
    case "create_agent": {
      const parsed = parseAgentDefinition(args.definition);
      return parsed.ok ? checkDefinition(parsed.value, "That agent") : null;
    }
    case "save_agent": {
      if (args.id === self) return refusal("An agent cannot edit its own definition.");
      const parsed = parseAgentDefinition(args.definition);
      return parsed.ok ? checkDefinition(parsed.value, "That change") : null;
    }
    case "restore_agent_revision": {
      if (args.id === self) return refusal("An agent cannot edit its own definition.");
      if (typeof args.id !== "string" || typeof args.revision !== "number") return null;
      const definition = await service.definitionAt(projectRoot, args.id, args.revision).catch(() => null);
      return definition ? checkDefinition(definition, "That revision") : null;
    }
    case "archive_agent":
      return args.id === self ? refusal("An agent cannot archive itself.") : null;
    case "enable_agent": {
      if (typeof args.id !== "string") return null;
      const detail = await service.get(projectRoot, args.id).catch(() => null);
      return detail?.definition ? checkDefinition(detail.definition, "Enabling that agent") : null;
    }
    case "approve_agent_action":
    case "deny_agent_action": {
      if (typeof args.sessionId !== "string") return null;
      const session = await service.getSession(projectRoot, args.sessionId).catch(() => null);
      return session?.session.agentId === self ? refusal("An agent cannot decide approvals on its own sessions.") : null;
    }
    default:
      return null;
  }
}
