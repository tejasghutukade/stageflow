import type { StageGateKind } from "./stage.js";

export const COMPLETION_VERIFICATION_FAILURE_PREFIX =
  "Completion verification failed:";

/**
 * After-phase check IR (`DAG node.completion`). YAML: `verify` items whose
 * `when` includes `after`. `type: payload_schema` here is a check kind (re-check
 * the success payload after emit), not the old YAML authoring key.
 */
export type CompletionCheck =
  | {
      id: string;
      type: "command";
      run: string;
      cwd?: string;
      timeout_ms?: number;
    }
  | {
      id: string;
      type: "artifact";
      path: string;
      nonempty?: boolean;
    }
  | { id: string; type: "checklist"; items: string[] }
  | { id: string; type: "payload_schema" }
  | { id: string; type: "gate"; kind: StageGateKind }
  | { id: string; type: "checkout_changes"; path_fields?: string[] };

export type CompletionContract = {
  mode: "all";
  checks: CompletionCheck[];
};

/** IR recovery on the DAG node. YAML: `on_verify_fail`. */
export type RecoveryPolicy =
  | {
      mode: "repair";
      max_attempts: number;
      retry_safety: "idempotent";
      include_failed_checks: boolean;
    }
  | {
      mode: "manual";
      retry_safety: "idempotent" | "side_effecting";
      include_failed_checks?: boolean;
    };
