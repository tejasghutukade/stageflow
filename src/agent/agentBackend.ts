/**
 * Known AgentPort backend ids, and the config-hierarchy gate.
 *
 * Kept dependency-free (no adapter imports) so config loaders can validate
 * `agent:` fields without pulling in the actual SDKs.
 */
export const AGENT_BACKENDS = ["pi", "claude"] as const;

export type AgentBackendId = (typeof AGENT_BACKENDS)[number];

export function isAgentBackendId(value: string): value is AgentBackendId {
  return (AGENT_BACKENDS as readonly string[]).includes(value);
}

/** Narrows an already-validated config field; returns undefined for anything else. */
export function asAgentBackendId(value: string | undefined): AgentBackendId | undefined {
  return value !== undefined && isAgentBackendId(value) ? value : undefined;
}

export type ParsedAgentField =
  | { ok: true; value: AgentBackendId | undefined }
  | { ok: false; message: string };

/**
 * Validates a raw `agent:` config value (stage, pipeline, or manifest YAML).
 * Callers own their own error shape (code/category/label differ per site) —
 * this only owns the one rule that must stay identical everywhere: absent is
 * fine, present must be a known backend id.
 */
export function parseAgentField(raw: unknown): ParsedAgentField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "string" || !isAgentBackendId(raw)) {
    return {
      ok: false,
      message: `agent must be one of ${AGENT_BACKENDS.join(", ")}`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * Stage-level `agent` overrides are parsed and stored on StageConfig, but
 * intentionally not consulted by resolveAgentBackend while this is false.
 * Flip to true once per-stage selection is ready to ship; no other change
 * needed to light it up.
 */
export const STAGE_LEVEL_AGENT_OVERRIDE_ENABLED = false;
