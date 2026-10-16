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

/** Tools that always need a human decision, whatever the agent's `ask_first` list says. */
export const ALWAYS_ASK_FIRST = ["bash"] as const;

/** The tools this agent asks about: its `ask_first` list plus any granted tool that always needs a person. */
export function effectiveAskFirst(definition: Grants & Pick<AgentDefinition, "approvals">): string[] {
  const forced = ALWAYS_ASK_FIRST.filter((tool) => isToolGranted(definition, tool));
  return [...new Set([...definition.approvals.ask_first, ...forced])];
}

export function requiresAskFirst(definition: Pick<AgentDefinition, "approvals">, tool: string): boolean {
  return (ALWAYS_ASK_FIRST as readonly string[]).includes(tool) || definition.approvals.ask_first.includes(tool);
}

export function canApprove(definition: Pick<AgentDefinition, "approvals">, actor: ApprovalActor): boolean {
  const { approvers } = definition.approvals;
  if (actor.kind === "operator") return approvers.operators;
  return approvers.channel_ids.includes(actor.channelId);
}

/**
 * Agent definitions and Stageflow state are never writable by an agent through a tool that names the path, whatever its
 * grants. This does not cover `bash` (see `forbiddenWriteTarget`).
 */
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

const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);
/** Argument names that carry a filesystem path in Pi's builtin tools and in common MCP file tools. */
const PATH_ARGUMENTS = ["path", "file_path", "filePath", "file", "target", "destination", "dest", "output_path"];

/** Every path-like string the runtime can see in a tool call's arguments (including `paths: [...]`). */
export function pathArgumentsOf(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_ARGUMENTS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) found.push(value);
  }
  if (Array.isArray(input.paths)) for (const value of input.paths) if (typeof value === "string" && value.length > 0) found.push(value);
  return found;
}

/**
 * The first forbidden path a tool call would write, or undefined. Applies to every tool that can write a path it is
 * given: `write`, `edit`, and any other tool (an MCP file tool, say) with a path argument. Only Pi's read-only builtins
 * are exempt. This is a check on arguments, not a sandbox: it cannot see what a tool does with them.
 *
 * `bash` is NOT path-confined. The runtime sees a command string, not its effects, so a granted `bash` can modify agent
 * definitions and Stageflow state however this check is configured. Because of that every `bash` call is ask-first
 * (ALWAYS_ASK_FIRST) and a person reads the command before it runs. Do not grant `bash` to an agent you need confined;
 * the editor warns when it is granted (agent.shell_not_path_confined).
 */
export function forbiddenWriteTarget(projectRoot: string, stageflowHome: string, toolName: string, input: Record<string, unknown>): string | undefined {
  if (READ_ONLY_BUILTINS.has(toolName)) return undefined;
  for (const target of pathArgumentsOf(input)) {
    const resolved = path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
    if (isWritePathForbidden(projectRoot, stageflowHome, resolved)) return target;
  }
  return undefined;
}

export function trustedLocalNotice(): string {
  return "This agent runs in trusted-local mode on the host filesystem. Use sandbox execution for isolation.";
}
