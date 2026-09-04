import type { StageGateKind } from "./stage.js";

/**
 * In-session checks `emit_stage_envelope` must satisfy this attempt before a
 * success emit is accepted. Distinct from `CompletionCheck`/`CompletionContract`
 * (`src/types/completion.ts`): those run post-hoc, after a candidate envelope
 * has already been captured, driven by the pipeline-wiring `completion` field.
 * `PreEmitCheck` runs synchronously inside the agent's own `emit_stage_envelope`
 * tool call, driven by the stage-body `pre_emit_checks` field.
 */
export type PreEmitCheck =
  | { id: string; type: "gate"; kind: StageGateKind }
  | { id: string; type: "artifact_declared"; basename: string };
