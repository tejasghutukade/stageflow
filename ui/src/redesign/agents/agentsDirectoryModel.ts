import type { AgentSummary } from "../../api/agents";
import { relativeTime } from "./model/format";

export type AgentDirectoryFilter = "all" | "enabled" | "disabled" | "needs_setup";

export type AgentDirectoryRow = {
  id: string;
  name: string;
  description: string;
  model: string;
  modelIsDefault: boolean;
  backend: string;
  toolsLine: string;
  approvalsLine: string;
  approvalsTone: "needs" | "muted";
  statusLabel: string;
  statusTone: "ok" | "needs" | "muted";
  last7Days: string;
  activityLabel: string;
  needsSetup: boolean;
  enabled: boolean;
  pendingApprovals: number;
};

const needsSetup = (agent: AgentSummary) => agent.issues.length > 0;

function toolsLine(agent: AgentSummary): string {
  const parts: string[] = [];
  if (agent.tools.builtin.length > 0) parts.push(agent.tools.builtin.join(" · "));
  if (agent.tools.builtinTools.length > 0) parts.push(agent.tools.builtinTools.join(" · "));
  if (agent.tools.mcpServers.length > 0) parts.push(`${agent.tools.mcpServers.length} MCP`);
  if (agent.tools.skills.length > 0) parts.push(`${agent.tools.skills.length} skill${agent.tools.skills.length === 1 ? "" : "s"}`);
  if (agent.tools.browser) parts.push("browser");
  return parts.length > 0 ? parts.join(" · ") : "No tools";
}

export function toDirectoryRow(agent: AgentSummary, now: number = Date.now()): AgentDirectoryRow {
  const broken = needsSetup(agent);
  const { stats } = agent;
  const last7Days = stats.last7Days === 0 ? "No sessions" : `${stats.last7Days} session${stats.last7Days === 1 ? "" : "s"}`;
  const activityLabel = broken
    ? "Fix config to enable"
    : stats.waiting > 0
      ? `${stats.waiting} waiting`
      : stats.lastActivityAt
        ? relativeTime(stats.lastActivityAt, now)
        : agent.enabled
          ? "Idle"
          : "Never run";
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description ?? "",
    model: agent.model?.id ?? "project default",
    modelIsDefault: !agent.model?.id,
    backend: `v${agent.revision}`,
    toolsLine: toolsLine(agent),
    approvalsLine: broken
      ? (agent.issues[0]?.message ?? "Invalid definition")
      : agent.askFirst.length > 0
        ? `Asks first: ${agent.askFirst.join(", ")}`
        : "No approvals required",
    approvalsTone: broken ? "needs" : "muted",
    statusLabel: broken ? "Needs setup" : agent.enabled ? "Enabled" : "Disabled",
    statusTone: broken ? "needs" : agent.enabled ? "ok" : "muted",
    last7Days,
    activityLabel,
    needsSetup: broken,
    enabled: agent.enabled,
    pendingApprovals: agent.pendingApprovals,
  };
}

export function filterAgents(agents: readonly AgentSummary[], filter: AgentDirectoryFilter): AgentSummary[] {
  switch (filter) {
    case "enabled":
      return agents.filter((agent) => agent.enabled && !needsSetup(agent));
    case "disabled":
      return agents.filter((agent) => !agent.enabled && !needsSetup(agent));
    case "needs_setup":
      return agents.filter(needsSetup);
    default:
      return [...agents];
  }
}

export function searchAgents(agents: readonly AgentSummary[], query: string): AgentSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...agents];
  return agents.filter((agent) => {
    const row = toDirectoryRow(agent);
    return [agent.name, agent.id, row.description, row.model, row.backend, row.toolsLine, row.approvalsLine]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

export function filterCounts(agents: readonly AgentSummary[]): Record<AgentDirectoryFilter, number> {
  return {
    all: agents.length,
    enabled: filterAgents(agents, "enabled").length,
    disabled: filterAgents(agents, "disabled").length,
    needs_setup: filterAgents(agents, "needs_setup").length,
  };
}

export function directoryFooterText(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) return "No agents yet";
  const counts = filterCounts(agents);
  const parts = [`${agents.length} agent${agents.length === 1 ? "" : "s"} in agents/`, `${counts.enabled} enabled`];
  if (counts.needs_setup > 0) parts.push(`${counts.needs_setup} needs setup`);
  return parts.join(" · ");
}
