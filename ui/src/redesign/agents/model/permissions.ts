import type { BuiltinToolGroup, StageflowToolCatalog } from "../../../api/agents";

/**
 * Grants as the YAML stores them: whole groups plus single tools. The editor
 * shows one tree; these helpers keep the stored form compact (a fully ticked
 * group is stored as the group, a partly ticked one as single tools).
 */

export type Grants = { groups: string[]; tools: string[] };

export type PermissionRisk = "read" | "write" | "destructive" | "external";

export type PermissionTool = { id: string; label: string; description: string; risk: PermissionRisk };

export type PermissionGroup = { id: string; title: string; summary: string; tools: PermissionTool[] };

export type GroupState = "all" | "some" | "none";

const uniq = (list: string[]) => [...new Set(list)];

export function toolGranted(grants: Grants, group: PermissionGroup, toolId: string): boolean {
  return grants.groups.includes(group.id) || grants.tools.includes(toolId);
}

export function groupState(grants: Grants, group: PermissionGroup): GroupState {
  if (grants.groups.includes(group.id)) return "all";
  const count = group.tools.filter((tool) => grants.tools.includes(tool.id)).length;
  return count === 0 ? "none" : count === group.tools.length ? "all" : "some";
}

/** Tick or clear a whole group: every child follows. */
export function setGroup(grants: Grants, group: PermissionGroup, on: boolean): Grants {
  const children = new Set(group.tools.map((tool) => tool.id));
  const tools = grants.tools.filter((id) => !children.has(id));
  return on
    ? { groups: uniq([...grants.groups, group.id]), tools }
    : { groups: grants.groups.filter((id) => id !== group.id), tools };
}

/** Tick or clear one child; a group that becomes full collapses to the group id, one that loses a child expands to single tools. */
export function setTool(grants: Grants, group: PermissionGroup, toolId: string, on: boolean): Grants {
  const children = group.tools.map((tool) => tool.id);
  const current = new Set(children.filter((id) => toolGranted(grants, group, id)));
  if (on) current.add(toolId);
  else current.delete(toolId);
  const others = grants.tools.filter((id) => !children.includes(id));
  const groups = grants.groups.filter((id) => id !== group.id);
  if (current.size === children.length) return { groups: [...groups, group.id], tools: others };
  return { groups, tools: [...others, ...children.filter((id) => current.has(id))] };
}

/** Every tool id a set of grants covers for the given groups. */
export function grantedToolIds(grants: Grants, groups: PermissionGroup[]): string[] {
  return groups.flatMap((group) => group.tools.filter((tool) => toolGranted(grants, group, tool.id)).map((tool) => tool.id));
}

export const BUILTIN_PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "read",
    title: "Read project files",
    summary: "Look at files in the project. Cannot change anything.",
    tools: [
      { id: "read", label: "read", description: "Read a file", risk: "read" },
      { id: "grep", label: "grep", description: "Search file contents", risk: "read" },
      { id: "find", label: "find", description: "Find files by name", risk: "read" },
      { id: "ls", label: "ls", description: "List a directory", risk: "read" },
    ],
  },
  {
    id: "write",
    title: "Write and edit files",
    summary: "Change project files. Writes stay inside the project root; agent definitions and Stageflow state are never writable.",
    tools: [
      { id: "write", label: "write", description: "Create or overwrite a file", risk: "write" },
      { id: "edit", label: "edit", description: "Change part of a file", risk: "write" },
    ],
  },
  {
    id: "shell",
    title: "Run shell commands",
    summary: "Run commands on this machine.",
    tools: [{ id: "bash", label: "bash", description: "Run a shell command", risk: "destructive" }],
  },
];

export const BUILTIN_GROUP_IDS = BUILTIN_PERMISSION_GROUPS.map((group) => group.id) as BuiltinToolGroup[];

export function stageflowPermissionGroups(catalog: StageflowToolCatalog): PermissionGroup[] {
  return catalog.groups.map((group) => ({
    id: group.id,
    title: group.title,
    summary: group.summary,
    tools: group.tools.map((tool) => ({ id: tool.name, label: tool.name, description: tool.description, risk: tool.risk })),
  }));
}
