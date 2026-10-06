/**
 * Durable Q&A trail — public entry for operator prompt/answer activity events.
 *
 * Event shapes live on StageActivityEvent; this module re-exports them,
 * provides narrow guards, append helpers, and pure pending/history derivation.
 */

import type {
  OperatorAnswerActivityEvent,
  OperatorPromptActivityEvent,
  StageActivityEvent,
  StageLogLine,
} from "../agent/activity.js";
import type { RunStore, StageLogEvent } from "../runstore/port.js";
import type {
  AskOperatorAnswer,
  AskOperatorPrompt,
} from "../tools/askOperator.js";
import type { PreEmitCheck } from "../types/preEmitCheck.js";
import type { StageGateKind } from "../types/stage.js";

export type {
  OperatorAnswerActivityEvent,
  OperatorPromptActivityEvent,
} from "../agent/activity.js";
export type { AskOperatorAnswer, AskOperatorPrompt } from "../tools/askOperator.js";

export type QaExchange = {
  prompt: AskOperatorPrompt;
  answer: AskOperatorAnswer | null;
};

export class QaTrailInvariantError extends Error {
  readonly code = "R8_MULTIPLE_PENDING_PROMPTS" as const;

  constructor(message = "Q&A trail has more than one pending operator prompt (R8)") {
    super(message);
    this.name = "QaTrailInvariantError";
  }
}

export function isOperatorPromptEvent(
  event: StageLogLine | StageActivityEvent,
): event is OperatorPromptActivityEvent {
  return event.event === "operator_prompt";
}

export function isOperatorAnswerEvent(
  event: StageLogLine | StageActivityEvent,
): event is OperatorAnswerActivityEvent {
  return event.event === "operator_answer";
}

export function operatorPromptEvent(
  prompt: AskOperatorPrompt,
): OperatorPromptActivityEvent {
  return { event: "operator_prompt", prompt };
}

export function operatorAnswerEvent(
  answer: AskOperatorAnswer,
): OperatorAnswerActivityEvent {
  return {
    event: "operator_answer",
    promptId: answer.promptId,
    answer,
  };
}

export async function appendOperatorPrompt(
  store: RunStore,
  runId: string,
  stageId: string,
  prompt: AskOperatorPrompt,
  options?: { attempt?: number },
): Promise<void> {
  await store.appendStageEvent(
    runId,
    stageId,
    operatorPromptEvent(prompt),
    options,
  );
}

export async function appendOperatorAnswer(
  store: RunStore,
  runId: string,
  stageId: string,
  answer: AskOperatorAnswer,
  options?: { attempt?: number },
): Promise<void> {
  await store.appendStageEvent(
    runId,
    stageId,
    operatorAnswerEvent(answer),
    options,
  );
}

function collectQaExchanges(events: readonly StageLogEvent[]): QaExchange[] {
  const exchanges: QaExchange[] = [];
  for (const event of events) {
    if (isOperatorPromptEvent(event)) {
      exchanges.push({ prompt: event.prompt, answer: null });
      continue;
    }
    if (isOperatorAnswerEvent(event)) {
      const open = exchanges.find(
        (ex) => ex.answer === null && ex.prompt.id === event.promptId,
      );
      if (open) open.answer = event.answer;
    }
  }
  return exchanges;
}

function assertAtMostOnePending(exchanges: readonly QaExchange[]): void {
  const pendingCount = exchanges.reduce(
    (n, ex) => n + (ex.answer === null ? 1 : 0),
    0,
  );
  if (pendingCount > 1) {
    throw new QaTrailInvariantError();
  }
}

export function listQaExchanges(events: readonly StageLogEvent[]): QaExchange[] {
  const exchanges = collectQaExchanges(events);
  assertAtMostOnePending(exchanges);
  return exchanges;
}

const DECISION_GATE_KINDS = new Set<StageGateKind>([
  "confirm",
  "artifact_backed",
]);

/**
 * Builds a reader over the live, attempt-scoped QA trail: `listStageEvents`
 * for this run/stage/attempt, collapsed via `listQaExchanges`. Read at
 * `emit_stage_envelope` execute time (not at stage-open/factory time) so it
 * reflects exchanges recorded during this attempt, including ones recorded
 * after the reader was constructed.
 */
export function createAttemptQaTrailReader(
  store: Pick<RunStore, "listStageEvents">,
  runId: string,
  stageId: string,
  attempt: number,
): () => Promise<QaExchange[]> {
  return async () => {
    const events = await store.listStageEvents(runId, stageId, attempt);
    return listQaExchanges(events);
  };
}

function lastDecisionIsAccept(answer: AskOperatorAnswer): boolean {
  return (
    (answer.kind === "confirm" || answer.kind === "artifact_backed") &&
    answer.decision === "accept"
  );
}

/**
 * Pre-emit `gate`-type check predicate: is the *most recent* exchange of the
 * check's declared kind, within this attempt's ordered trail, satisfied?
 * `confirm`/`artifact_backed` require the last such exchange's decision to be
 * "accept"; `free_text`/`multi_question` are satisfied by any completed
 * (answered) exchange of that kind. Returns an issue string on failure,
 * `undefined` on success. Deliberately independent of
 * `completionCheckRunner.ts`'s `runGateCheck` (see design doc Q2): that
 * function asks the looser, retrospective "was this kind ever accepted over
 * the run so far" question via order-erased `GateDecision[]`; this asks the
 * stricter, attempt-scoped "is the last answer of this kind an accept"
 * question, which requires the raw, ordered `QaExchange[]`.
 */
export function preEmitGateIssue(
  exchanges: readonly QaExchange[],
  check: Extract<PreEmitCheck, { type: "gate" }>,
): string | undefined {
  const ofKind = exchanges.filter((ex) => ex.prompt.kind === check.kind);
  if (DECISION_GATE_KINDS.has(check.kind)) {
    const last = ofKind.at(-1);
    if (last === undefined || last.answer === null) {
      return `declared gate kind "${check.kind}" has not completed this attempt`;
    }
    if (!lastDecisionIsAccept(last.answer)) {
      return `declared gate kind "${check.kind}" last decision must be "accept"`;
    }
    return undefined;
  }
  if (!ofKind.some((ex) => ex.answer !== null)) {
    return `declared gate kind "${check.kind}" has not completed this attempt`;
  }
  return undefined;
}

export function derivePendingPrompt(
  events: readonly StageLogEvent[],
): AskOperatorPrompt | null {
  const pending = listQaExchanges(events).find((ex) => ex.answer === null);
  return pending?.prompt ?? null;
}
