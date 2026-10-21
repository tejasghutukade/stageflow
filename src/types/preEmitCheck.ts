import type { StageGateKind } from "./stage.js";

/**
 * Emit-phase check IR (`StageConfig.pre_emit_checks`). YAML: `verify` items
 * whose `when` includes `emit`. Distinct from after-phase `CompletionCheck`
 * (`src/types/completion.ts`), which runs after a candidate envelope is captured.
 * This runs inside `emit_stage_envelope` before success is accepted.
 */
export type PreEmitCheck =
  | { id: string; type: "gate"; kind: StageGateKind }
  | { id: string; type: "artifact_declared"; basename: string }
  | {
      /** Host-injected for `browser.check` stages; never authored in YAML. */
      id: string;
      type: "browser_login_check";
      state: "logged_in" | "logged_out" | "unknown";
      logged_in: boolean | null;
      url: string;
    };
