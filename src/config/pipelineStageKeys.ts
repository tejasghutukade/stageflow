export const WIRING_KEYS = new Set([
  "id",
  "needs",
  "fork",
  "uses",
  "clonable",
  "clone_cap",
  "completion",
  "recovery",
]);

export const BODY_KEYS = new Set([
  "system_prompt",
  "model",
  "payload_schema",
  "gate_kinds",
  "skill",
]);

export function isPipelineStageBodyKey(key: string): boolean {
  return BODY_KEYS.has(key);
}

export function isAllowedPipelineStageEntryKey(key: string): boolean {
  return WIRING_KEYS.has(key) || BODY_KEYS.has(key);
}
