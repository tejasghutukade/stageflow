import type { PendingPrompt } from "../../api";
import {
  buildOperatorAnswer,
  isAcceptEligible,
  isFreeTextReady,
  isMultiDraftReady,
  type MultiDraft,
  type OperatorIntent,
  type PromptRef,
} from "../../stageAnswer/answerRules";

export function buildAcceptIntent(
  ref: PromptRef,
  prompt: PendingPrompt | null,
  freeText: string,
  multiDraft: MultiDraft,
  note?: string,
): OperatorIntent | null {
  if (ref.kind === "free_text") {
    if (!isFreeTextReady(freeText)) return null;
    return { type: "free_text", text: freeText };
  }
  if (ref.kind === "multi_question") {
    if (!prompt || prompt.kind !== "multi_question") return null;
    if (!isMultiDraftReady(prompt.questions, multiDraft)) return null;
    return { type: "multi", draft: multiDraft };
  }
  if (isAcceptEligible(ref)) {
    const trimmed = note?.trim();
    return trimmed
      ? { type: "decision", decision: "accept", note: trimmed }
      : { type: "decision", decision: "accept" };
  }
  return null;
}

export function buildRejectIntent(
  ref: PromptRef,
  note: string,
): OperatorIntent | null {
  if (!isAcceptEligible(ref)) return null;
  const trimmed = note.trim();
  if (!trimmed) return null;
  return { type: "decision", decision: "reject", note: trimmed };
}

export function buildStageAnswerPayload(
  ref: PromptRef,
  intent: OperatorIntent,
  prompt?: PendingPrompt,
) {
  return buildOperatorAnswer(ref, intent, prompt);
}
