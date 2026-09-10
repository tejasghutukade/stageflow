import type { StageGateKind } from "./stage.js";

/**
 * Emit-phase check IR (`StageConfig.pre_emit_checks`). YAML: `verify` items
 * whose `when` includes `emit`. Distinct from after-phase `CompletionCheck`
 * (`src/types/completion.ts`), which runs after a candidate envelope is captured.
 * This runs inside `emit_stage_envelope` before success is accepted.
 */
export type PreEmitCheck =
  | { id: string; type: "gate"; kind: StageGateKind }
  | { id: string; type: "artifact_declared"; basename: string };
