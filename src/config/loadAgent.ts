import { grantedStageflowTools, isOperatorOnlyGroup, isOperatorOnlyTool, isToolGroupId, stageflowGrantId, TOOL_META } from "../toolkit/meta.js";
import { Cron } from "croner";
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { yamlParsePosition } from "./yamlParsePosition.js";

/**
 * Project agent definition (`agents/<id>.agent.yaml`), schema v2.
 *
 * The YAML file is the source of truth for new sessions. This module owns the
 * shape, the field-level validation issues the editor maps onto controls, and
 * the canonical YAML serialization used for saves, previews, and diffs.
 */

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Builtin tool groups an agent can be granted, and the Pi tools each unlocks. */
export const BUILTIN_TOOL_GROUPS = {
  read: ["read", "grep", "find", "ls"],
  write: ["write", "edit"],
  shell: ["bash"],
} as const;

export type BuiltinToolGroup = keyof typeof BUILTIN_TOOL_GROUPS;
/** Every individual builtin tool id (read, grep, find, ls, write, edit, bash), in group order. */
export const BUILTIN_TOOL_IDS = Object.values(BUILTIN_TOOL_GROUPS).flat() as string[];
export const BUILTIN_TOOL_GROUP_IDS = Object.keys(BUILTIN_TOOL_GROUPS) as BuiltinToolGroup[];

export type AgentCommunicationProvider = "agentmail" | "slack" | "telegram" | "photon" | "email";

const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOOL_ID = /^(agent:[a-z][a-z0-9_]{0,63}|[A-Za-z0-9_.-]{1,128})$/;

const nonEmpty = z.string().trim().min(1, "Required");

