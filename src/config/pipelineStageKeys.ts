export const WIRING_KEYS = new Set([
  "id",
  "needs",
  "fork",
  "uses",
  "clonable",
  "clone_cap",
  "completion",
  "recovery",
  "on_verify_fail",
  "feedback_loop",
  "replay_safe",
]);

export const BODY_KEYS = new Set([
  "system_prompt",
  "model",
  "payload_schema",
  "gate_kinds",
  "pre_emit_checks",
  "clone_input_schema",
  "clone_actions",
  "timeout_ms",
  "skill",
  "mcp",
  "io",
  "verify",
]);

export function isPipelineStageBodyKey(key: string): boolean {
  return BODY_KEYS.has(key);
}

export function isAllowedPipelineStageEntryKey(key: string): boolean {
  return WIRING_KEYS.has(key) || BODY_KEYS.has(key);
}
