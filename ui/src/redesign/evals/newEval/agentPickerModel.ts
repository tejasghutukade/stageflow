import type { EvalAgentTarget, EvalAgentTool } from "../../../api/evalTypes";

export type RiskKey = "read" | "write" | "shell" | "external" | "mcp_unknown" | "sub_agent";
export type RiskBadge = { key: RiskKey; label: string; count: number; tone: "ok" | "needs" | "fail" | "running" | "unknown" | "neutral" };

const RISK_ORDER: Array<{ key: RiskKey; label: string; tone: RiskBadge["tone"] }> = [
  { key: "read", label: "Read", tone: "ok" },
  { key: "write", label: "Write", tone: "needs" },
  { key: "shell", label: "Shell", tone: "fail" },
  { key: "external", label: "External", tone: "running" },
  { key: "mcp_unknown", label: "Unknown MCP", tone: "unknown" },
  { key: "sub_agent", label: "Sub-agent", tone: "neutral" },
];

function bucket(tool: EvalAgentTool): RiskKey | null {
  switch (tool.class) {
    case "read":
      return "read";
    case "write":
    case "destructive":
      return "write";
    case "shell":
      return "shell";
    case "external":
    case "browser":
      return "external";
    case "mcp_unknown":
      return "mcp_unknown";
    case "sub_agent":
      return "sub_agent";
    default:
      return null;
  }
}

/** Counts of tools per class, in the picker's fixed order; classes the agent has none of are left out. */
export function riskBadges(tools: readonly EvalAgentTool[]): RiskBadge[] {
  const counts = new Map<RiskKey, number>();
  for (const tool of tools) {
    const key = bucket(tool);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return RISK_ORDER.filter((r) => counts.has(r.key)).map((r) => ({ ...r, count: counts.get(r.key) ?? 0 }));
}

export function askFirstLine(askFirst: readonly string[]): string | null {
  return askFirst.length === 0 ? null : `asks first: ${askFirst.join(", ")}`;
}

export function toolSummary(tools: readonly EvalAgentTool[]): string {
  if (tools.length === 0) return "No tools";
  return `${tools.length} ${tools.length === 1 ? "tool" : "tools"}: ${riskBadges(tools).map((b) => `${b.count} ${b.label.toLowerCase()}`).join(", ")}`;
}

export function filterAgents(items: readonly EvalAgentTarget[], query: string): EvalAgentTarget[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((a) => `${a.id} ${a.name} ${a.model ?? ""}`.toLowerCase().includes(q));
}

export type AgentRowState = "ok" | "disabled" | "archived" | "invalid";

export type AgentRowView = {
  id: string;
  name: string;
  model: string;
  revision: string;
  badges: RiskBadge[];
  askFirst: string | null;
  evalsText: string;
  state: AgentRowState;
  /** Archived and invalid agents cannot be picked. */
  selectable: boolean;
  chip: string | null;
  title: string | null;
};

export const DISABLED_CHIP = "Disabled: evals bypass this";

export function agentRowView(a: EvalAgentTarget): AgentRowView {
  const state: AgentRowState = a.unavailable_reason === "archived" ? "archived" : a.unavailable_reason === "invalid" ? "invalid" : a.enabled ? "ok" : "disabled";
  return {
    id: a.id,
    name: a.name,
    model: a.model ?? "",
    revision: `r${a.revision}`,
    badges: riskBadges(a.tools),
    askFirst: askFirstLine(a.ask_first),
    evalsText: `${a.evals_count} ${a.evals_count === 1 ? "eval" : "evals"}`,
    state,
    selectable: state === "ok" || state === "disabled",
    chip: state === "archived" ? "Archived" : state === "invalid" ? "Needs fixing" : state === "disabled" ? DISABLED_CHIP : null,
    title: state === "archived" ? "Archived agents cannot be evaluated." : state === "invalid" ? (a.issues[0] ?? "The agent definition has issues.") : null,
  };
}

export type PickerNotice = { tone: "muted" | "error"; text: string };

export function pickerNotice(opts: { loading: boolean; error: string | null; items: readonly EvalAgentTarget[]; shown: readonly EvalAgentTarget[] }): PickerNotice | null {
  if (opts.loading) return { tone: "muted", text: "Loading agents…" };
  if (opts.error) return { tone: "error", text: `Agents could not be loaded. ${opts.error}` };
  if (opts.items.length === 0) return { tone: "muted", text: "No agents yet. Create one under Agents, then evaluate it here." };
  if (opts.items.every((a) => a.unavailable_reason === "archived")) return { tone: "muted", text: "All agents are archived. Restore one to evaluate it." };
  if (opts.shown.length === 0) return { tone: "muted", text: "No agents match." };
  return null;
}

export function findAgent(items: readonly EvalAgentTarget[], id: string | undefined): EvalAgentTarget | null {
  if (!id) return null;
  const hit = items.find((a) => a.id === id);
  return hit && agentRowView(hit).selectable ? hit : null;
}
