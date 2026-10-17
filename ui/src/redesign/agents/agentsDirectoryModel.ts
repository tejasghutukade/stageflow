import type { AgentSummary } from "../../api/agents";
import { webChatLink } from "./model/definition";
import { formatCost, relativeTime } from "./model/format";

export type AgentDirectoryFilter = "all" | "enabled" | "disabled" | "needs_setup";

export type ReachItem = {
  kind: "web" | "channel" | "schedule" | "console";
  label: string;
  detail?: string;
  /** Absolute chat link for web chat. */
  href?: string;
  /** The agent is disabled, so the item does not answer yet. */
  idle: boolean;
};

export type AgentDirectoryRow = {
  /** Approvals beyond the ones named in `approvalsLine`. */
  approvalsMore: number;
  /** Everything the agent can use and must ask about, for the "all tools" dialog. */
  access: { builtin: string[]; mcpServers: string[]; skills: string[]; browser: boolean; askFirst: string[] };
  reach: ReachItem[];
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
  statusNote: string;
  statusTone: "ok" | "needs" | "muted";
  last7Days: string;
  costLabel: string;
  activityLabel: string;
  needsSetup: boolean;
  enabled: boolean;
  pendingApprovals: number;
};

const APPROVALS_SHOWN = 2;

const needsSetup = (agent: AgentSummary) => agent.issues.length > 0;

function toolsLine(agent: AgentSummary): string {
  const parts: string[] = [];
  const builtin = [...agent.tools.builtin, ...agent.tools.builtinTools];
  if (builtin.length > 0) parts.push(builtin.slice(0, 3).join(" · ") + (builtin.length > 3 ? ` +${builtin.length - 3}` : ""));
  if (agent.tools.mcpServers.length > 0) parts.push(`${agent.tools.mcpServers.length} MCP`);
  if (agent.tools.skills.length > 0) parts.push(`${agent.tools.skills.length} skill${agent.tools.skills.length === 1 ? "" : "s"}`);
  if (agent.tools.browser) parts.push("browser");
  return parts.length > 0 ? parts.join(" · ") : "No tools";
}

/** How people or systems reach the agent: chat page, channel connection, schedule; console only otherwise. */
export function reachItems(agent: AgentSummary, providerOfConnection: (connectionId: string) => string | undefined): ReachItem[] {
  const idle = !agent.enabled;
  const items: ReachItem[] = [];
  const href = webChatLink(agent);
  if (href) items.push({ kind: "web", label: "Web chat", detail: agent.webChatUrl ?? undefined, href, idle });
  if (agent.channelConnection) {
    items.push({ kind: "channel", label: providerOfConnection(agent.channelConnection) ?? "Channel", detail: agent.channelConnection, idle });
  }
  if (agent.scheduleCron) items.push({ kind: "schedule", label: "Schedule", detail: agent.scheduleCron, idle });
  if (items.length === 0) items.push({ kind: "console", label: "Console only", idle });
  return items;
}

export function toDirectoryRow(
  agent: AgentSummary,
  now: number = Date.now(),
  providerOfConnection: (connectionId: string) => string | undefined = () => undefined,
): AgentDirectoryRow {
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
    reach: reachItems(agent, providerOfConnection),
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
        ? `Asks first: ${agent.askFirst.slice(0, APPROVALS_SHOWN).join(", ")}`
        : "No approvals required",
    approvalsMore: broken ? 0 : Math.max(0, agent.askFirst.length - APPROVALS_SHOWN),
    access: {
      builtin: [...agent.tools.builtin, ...agent.tools.builtinTools],
      mcpServers: agent.tools.mcpServers,
      skills: agent.tools.skills,
      browser: agent.tools.browser,
      askFirst: agent.askFirst,
    },
    approvalsTone: broken ? "needs" : "muted",
    statusLabel: broken ? "Needs setup" : agent.enabled ? "Enabled" : "Disabled",
    statusNote: broken ? "Not running" : agent.enabled ? "Accepting work" : "Paused",
    statusTone: broken ? "needs" : agent.enabled ? "ok" : "muted",
    last7Days,
    costLabel: formatCost(stats.costTotal),
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

export function searchAgents(agents: readonly AgentSummary[], query: string, providerOfConnection?: (connectionId: string) => string | undefined): AgentSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...agents];
  return agents.filter((agent) => {
    const row = toDirectoryRow(agent, Date.now(), providerOfConnection);
    return [agent.name, agent.id, row.description, row.model, row.backend, row.toolsLine, row.approvalsLine, ...row.reach.map((item) => `${item.label} ${item.detail ?? ""}`)]
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

/** Explains why an agent can't be enabled, and what disabled means; null when there is nothing to say. */
export function directoryHint(agents: readonly AgentSummary[]): string | null {
  const parts: string[] = [];
  for (const agent of agents.filter((a) => a.issues.length > 0)) {
    parts.push(`${agent.name} can't be enabled until ${agent.issues[0]!.message}.`);
  }
  if (agents.some((agent) => !agent.enabled)) {
    parts.push("Disabled agents keep their history but can't start sessions.");
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function directoryFooterText(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) return "No agents yet";
  const counts = filterCounts(agents);
  const parts = [`${agents.length} agent${agents.length === 1 ? "" : "s"} in agents/`, `${counts.enabled} enabled`];
  if (counts.needs_setup > 0) parts.push(`${counts.needs_setup} needs setup`);
  return parts.join(" · ");
}

/** Spend and session totals across every listed agent, all time. */
export function directoryTotals(agents: readonly AgentSummary[]): { sessions: number; cost: string } {
  let cost: number | null = null;
  let sessions = 0;
  for (const agent of agents) {
    sessions += agent.stats.total;
    if (agent.stats.costTotal !== null) cost = (cost ?? 0) + agent.stats.costTotal;
  }
  return { sessions, cost: formatCost(cost) };
}
