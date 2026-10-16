import type { AgentDefinition, AgentIssue, AgentSummary, BuiltinToolGroup, StageflowToolCatalog, WebChatConfig } from "../../../api/agents";

/**
 * Client model of the v2 agent definition: defaults, edits, change
 * detection, and the derived tables the editor renders. Defaults must match
 * src/config/loadAgent.ts (tests/agents.uiDefaults.test.ts enforces it).
 */

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function defaultDefinition(): AgentDefinition {
  return {
    id: "",
    name: "",
    enabled: false,
    instructions: "",
    project_context: false,
    execution: "trusted-local",
    model: { backend: "pi", thinking: "medium" },
    tools: { builtin: [], mcp: {}, skills: [], browser: false, stageflow: { groups: [], tools: [] } },
    approvals: {
      ask_first: [],
      approvers: { operators: true, channel_ids: [] },
      timeout_minutes: 30,
      on_timeout: "skip",
    },
    sub_agents: [],
    sub_agent_depth: 1,
    guardrails: { block_patterns: [] },
    evals: { groundedness: false },
    observability: { capture: "metadata", otlp: false },
    channels: [],
    web_chat: { ...DEFAULT_WEB_CHAT },
    limits: { session_minutes: 10, max_turns: 40, cost_usd: null, long_context: "summarize" },
  };
}

/** Schema defaults of `web_chat`: off, no slug (the server picks one on save). */
export const DEFAULT_WEB_CHAT: WebChatConfig = { enabled: false, rate_limit_per_minute: 10, max_message_chars: 4000 };

/** Starting point of the create flow: like the schema defaults, but web chat is on for new agents. */
export function newAgentDefinition(): AgentDefinition {
  return { ...defaultDefinition(), web_chat: { ...DEFAULT_WEB_CHAT, enabled: true } };
}

/** Fill a partial (e.g. author-drafted) definition with the create-flow defaults, section by section. */
export function completeDefinition(partial: Record<string, unknown>): AgentDefinition {
  const base = newAgentDefinition() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(partial)) {
    const fallback = base[key];
    out[key] =
      value !== null && typeof value === "object" && !Array.isArray(value) && fallback && typeof fallback === "object"
        ? { ...(fallback as object), ...(value as object) }
        : value;
  }
  return out as unknown as AgentDefinition;
}

export function slugAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
  return AGENT_ID_PATTERN.test(slug) ? slug : "";
}

export const BUILTIN_GROUPS: Array<{ id: BuiltinToolGroup; title: string; tools: string[]; effect: string }> = [
  { id: "read", title: "Read project files", tools: ["read", "grep", "find", "ls"], effect: "Reads project files" },
  { id: "write", title: "Write and edit files", tools: ["write", "edit"], effect: "Changes project files" },
  { id: "shell", title: "Run shell commands", tools: ["bash"], effect: "Runs commands on this machine" },
];

let stageflowCatalog: StageflowToolCatalog | null = null;

/** The server's Stageflow tool groups, set once by the editor options hook and read by the approvals table. */
export function setStageflowCatalog(catalog: StageflowToolCatalog | null): void {
  stageflowCatalog = catalog;
}

export function getStageflowCatalog(): StageflowToolCatalog | null {
  return stageflowCatalog;
}

const RISK_EFFECT = {
  read: "Reads Stageflow state",
  write: "Changes Stageflow state",
  destructive: "Deletes or cancels things",
  external: "Reaches outside Stageflow",
} as const;

/** Grant ids a toggled group or tool adds that should ask first by default: everything that is not read-only. */
export function riskyGrantIds(catalog: StageflowToolCatalog, groupId: string, only?: string): string[] {
  const group = catalog.groups.find((g) => g.id === groupId);
  return (group?.tools ?? []).filter((tool) => tool.risk !== "read" && (only === undefined || tool.name === only)).map((tool) => tool.grantId);
}

export type ApprovalRow = {
  /** The tool id stored in approvals.ask_first. */
  tool: string;
  /** Display label; builtin groups collapse to one row. */
  label: string;
  effect: string;
  kind: "builtin" | "mcp" | "agent" | "stageflow";
  /** For builtin groups: every tool id the row toggles. */
  tools: string[];
};

/** One approvals row per granted capability, in the order the tools section lists them. */
export function approvalRows(definition: AgentDefinition): ApprovalRow[] {
  const rows: ApprovalRow[] = [];
  for (const group of BUILTIN_GROUPS) {
    if (!definition.tools.builtin.includes(group.id)) continue;
    rows.push({ tool: group.tools[0]!, label: group.tools.join(" · "), effect: group.effect, kind: "builtin", tools: group.tools });
  }
  for (const [server, tools] of Object.entries(definition.tools.mcp)) {
    const listed = tools.includes("*")
      ? definition.approvals.ask_first.filter((id) => id.startsWith(`${server}.`)).map((id) => id.slice(server.length + 1))
      : tools;
    for (const tool of listed) {
      rows.push({ tool: `${server}.${tool}`, label: `${server}.${tool}`, effect: `${server} MCP tool`, kind: "mcp", tools: [`${server}.${tool}`] });
    }
  }
  const catalog = stageflowCatalog;
  const grants = definition.tools.stageflow ?? { groups: [], tools: [] };
  if (catalog) {
    const covered = new Set<string>();
    for (const group of catalog.groups) {
      if (!grants.groups.includes(group.id)) continue;
      group.tools.forEach((tool) => covered.add(tool.name));
      rows.push({ tool: group.tools[0]!.grantId, label: `${group.title} · Stageflow`, effect: `${group.tools.length} tools: ${group.summary}`, kind: "stageflow", tools: group.tools.map((t) => t.grantId) });
    }
    for (const group of catalog.groups) {
      for (const tool of group.tools) {
        if (covered.has(tool.name) || !grants.tools.includes(tool.name)) continue;
        rows.push({ tool: tool.grantId, label: tool.name, effect: RISK_EFFECT[tool.risk], kind: "stageflow", tools: [tool.grantId] });
      }
    }
  }
  for (const agentId of definition.sub_agents) {
    rows.push({
      tool: `agent:${agentId}`,
      label: `${agentId} · agent`,
      effect: "Runs another agent with its own rules",
      kind: "agent",
      tools: [`agent:${agentId}`],
    });
  }
  return rows;
}

