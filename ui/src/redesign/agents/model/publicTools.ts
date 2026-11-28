import type { AgentDefinition, StageflowToolCatalog } from "../../../api/agents";
import { PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS } from "../../../../../src/agents/publicIdentityOnly.ts";
import { BUILTIN_PERMISSION_GROUPS } from "./permissions";

const BUILTIN_BY_GROUP = new Map(BUILTIN_PERMISSION_GROUPS.map((group) => [group.id, group.tools.map((t) => t.id)]));

/** Stageflow tool names the agent holds (groups expanded with the catalog; without it only individually granted tools). */
function stageflowToolNames(def: AgentDefinition, catalog?: StageflowToolCatalog): string[] {
  const names = new Set(def.tools.stageflow.tools);
  for (const group of def.tools.stageflow.groups) {
    for (const tool of catalog?.groups.find((entry) => entry.id === group)?.tools ?? []) if (!tool.operatorOnly) names.add(tool.name);
  }
  return [...names].sort();
}

/** Tools a visitor on a public link never gets: builtin file/shell tools, the browser, and the Stageflow tools in the shared list. */
export function identityOnlyToolLabels(def: AgentDefinition, catalog?: StageflowToolCatalog): string[] {
  const labels: string[] = [];
  for (const group of def.tools.builtin) {
    for (const tool of BUILTIN_BY_GROUP.get(group) ?? []) labels.push(tool);
  }
  for (const tool of def.tools.builtin_tools) {
    if (!labels.includes(tool)) labels.push(tool);
  }
  if (def.tools.browser) labels.push("browser");
  for (const tool of stageflowToolNames(def, catalog)) if (PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS.has(tool)) labels.push(tool);
  return labels.sort();
}

export function visitorToolLines(def: AgentDefinition): string[] {
  const lines: string[] = [];
  for (const [server, tools] of Object.entries(def.tools.mcp).sort(([a], [b]) => a.localeCompare(b))) {
    const list = tools.includes("*") ? "all tools" : tools.join(", ");
    lines.push(`MCP ${server} (${list}) — visitors use your ${server} connection`);
  }
  for (const group of def.tools.stageflow.groups) lines.push(`Stageflow ${group}`);
  for (const tool of def.tools.stageflow.tools) lines.push(`Stageflow ${tool}`);
  for (const skill of def.tools.skills) lines.push(`skill ${skill}`);
  for (const fn of def.tools.functions ?? []) lines.push(`function ${fn.id}`);
  for (const child of def.sub_agents) lines.push(`sub-agent ${child}`);
  if (def.ui.present) lines.push("present_ui (conversation cards)");
  if (def.project_context) lines.push("project context");
  for (const memory of def.memories ?? []) lines.push(`memory ${memory}`);
  return lines;
}

/**
 * Grant ids worth putting under Ask first for visitors: tools that change things which visitors can actually reach.
 * Ids match what approvals.ask_first accepts (per tool, never a group). Identity-only tools are left out (visitors never
 * get them), and so are MCP servers granted every tool ("*"), which have no per-tool ids to list.
 */
export function sideEffectingGrantIds(def: AgentDefinition, catalog?: StageflowToolCatalog): string[] {
  const ids = new Set<string>();
  for (const [server, tools] of Object.entries(def.tools.mcp)) {
    for (const name of tools) if (name !== "*") ids.add(`${server}.${name}`);
  }
  const risk = new Map(catalog?.groups.flatMap((group) => group.tools.map((tool) => [tool.name, tool.risk] as const)) ?? []);
  for (const tool of stageflowToolNames(def, catalog)) {
    if (PUBLIC_IDENTITY_ONLY_STAGEFLOW_TOOLS.has(tool)) continue;
    if (risk.get(tool) === "read") continue;
    ids.add(tool === "save_artifact" ? "publish_artifact" : `stageflow.${tool}`);
  }
  for (const attachment of def.tools.functions ?? []) ids.add(`function.${attachment.id}`);
  return [...ids].sort();
}

/** MCP servers granted every tool: Ask first needs their tools listed one by one in Approvals. */
export function wildcardMcpServers(def: AgentDefinition): string[] {
  return Object.entries(def.tools.mcp).filter(([, tools]) => tools.includes("*")).map(([server]) => server).sort();
}

export function applyAskFirst(def: AgentDefinition, grantIds: string[]): AgentDefinition {
  const merged = new Set([...def.approvals.ask_first, ...grantIds]);
  return { ...def, approvals: { ...def.approvals, ask_first: [...merged].sort() } };
}