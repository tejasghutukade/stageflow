/**
 * Allowed keys on a pipeline stage YAML entry.
 *
 * Target authoring: `io`, `verify`, `on_verify_fail`.
 * IR / legacy YAML (same strings): `payload_schema`, `pre_emit_checks`,
 * `completion`, `recovery`, `clone_input_schema`.
 *
 * New catalog fields go on the target keys (and compileTargetContract). Dual-read
 * still lists the IR names so old files load.
 */
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
  /** Additive, alongside `needs`/`fork`/`feedback_loop` (route-based-pipeline-wiring spec). */
  "route",
  "entry",
]);

/** Stage body keys. Target: `io` / `verify`. IR/legacy: `payload_schema`, `pre_emit_checks`, `clone_input_schema`. */
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