export function rowAsksFirst(definition: AgentDefinition, row: ApprovalRow): boolean {
  return row.tools.some((tool) => definition.approvals.ask_first.includes(tool));
}

export function setRowAsksFirst(definition: AgentDefinition, row: ApprovalRow, asks: boolean): AgentDefinition {
  const without = definition.approvals.ask_first.filter((tool) => !row.tools.includes(tool));
  return {
    ...definition,
    approvals: { ...definition.approvals, ask_first: asks ? [...without, ...row.tools] : without },
  };
}

/** Drop ask-first entries for tools that are no longer granted (after a tool or sub-agent is removed). */
export function pruneAskFirst(definition: AgentDefinition): AgentDefinition {
  const granted = new Set(approvalRows(definition).flatMap((row) => row.tools));
  const wildcard = Object.entries(definition.tools.mcp)
    .filter(([, tools]) => tools.includes("*"))
    .map(([server]) => `${server}.`);
  const catalogLoaded = stageflowCatalog !== null;
  const kept = definition.approvals.ask_first.filter(
    (tool) =>
      granted.has(tool) ||
      wildcard.some((prefix) => tool.startsWith(prefix)) ||
      // Until the catalog arrives we cannot tell which Stageflow grants are still held, so keep them.
      (!catalogLoaded && tool.startsWith("stageflow.")),
  );
  return kept.length === definition.approvals.ask_first.length
    ? definition
    : { ...definition, approvals: { ...definition.approvals, ask_first: kept } };
}

export type SectionId =
  | "identity"
  | "instructions"
  | "model"
  | "tools"
  | "subagents"
  | "approvals"
  | "evals"
  | "observability"
  | "webchat"
  | "channels"
  | "limits"
  | "versions";

const SECTION_KEYS: Record<Exclude<SectionId, "versions">, Array<keyof AgentDefinition>> = {
  identity: ["name", "description", "greeting"],
  instructions: ["instructions", "project_context"],
  model: ["model", "execution"],
  tools: ["tools"],
  subagents: ["sub_agents", "sub_agent_depth"],
  approvals: ["approvals"],
  evals: ["guardrails", "evals"],
  observability: ["observability"],
  webchat: ["web_chat"],
  channels: ["channels", "schedule"],
  limits: ["limits"],
};

const CHANGE_LABEL: Record<string, string> = {
  name: "name",
  description: "description",
  greeting: "greeting",
  instructions: "instructions",
  project_context: "project context",
  model: "model",
  execution: "execution",
  tools: "tools",
  sub_agents: "sub-agents",
  sub_agent_depth: "sub-agent depth",
  approvals: "approvals",
  guardrails: "guardrails",
  evals: "evals",
  observability: "capture",
  web_chat: "web chat",
  channels: "channels",
  schedule: "schedule",
  limits: "limits",
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Human labels of the fields that differ, e.g. ["instructions", "model", "limits"]. */
export function changedFields(saved: AgentDefinition, draft: AgentDefinition): string[] {
  return Object.keys(CHANGE_LABEL)
    .filter((key) => !same(saved[key as keyof AgentDefinition], draft[key as keyof AgentDefinition]))
    .map((key) => CHANGE_LABEL[key]!);
}

export function changedSections(saved: AgentDefinition, draft: AgentDefinition): Set<SectionId> {
  const out = new Set<SectionId>();
  for (const [section, keys] of Object.entries(SECTION_KEYS) as Array<[SectionId, Array<keyof AgentDefinition>]>) {
    if (keys.some((key) => !same(saved[key], draft[key]))) out.add(section);
  }
  return out;
}

/** Issues whose path is the field or nested under it. */
export function issuesAt(issues: AgentIssue[], path: string): AgentIssue[] {
  return issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`));
}

export function addedLineCount(value: string, baseline: string): number {
  const before = new Set(baseline.split("\n"));
  return value.split("\n").filter((line) => line.trim() !== "" && !before.has(line)).length;
}

export function modelLabel(model: AgentDefinition["model"] | null): string {
  return model?.id ?? "project default";
}

export function backendLabel(backend: AgentDefinition["model"]["backend"]): string {
  return backend === "claude" ? "Claude" : "Pi";
}

/** Absolute shareable link, or null until web chat has a slug. */
export function webChatLink(agent: Pick<AgentSummary, "webChatUrl" | "publicBaseUrl"> | null | undefined, origin = window.location.origin): string | null {
  const path = agent?.webChatUrl;
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  const base = (agent?.publicBaseUrl || origin).replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export type WebChatState = "live" | "off" | "waiting";

/** Live needs web chat on and the agent enabled; the page answers 404 otherwise. */
export function webChatState(agentEnabled: boolean, definition: AgentDefinition | null): WebChatState {
  if (!definition?.web_chat.enabled) return "off";
  return agentEnabled ? "live" : "waiting";
}