function isValidCron(expression: string): boolean {
  try {
    new Cron(expression, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

function isValidRegex(pattern: string): boolean {
  try {
    void new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const modelSchema = z
  .strictObject({
    backend: z.enum(["pi", "claude"]).default("pi"),
    id: nonEmpty.optional(),
    thinking: z.enum(["off", "low", "medium", "high"]).default("medium"),
  })
  .prefault({});

const toolsSchema = z
  .strictObject({
    builtin: z
      .array(z.enum(BUILTIN_TOOL_GROUP_IDS as [BuiltinToolGroup, ...BuiltinToolGroup[]]))
      .default([])
      .refine((list) => new Set(list).size === list.length, "Duplicate tool group"),
    /** Single builtin tools on top of the groups, e.g. `grep` without the rest of `read`. */
    builtin_tools: z
      .array(z.enum(BUILTIN_TOOL_IDS as [string, ...string[]]))
      .default([])
      .refine((list) => new Set(list).size === list.length, "Duplicate tool"),
    mcp: z
      .record(
        z.string().regex(MCP_NAME, "Invalid MCP server name"),
        z.array(nonEmpty).min(1, "Allow at least one tool, or remove the server"),
      )
      .default({}),
    skills: z.array(nonEmpty).default([]),
    browser: z.boolean().default(false),
    stageflow: z
      .strictObject({
        groups: z.array(nonEmpty).default([]),
        tools: z.array(nonEmpty).default([]),
      })
      .prefault({}),
  })
  .prefault({});

const approvalsSchema = z
  .strictObject({
    ask_first: z.array(z.string().regex(TOOL_ID, "Invalid tool id")).default([]),
    approvers: z
      .strictObject({
        operators: z.boolean().default(true),
        channel_ids: z.array(nonEmpty).default([]),
      })
      .prefault({}),
    timeout_minutes: z.number().int().positive().max(10_080).default(30),
    on_timeout: z.enum(["skip", "deny"]).default("skip"),
  })
  .prefault({})
  .refine(
    (value) => value.approvers.operators || value.approvers.channel_ids.length > 0,
    { message: "Someone must be able to approve", path: ["approvers"] },
  );

const limitsSchema = z
  .strictObject({
    session_minutes: z.number().int().positive().max(1_440).default(10),
    max_turns: z.number().int().positive().max(1_000).default(40),
    cost_usd: z.number().positive().nullable().default(null),
    long_context: z.enum(["summarize", "truncate"]).default("summarize"),
  })
  .prefault({});

const scheduleSchema = z.strictObject({
  cron: nonEmpty.refine(isValidCron, "Invalid cron expression"),
  timezone: nonEmpty.optional(),
  message: nonEmpty.optional(),
});

export const WEB_CHAT_SLUG_PATTERN = /^[a-z0-9]{16,32}$/;

const webChatSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    slug: z.string().regex(WEB_CHAT_SLUG_PATTERN, "Use 16 to 32 lowercase letters or digits").optional(),
    rate_limit_per_minute: z.number().int().min(1).max(120).default(10),
    max_message_chars: z.number().int().min(1).max(20_000).default(4_000),
  })
  .prefault({});

export const agentDefinitionSchema = z.strictObject({
  id: z.string().regex(AGENT_ID_PATTERN, "Use lowercase letters, digits and _, starting with a letter"),
  name: nonEmpty.max(120),
  description: z.string().trim().max(500).optional(),
  greeting: z.string().trim().max(500).optional(),
  enabled: z.boolean().default(false),
  instructions: nonEmpty,
  project_context: z.boolean().default(false),
  execution: z.enum(["trusted-local", "sandbox"]).default("trusted-local"),
  model: modelSchema,
  tools: toolsSchema,
  approvals: approvalsSchema,
  sub_agents: z
    .array(z.string().regex(AGENT_ID_PATTERN, "Invalid agent id"))
    .default([])
    .refine((list) => new Set(list).size === list.length, "Duplicate sub-agent"),
  sub_agent_depth: z.number().int().min(1).max(5).default(1),
  guardrails: z
    .strictObject({
      block_patterns: z.array(nonEmpty.refine(isValidRegex, "Invalid regular expression")).default([]),
    })
    .prefault({}),
  evals: z.strictObject({ groundedness: z.boolean().default(false) }).prefault({}),
  observability: z
    .strictObject({
      capture: z.enum(["off", "metadata", "full"]).default("metadata"),
      otlp: z.boolean().default(false),
    })
    .prefault({}),
  channels: z.array(z.strictObject({ connection_id: nonEmpty })).default([]),
  web_chat: webChatSchema,
  schedule: scheduleSchema.optional(),
  limits: limitsSchema,
});

export type AgentDefinition = z.output<typeof agentDefinitionSchema>;
/** What callers may send: every block optional, defaults filled on parse. */
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;

export type AgentModelConfig = AgentDefinition["model"];
export type AgentTools = AgentDefinition["tools"];
export type AgentApprovals = AgentDefinition["approvals"];
export type AgentApprovers = AgentApprovals["approvers"];
export type AgentLimits = AgentDefinition["limits"];
export type AgentSchedule = NonNullable<AgentDefinition["schedule"]>;
export type AgentGuardrails = AgentDefinition["guardrails"];
export type AgentEvalsConfig = AgentDefinition["evals"];
export type AgentObservability = AgentDefinition["observability"];
export type AgentTraceCapture = AgentObservability["capture"];
export type AgentExecutionMode = AgentDefinition["execution"];
export type AgentWebChat = AgentDefinition["web_chat"];
export type AgentCommunicationBinding = AgentDefinition["channels"][number];

export type AgentIssue = {
  /** Dotted field path, e.g. `tools.mcp.notion` or `instructions`. Empty for file-level problems. */
  path: string;
  code: string;
  message: string;
  line?: number;
  column?: number;
};

export type AgentParseResult =
  | { ok: true; value: AgentDefinition }
  | { ok: false; issues: AgentIssue[] };

function zodIssues(error: z.ZodError): AgentIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code:
      issue.code === "unrecognized_keys"
        ? "agent.unknown_field"
        : issue.code === "custom"
          ? "agent.invalid_value"
          : issue.message === "Required"
            ? "agent.required"
            : `agent.${issue.code}`,
    message:
      issue.code === "unrecognized_keys"
        ? `Unknown field${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}`
        : issue.message,
  }));
}

/** Cross-field rules zod cannot express per-field. */
function semanticIssues(definition: AgentDefinition): AgentIssue[] {
  const issues: AgentIssue[] = [];
  const granted = grantedToolIds(definition);
  definition.approvals.ask_first.forEach((tool, index) => {
    if (!granted.has(tool) && !isWildcardMcpTool(definition, tool)) {
      issues.push({
        path: `approvals.ask_first.${index}`,
        code: "agent.ask_first_not_granted",
        message: `${tool} is not a tool this agent is granted`,
      });
    }
  });
  definition.tools.stageflow.groups.forEach((group, index) => {
    if (!isToolGroupId(group)) {
      issues.push({ path: `tools.stageflow.groups.${index}`, code: "agent.stageflow_group_unknown", message: `${group} is not a Stageflow tool group` });
    } else if (isOperatorOnlyGroup(group)) {
      issues.push({ path: `tools.stageflow.groups.${index}`, code: "agent.stageflow_operator_only", message: `${group} decides things a person must decide, so it cannot be granted to an agent` });
    }
  });
  definition.tools.stageflow.tools.forEach((tool, index) => {
    if (!(tool in TOOL_META)) {
      issues.push({ path: `tools.stageflow.tools.${index}`, code: "agent.stageflow_tool_unknown", message: `${tool} is not a Stageflow tool` });
    } else if (isOperatorOnlyTool(tool)) {
      issues.push({ path: `tools.stageflow.tools.${index}`, code: "agent.stageflow_operator_only", message: `${tool} is for operators only and cannot be granted to an agent` });
    }
  });
  if ("stageflow" in definition.tools.mcp) {
    issues.push({ path: "tools.mcp.stageflow", code: "agent.mcp_name_reserved", message: "stageflow is reserved for Stageflow's own tools; rename the MCP server" });
  }
  if (definition.sub_agents.includes(definition.id)) {
    issues.push({
      path: "sub_agents",
      code: "agent.sub_agent_self",
      message: "An agent cannot call itself",
    });
  }
  return issues;
}

