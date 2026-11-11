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
import { loginCheckIssue } from "../browser/loginCheck.js";
import { EnvelopeError, type StageEnvelope } from "../types/envelope.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";
import type { ArtifactPresenceContext } from "./assertEmittedArtifacts.js";
import {
  activeFunctionChecks,
  functionCheckErrorText,
  judgeFunctionVerification,
  type FunctionCheckInvoker,
  type FunctionRevisionLookup,
} from "./functionVerification.js";

export type PreEmitCheckOptions = {
  checks?: PreEmitCheck[];
  readQaTrail?: () => QaExchange[] | Promise<QaExchange[]>;
  /** Host attempt context for emit disk-truth of non-empty `envelope.artifacts`. */
  artifactPresence?: ArtifactPresenceContext;
  functions?: FunctionCheckInvoker;
  functionRevision?: FunctionRevisionLookup;
  runId?: string;
  stageId?: string;
  attempt?: number;
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
function candidateEnvelope(
  envelope: Pick<StageEnvelope, "artifacts" | "payload"> & Partial<StageEnvelope>,
): StageEnvelope {
  return {
    status: envelope.status === "failure" ? "failure" : "success",
    summary: envelope.summary ?? "",
    artifacts: [...envelope.artifacts],
    ...(envelope.payload !== undefined ? { payload: envelope.payload } : {}),
    ...(envelope.notes !== undefined ? { notes: envelope.notes } : {}),
    ...(envelope.stage_id !== undefined ? { stage_id: envelope.stage_id } : {}),
    ...(envelope.checklist_attestations !== undefined
      ? { checklist_attestations: envelope.checklist_attestations }
      : {}),
  };
}

export async function assertPreEmitChecks(
  envelope: Pick<StageEnvelope, "artifacts" | "payload"> & Partial<StageEnvelope>,
  options: PreEmitCheckOptions | undefined,
): Promise<void> {
  if (envelope.status === "failure") return;
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

    if (check.type === "browser_login_check") {
      const issue = loginCheckIssue(envelope.payload, check);
      if (issue !== undefined) {
        throw new EnvelopeError(issue);
      }
      continue;
    }

    if (check.type === "function") {
      const scope = activeFunctionChecks();
      const invoke = options?.functions?.invoke ?? scope?.invoke;
      const revisionOf = options?.functionRevision ?? scope?.revision;
      if (invoke === undefined || revisionOf === undefined) {
        throw new EnvelopeError("function invoker is not available");
      }
      const revision = await revisionOf(check.function);
      if (typeof revision !== "number") {
        throw new EnvelopeError("function revision is not pinned for this run");
      }
      let response;
      try {
        response = await invoke({
          functionId: check.function,
          revision,
          grants: check.grants,
          phase: "emit",
          checkId: check.id,
          envelope: candidateEnvelope(envelope),
          runId: options?.runId ?? scope?.runId,
          stageId: options?.stageId ?? scope?.stageId,
          attempt: options?.attempt ?? scope?.attempt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EnvelopeError(functionCheckErrorText("exception", message));
      }
      const verdict = judgeFunctionVerification(response, revision);
      switch (verdict.outcome) {
        case "passed":
          continue;
        case "failed":
          throw new EnvelopeError(verdict.message ?? "function check failed");
        case "error":
          throw new EnvelopeError(functionCheckErrorText(verdict.code, verdict.message));
      }
    }

    if (check.type !== "gate") {
      const unsupported: never = check;
      throw new EnvelopeError(`unsupported pre-emit check "${(unsupported as { type: string }).type}"`);
    }
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
