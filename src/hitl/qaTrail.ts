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

export function derivePendingPrompt(
  events: readonly StageLogEvent[],
): AskOperatorPrompt | null {
  const pending = listQaExchanges(events).find((ex) => ex.answer === null);
  return pending?.prompt ?? null;
}
