import { classifyTool, type ToolClass } from "../../agents/toolRisk.js";
import type { AgentDetail } from "../../agents/service.js";
import { isAgentError } from "../../agents/errors.js";
import { listEvalFiles } from "../../config/evalCatalog.js";
import { manifestForWrite } from "../../config/evalWriteRoots.js";
import { loadEvalOutcome } from "../../config/loadEval.js";
import { agentToolGrants, type AgentCatalogPort, type AgentToolRisk } from "../../config/resolveAgentTarget.js";

export type AgentToolWire = { id: string; risk: AgentToolRisk; class: ToolClass };

export type AgentWire = {
  id: string;
  name: string;
  model: string | null;
  revision: number;
  enabled: boolean;
  archived: boolean;
  tools: AgentToolWire[];
  ask_first: string[];
  issues: string[];
};

export type AgentTargetItem = {
  id: string;
  name: string;
  model: string | null;
  revision: number;
  enabled: boolean;
  tools: AgentToolWire[];
  ask_first: string[];
  evals_count: number;
  issues: string[];
  unavailable_reason: "archived" | "invalid" | null;
};

function toolsOf(detail: AgentDetail): AgentToolWire[] {
  const { definition } = detail;
  if (definition === null) return [];
  return agentToolGrants(definition).map((tool) => ({
    id: tool.id,
    risk: tool.risk,
    class: classifyTool(definition, tool.id).class,
  }));
}

function issueTexts(detail: AgentDetail): string[] {
  return detail.agent.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
}

function toWire(detail: AgentDetail, archived: boolean): AgentWire {
  const { agent, definition } = detail;
  return {
    id: agent.id,
    name: agent.name,
    model: definition?.model.id ?? agent.model?.id ?? null,
    revision: agent.revision,
    enabled: agent.enabled,
    archived,
    tools: toolsOf(detail),
    ask_first: definition?.approvals.ask_first ?? agent.askFirst,
    issues: issueTexts(detail),
  };
}

/** The live agent behind an eval's target, for the editor and warnings; null when it cannot be read. */
export async function liveAgentOf(
  agents: AgentCatalogPort | undefined,
  projectRoot: string,
  agentId: string,
): Promise<AgentWire | null> {
  if (!agents) return null;
  try {
    const detail = await agents.get(projectRoot, agentId);
    const listed = await agents.list(projectRoot);
    return toWire(detail, !listed.some((agent) => agent.id === agentId));
  } catch (err) {
    if (isAgentError(err)) return null;
    throw err;
  }
}

async function agentEvalCounts(projectRoot: string): Promise<{ counts: Map<string, number>; referenced: string[] }> {
  const manifest = await manifestForWrite(projectRoot);
  const counts = new Map<string, number>();
  for (const ref of await listEvalFiles(manifest)) {
    const outcome = await loadEvalOutcome(ref.absPath, projectRoot);
    if (!outcome.ok || outcome.value.file.target.kind !== "agent") continue;
    const id = outcome.value.file.target.agent;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return { counts, referenced: [...counts.keys()] };
}

/**
 * Agents an eval can target. `AgentService.list` hides archived agents, so an archived agent shows up only while an
 * eval still names it (greyed in the picker). Never reads eval sessions.
 */
export async function listAgentTargets(agents: AgentCatalogPort, projectRoot: string): Promise<AgentTargetItem[]> {
  const [listed, { counts, referenced }] = await Promise.all([agents.list(projectRoot), agentEvalCounts(projectRoot)]);
  const items: AgentTargetItem[] = [];
  const seen = new Set<string>();
  const add = async (id: string, archived: boolean): Promise<void> => {
    let detail: AgentDetail;
    try {
      detail = await agents.get(projectRoot, id);
    } catch (err) {
      if (isAgentError(err)) return;
      throw err;
    }
    seen.add(id);
    const wire = toWire(detail, archived);
    items.push({
      id: wire.id,
      name: wire.name,
      model: wire.model,
      revision: wire.revision,
      enabled: wire.enabled,
      tools: wire.tools,
      ask_first: wire.ask_first,
      evals_count: counts.get(id) ?? 0,
      issues: wire.issues,
      unavailable_reason: archived ? "archived" : detail.definition === null || wire.issues.length > 0 ? "invalid" : null,
    });
  };
  for (const agent of listed) await add(agent.id, false);
  for (const id of referenced) {
    if (!seen.has(id)) await add(id, true);
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
