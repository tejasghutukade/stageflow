/**
 * In-session runner for `pre_emit_checks` (`src/types/preEmitCheck.ts`).
 *
 * Distinct from `completionCheckRunner.ts`'s post-hoc `CompletionCheck`
 * runner: this runs synchronously inside `emit_stage_envelope`'s own tool
 * call, before a candidate envelope is even captured, and never touches
 * disk — `artifact_declared` only checks whether a basename is *listed* in
 * `envelope.artifacts`, and `gate` only reads the live, attempt-scoped QA
 * trail via a caller-supplied `readQaTrail`. See the design doc's Q1/Q3 for
 * why this stays separate from `CompletionCheck`'s `artifact`/`gate` runners.
 */
import { preEmitGateIssue, type QaExchange } from "../hitl/qaTrail.js";
import { EnvelopeError, type StageEnvelope } from "../types/envelope.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";

export type PreEmitCheckOptions = {
  checks?: PreEmitCheck[];
  readQaTrail?: () => QaExchange[] | Promise<QaExchange[]>;
};

function artifactListsBasename(artifact: string, basename: string): boolean {
  return artifact === basename || artifact.endsWith(`/${basename}`);
}

export function declaredArtifactIssue(
  artifacts: readonly string[],
  check: Extract<PreEmitCheck, { type: "artifact_declared" }>,
): string | undefined {
  const listed = artifacts.some((artifact) =>
    artifactListsBasename(artifact, check.basename),
  );
  if (!listed) {
    return `required artifact "${check.basename}" is missing from envelope.artifacts`;
  }
  return undefined;
}

/**
 * Runs `options.checks` in declaration order and throws `EnvelopeError` on
 * the first failing check, matching the single-message-per-rejected-emit
 * contract the rest of `emitStageEnvelope.ts`'s `assert*` helpers use. A
 * `gate` check with no `readQaTrail` fails closed (cannot be verified). No
 * `checks` (or an empty list) is a no-op.
 */
export async function assertPreEmitChecks(
  envelope: Pick<StageEnvelope, "artifacts">,
  options: PreEmitCheckOptions | undefined,
): Promise<void> {
  const checks = options?.checks;
  if (checks === undefined || checks.length === 0) {
    return;
  }

  let exchanges: QaExchange[] | undefined;
  for (const check of checks) {
    if (check.type === "artifact_declared") {
      const issue = declaredArtifactIssue(envelope.artifacts, check);
      if (issue !== undefined) {
        throw new EnvelopeError(issue);
      }
      continue;
    }

    // check.type === "gate"
    if (options?.readQaTrail === undefined) {
      throw new EnvelopeError(
        "declared gate kinds cannot be verified without a QA trail reader",
      );
    }
    if (exchanges === undefined) {
      exchanges = await options.readQaTrail();
    }
    const issue = preEmitGateIssue(exchanges, check);
    if (issue !== undefined) {
      throw new EnvelopeError(issue);
    }
  }
}
