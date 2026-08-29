/**
 * Emit mode rejects missing fork_choice on fork success; stored mode treats
 * undefined as an empty choice set (scheduler defensive path).
 */
import { EnvelopeError } from "../types/envelope.js";
import type { ForkEmitContext } from "../types/forkChoice.js";

function assertForkChoiceLegality(
  choices: string[],
  forkEmitContext: ForkEmitContext,
): void {
  const { immediateSuccessorIds, forkShape } = forkEmitContext;

  for (const id of choices) {
    if (!immediateSuccessorIds.includes(id)) {
      throw new EnvelopeError(
        `fork_choice contains non-immediate successor: ${id}; clonable successors belong in clone_forks`,
      );
    }
  }

  if (choices.length === 0) {
    if (forkShape === null || !forkShape.allowNone) {
      throw new EnvelopeError("fork_choice must not be empty");
    }
  }

  if (forkShape !== null && forkShape.cardinality === "one" && choices.length !== 1) {
    throw new EnvelopeError("fork shape requires exactly one choice");
  }
}

export function assertForkEnvelope(
  params: unknown,
  forkEmitContext: ForkEmitContext,
): void {
  const record = params as Record<string, unknown>;
  if (record.status === "failure") return;

  if (record.fork_choice === undefined) {
    throw new EnvelopeError("fork stage must include fork_choice on success");
  }

  assertForkChoiceLegality(record.fork_choice as string[], forkEmitContext);
}

export function normalizeForkChoice(
  raw: string[] | undefined,
  mode: "emit" | "stored",
  forkEmitContext?: ForkEmitContext,
): Set<string> {
  if (mode === "stored") {
    if (raw === undefined) return new Set();
    return new Set(raw);
  }

  if (forkEmitContext === undefined) {
    if (raw === undefined) return new Set();
    return new Set(raw);
  }

  if (raw === undefined) {
    throw new EnvelopeError("fork stage must include fork_choice on success");
  }

  assertForkChoiceLegality(raw, forkEmitContext);
  return new Set(raw);
}
