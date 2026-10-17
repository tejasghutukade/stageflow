import type { AgentDefinition } from "../config/loadAgent.js";
import { AgentError } from "./errors.js";

/** May `caller` (at nesting `depth`, 0 = top-level session) call `calleeId`? Throws when it may not. */
export function assertDelegateAllowed(
  caller: Pick<AgentDefinition, "sub_agents" | "sub_agent_depth">,
  calleeId: string,
  depth: number,
): void {
  if (!caller.sub_agents.includes(calleeId)) throw new AgentError("agent.delegate_not_allowed");
  if (depth >= caller.sub_agent_depth) throw new AgentError("agent.delegate_depth_exceeded");
}
