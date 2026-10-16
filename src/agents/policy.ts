import path from "node:path";
import { grantedToolIds, type AgentDefinition } from "../config/loadAgent.js";
import type { ApprovalActor } from "./store.js";

export type { ApprovalActor };

type Grants = Pick<AgentDefinition, "tools" | "sub_agents">;

/** True when the revision grants this tool id (builtin name, `<server>.<tool>`, or `agent:<id>`). */
export function isToolGranted(definition: Grants, tool: string): boolean {
  if (grantedToolIds(definition).has(tool)) return true;
  const dot = tool.indexOf(".");
  if (dot <= 0) return false;
  return definition.tools.mcp[tool.slice(0, dot)]?.includes("*") ?? false;
}

export function requiresAskFirst(definition: Pick<AgentDefinition, "approvals">, tool: string): boolean {
  return definition.approvals.ask_first.includes(tool);
}

export function canApprove(definition: Pick<AgentDefinition, "approvals">, actor: ApprovalActor): boolean {
  const { approvers } = definition.approvals;
  if (actor.kind === "operator") return approvers.operators;
  return approvers.channel_ids.includes(actor.channelId);
}

/** Agent definitions and Stageflow state are never writable by an agent, whatever its grants. */
export function isWritePathForbidden(projectRoot: string, stageflowHome: string, targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const within = (dir: string) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`);
  const root = path.resolve(projectRoot);
  // The project may live under the Stageflow home (container workspace); only outside it is the home off limits.
  if (!within(root) && within(path.resolve(stageflowHome))) return true;
  const relative = path.relative(path.join(root, "agents"), resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.endsWith(".agent.yaml");
  }
  return false;
}

export function trustedLocalNotice(): string {
  return "This agent runs in trusted-local mode on the host filesystem. Use sandbox execution for isolation.";
}
