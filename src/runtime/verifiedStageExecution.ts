import type { StageRunResult } from "../agent/port.js";
import { listQaExchanges } from "../hitl/qaTrail.js";
import { attemptArtifactsDir } from "../runstore/workspaceLayout.js";
import type { RunStore } from "../runstore/port.js";
import type { ResolvedPipelineDag } from "../types/pipeline.js";
import type { StageConfig } from "../types/stage.js";
import {
  COMPLETION_VERIFICATION_FAILURE_PREFIX,
} from "../types/completion.js";
import {
  runCompletionContract,
  type CheckoutCapability,
  type CheckoutSnapshot,
  type GateDecisionProvider,
} from "./completionCheckRunner.js";
import {
  readCompletionCheckoutBaseline,
  writeCompletionCheckoutBaseline,
} from "./completionCheckoutBaseline.js";
import { createGitCheckoutCapability } from "./gitCheckoutCapability.js";
import type { StageRoots } from "./stageRoots.js";

export type VerifiedStageExecution = {
  /** Establish durable observation before agent work begins. */
  prepare(): Promise<void>;
  /** Accept a successful agent result only when its contract passes. */
  verify(candidate: Extract<StageRunResult, { ok: true }>): Promise<StageRunResult>;
};

export function completionVerificationFailureReason(
  failedCheckIds: readonly string[],
): string {
  return `${COMPLETION_VERIFICATION_FAILURE_PREFIX} ${failedCheckIds.join(", ")}`;
}

function gateDecisionsForAttempt(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  attempt: number;
}): GateDecisionProvider {
  const { store, runId, stageId, attempt } = options;
  return {
    async listDecisions(kind) {
      const events = await store.listStageEvents(runId, stageId, attempt);
      return listQaExchanges(events)
        .filter((exchange) => exchange.prompt.kind === kind && exchange.answer !== null)
        .map((exchange) => {
          const answer = exchange.answer!;
          if (answer.kind === "confirm" || answer.kind === "artifact_backed") {
            return {
              kind,
              prompt_id: exchange.prompt.id,
              status: answer.decision === "accept" ? "accepted" as const : "rejected" as const,
            };
          }
          return { kind, prompt_id: exchange.prompt.id, status: "answered" as const };
        });
    },
  };
}

/**
 * Owns the verification lifecycle for one immutable stage attempt: establish
 * observation before agent work, then persist evidence before accepting a
 * candidate handoff. Agent lifecycle and final stage status stay outside this
 * module in stageRunner.
 */
export function createVerifiedStageExecution(options: {
  store: RunStore;
  runId: string;
  stageId: string;
  attempt: number;
  stage: StageConfig;
  dag?: ResolvedPipelineDag;
  roots: StageRoots;
}): VerifiedStageExecution {
  const { store, runId, stageId, attempt, stage, dag, roots } = options;
  const contract = dag?.nodes.find((node) => node.id === stageId)?.completion;
  let checkout: CheckoutCapability | undefined;
  let checkoutBefore: CheckoutSnapshot | undefined;
  let checkoutError: string | undefined;

  return {
    async prepare() {
      if (!contract?.checks.some((check) => check.type === "checkout_changes")) {
        return;
      }
      if (roots.checkoutRoot === undefined) {
        checkoutError = "checkout check requires a bound checkout";
        return;
      }
      checkout = createGitCheckoutCapability(roots.checkoutRoot);
      try {
        checkoutBefore = await readCompletionCheckoutBaseline(
          roots.runWorkspaceDir,
          stageId,
          attempt,
        );
        if (checkoutBefore === undefined) {
          checkoutBefore = await checkout.capture();
          await writeCompletionCheckoutBaseline(
            roots.runWorkspaceDir,
            stageId,
            attempt,
            checkoutBefore,
          );
        }
      } catch (error) {
        checkoutError = `could not capture checkout baseline: ${error instanceof Error ? error.message : String(error)}`;
      }
    },

    async verify(candidate) {
      if (contract === undefined) return candidate;
      try {
        const verification = await runCompletionContract({
          contract,
          envelope: candidate.envelope,
          payloadSchema: stage.payload_schema,
          artifactsDir: attemptArtifactsDir(roots.runWorkspaceDir, stageId, attempt),
          commandWorkingDirectory: roots.cwd,
          gates: gateDecisionsForAttempt({ store, runId, stageId, attempt }),
          checkout,
          checkoutBefore,
          checkoutError,
          checklistAttestations: candidate.envelope.checklist_attestations,
          onCheckStart: async (check) => {
            await store.upsertVerificationCheckResult(runId, stageId, {
              check_id: check.id,
              check_type: check.type,
              status: "running",
              started_at: new Date().toISOString(),
            }, { attempt });
          },
          onCheckComplete: async (check) => {
            await store.upsertVerificationCheckResult(runId, stageId, {
              check_id: check.check_id,
              check_type: check.check_type,
              status: check.outcome === "passed" ? "passed" : "failed",
              finished_at: new Date().toISOString(),
              evidence: {
                ...check.evidence,
                ...(check.message !== undefined ? { message: check.message } : {}),
                ...(check.outcome === "error" ? { runner_outcome: "error" } : {}),
              },
            }, { attempt });
          },
        });
        await store.updateStageExecution(runId, stageId, attempt, {
          verification_outcome: verification.outcome,
        });
        if (verification.outcome === "passed") return candidate;
        return {
          ok: false,
          reason: completionVerificationFailureReason(verification.failed_check_ids),
        };
      } catch (error) {
        await store.updateStageExecution(runId, stageId, attempt, {
          verification_outcome: "error",
        });
        throw error;
      }
    },
  };
}
