import { parse as parseYaml } from "yaml";

const AGENT_ID = /^[a-z][a-z0-9_]{0,63}$/;

export type AgentDefinition = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  description?: string;
};

export type AgentParseResult =
  | { ok: true; value: AgentDefinition }
  | { ok: false; code: "agent.invalid"; message: string };

const INVALID: AgentParseResult = {
  ok: false,
  code: "agent.invalid",
  message: "Agent YAML is invalid",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentDefinition(raw: unknown): AgentParseResult {
  if (!isRecord(raw)) return INVALID;
  if (typeof raw.id !== "string" || !AGENT_ID.test(raw.id)) return INVALID;
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) return INVALID;
  if (typeof raw.instructions !== "string" || raw.instructions.trim().length === 0) {
    return INVALID;
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return INVALID;
  if (raw.description !== undefined && typeof raw.description !== "string") return INVALID;
  return {
    ok: true,
    value: {
      id: raw.id,
      name: raw.name,
      instructions: raw.instructions,
      enabled: raw.enabled ?? false,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    },
  };
}

export function parseAgentYaml(text: string): AgentParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return INVALID;
  }
  return parseAgentDefinition(raw);
}
