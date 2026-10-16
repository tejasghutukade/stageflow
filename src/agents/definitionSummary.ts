import { agentDefinitionSchema, BUILTIN_TOOL_GROUPS, type AgentDefinition } from "../config/loadAgent.js";

export type SummaryLine = { label: string; value: string };

/**
 * Best-effort view of a possibly incomplete draft with schema defaults
 * applied, so a partial draft can still be described. Required strings that
 * are missing become empty; everything else gets its default.
 */
export function withDefaults(draft: Record<string, unknown>): AgentDefinition {
  const lenient = { id: "draft", name: "draft", instructions: "draft", ...draft };
  const parsed = agentDefinitionSchema.safeParse(lenient);
  if (parsed.success) return parsed.data;
  // Fall back section by section so one bad field doesn't hide the rest.
  const base = agentDefinitionSchema.parse({ id: "draft", name: "draft", instructions: "draft" });
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(draft)) {
    const attempt = agentDefinitionSchema.safeParse({ ...base, [key]: value });
    if (attempt.success) merged[key] = (attempt.data as Record<string, unknown>)[key];
  }
  return merged as AgentDefinition;
}

function list(items: string[], empty: string): string {
  return items.length > 0 ? items.join(", ") : empty;
}

const SECTIONS: Array<{ label: string; keys: Array<keyof AgentDefinition>; describe: (d: AgentDefinition) => string }> = [
  {
    label: "Identity",
    keys: ["id", "name", "description", "greeting"],
    describe: (d) => [d.name, d.id].filter(Boolean).join(" · "),
  },
  {
    label: "Instructions",
    keys: ["instructions", "project_context"],
    describe: (d) => {
      const lines = d.instructions.split("\n").filter((line) => line.trim()).length;
      return `${lines} line${lines === 1 ? "" : "s"}${d.project_context ? " · reads project context" : ""}`;
    },
  },
  {
    label: "Model",
    keys: ["model"],
    describe: (d) => `${d.model.id ?? "project default"} · ${d.model.backend === "claude" ? "Claude" : "Pi"} · ${d.model.thinking} thinking`,
  },
  {
    label: "Tools",
    keys: ["tools"],
    describe: (d) =>
      list(
        [
          ...d.tools.builtin,
          ...d.tools.builtin_tools.filter((tool) => !d.tools.builtin.some((group) => BUILTIN_TOOL_GROUPS[group].includes(tool as never))),
          ...Object.entries(d.tools.mcp).map(([server, tools]) => `${server} (${tools.includes("*") ? "all" : tools.join(", ")})`),
          ...d.tools.skills.map((skill) => `skill ${skill}`),
          ...(d.tools.browser ? ["browser"] : []),
          ...d.tools.stageflow.groups.map((group) => `stageflow ${group}`),
          ...(d.tools.stageflow.tools.length > 0 ? [`stageflow ${d.tools.stageflow.tools.join(", ")}`] : []),
        ],
        "none",
      ),
  },
  {
    label: "Approvals",
    keys: ["approvals"],
    describe: (d) =>
      d.approvals.ask_first.length > 0
        ? `asks before ${d.approvals.ask_first.join(", ")}`
        : "nothing asks first",
  },
  { label: "Sub-agents", keys: ["sub_agents", "sub_agent_depth"], describe: (d) => list(d.sub_agents, "none") },
  {
    label: "Guardrails",
    keys: ["guardrails", "evals"],
    describe: (d) => `${d.guardrails.block_patterns.length} block pattern${d.guardrails.block_patterns.length === 1 ? "" : "s"}`,
  },
  {
    label: "Capture",
    keys: ["observability"],
    describe: (d) =>
      ({ off: "off", metadata: "timing and metadata only", full: "full content, secrets masked" })[d.observability.capture],
  },
  {
    label: "Channels",
    keys: ["channels", "schedule"],
    describe: (d) =>
      list([...d.channels.map((c) => c.connection_id), ...(d.schedule ? [`schedule ${d.schedule.cron}`] : [])], "console only"),
  },
  {
    label: "Limits",
    keys: ["limits"],
    describe: (d) =>
      `${d.limits.session_minutes} min · ${d.limits.max_turns} turns · ${d.limits.cost_usd === null ? "no cost cap" : `$${d.limits.cost_usd}`}`,
  },
];

/** One line per section that differs between two drafts, describing the new value. */
export function describeChanges(before: Record<string, unknown>, after: Record<string, unknown>): SummaryLine[] {
  const a = withDefaults(before);
  const b = withDefaults(after);
  return SECTIONS.filter((section) =>
    section.keys.some((key) => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)),
  ).map((section) => ({ label: section.label, value: section.describe(b) }));
}