/** Parse an untrusted object (API body or parsed YAML) into a definition. */
export function parseAgentDefinition(raw: unknown): AgentParseResult {
  const parsed = agentDefinitionSchema.safeParse(raw, {
    error: (issue) => (issue.code === "invalid_type" && issue.input === undefined ? "Required" : undefined),
  });
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: parsed.data };
}

export function parseAgentYaml(text: string): AgentParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          code: "agent.yaml_syntax",
          message: error instanceof YAMLParseError ? error.message.split("\n")[0]! : "YAML could not be parsed",
          ...yamlParsePosition(error),
        },
      ],
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "", code: "agent.invalid_shape", message: "Expected a YAML mapping" }] };
  }
  return parseAgentDefinition(raw);
}

/**
 * Canonical YAML: fixed key order, defaults omitted, so diffs between
 * revisions show only what an operator actually set.
 */
export function serializeAgentDefinition(definition: AgentDefinition): string {
  const defaults = agentDefinitionSchema.parse({ id: definition.id, name: "x", instructions: "x" });
  const out: Record<string, unknown> = {
    id: definition.id,
    name: definition.name,
  };
  if (definition.description) out.description = definition.description;
  if (definition.greeting) out.greeting = definition.greeting;
  out.enabled = definition.enabled;
  out.instructions = definition.instructions.endsWith("\n") ? definition.instructions : `${definition.instructions}\n`;
  const keys = [
    "project_context",
    "execution",
    "model",
    "tools",
    "approvals",
    "sub_agents",
    "sub_agent_depth",
    "guardrails",
    "evals",
    "observability",
    "channels",
    "web_chat",
    "schedule",
    "limits",
  ] as const;
  for (const key of keys) {
    const value = definition[key];
    if (value === undefined) continue;
    const pruned = pruneDefaults(value, defaults[key]);
    if (pruned !== undefined) out[key] = pruned;
  }
  return stringifyYaml(out, { lineWidth: 0 });
}

function pruneDefaults(value: unknown, fallback: unknown): unknown {
  if (JSON.stringify(value) === JSON.stringify(fallback)) return undefined;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    fallback !== null &&
    typeof fallback === "object" &&
    !Array.isArray(fallback)
  ) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const pruned = pruneDefaults(child, (fallback as Record<string, unknown>)[key]);
      if (pruned !== undefined) result[key] = pruned;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return value;
}

/** Builtin tool ids granted by whole groups and by single tools, in group order. */
export function grantedBuiltinTools(definition: Pick<AgentDefinition, "tools">): string[] {
  const granted = new Set<string>(definition.tools.builtin_tools ?? []);
  for (const group of definition.tools.builtin) for (const tool of BUILTIN_TOOL_GROUPS[group]) granted.add(tool);
  return BUILTIN_TOOL_IDS.filter((tool) => granted.has(tool));
}

/** Every tool id the definition grants: builtin tool names, `<server>.<tool>`, and `agent:<id>`. */
export function grantedToolIds(definition: Pick<AgentDefinition, "tools" | "sub_agents">): Set<string> {
  const ids = new Set<string>();
  for (const tool of grantedBuiltinTools(definition)) ids.add(tool);
  for (const [server, tools] of Object.entries(definition.tools.mcp)) {
    for (const tool of tools) ids.add(`${server}.${tool}`);
  }
  for (const tool of grantedStageflowTools(definition.tools.stageflow)) ids.add(stageflowGrantId(tool));
  for (const agentId of definition.sub_agents) ids.add(`agent:${agentId}`);
  return ids;
}

function isWildcardMcpTool(definition: AgentDefinition, tool: string): boolean {
  const dot = tool.indexOf(".");
  if (dot <= 0) return false;
  return definition.tools.mcp[tool.slice(0, dot)]?.includes("*") ?? false;
}

/** A complete definition with every default applied, for a brand-new agent. */
export function newAgentDefinition(input: {
  id: string;
  name: string;
  instructions: string;
  description?: string;
}): AgentParseResult {
  return parseAgentDefinition({
    id: input.id,
    name: input.name,
    instructions: input.instructions,
    ...(input.description ? { description: input.description } : {}),
  });
}
