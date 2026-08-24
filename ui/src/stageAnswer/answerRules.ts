import type {
  Decision,
  MultiQuestionItem,
  PendingPrompt,
  StageAnswer,
} from "../api";

export type PromptKind = PendingPrompt["kind"];

export type PromptRef = {
  promptId: string;
  kind: PromptKind;
};

export type MultiDraft = {
  freeText: Record<string, string>;
  confirm: Record<string, { decision: Decision | null; text: string }>;
};

export type OperatorIntent =
  | { type: "decision"; decision: Decision; note?: string }
  | { type: "free_text"; text: string }
  | { type: "multi"; draft: MultiDraft };

export type AnswerLockState = {
  submitting: boolean;
  awaitingClear: boolean;
  error: string | null;
};

export type AnswerSubmitFn = (
  runId: string,
  stageId: string,
  answer: StageAnswer,
) => Promise<unknown>;

export type PostOperatorAnswerResult =
  | { status: "posted" }
  | { status: "refused"; reason: "stale" | "invalid" | "missing_stage" }
  | { status: "failed"; error: string };

export type AcceptEligibleInput = {
  promptId?: string | null;
  kind?: PromptKind | null;
} | null;

export function emptyMultiDraft(questions: MultiQuestionItem[]): MultiDraft {
  const freeText: Record<string, string> = {};
  const confirm: Record<string, { decision: Decision | null; text: string }> =
    {};
  for (const q of questions) {
    if (q.kind === "free_text") freeText[q.id] = "";
    else confirm[q.id] = { decision: null, text: "" };
  }
  return { freeText, confirm };
}

export function isFreeTextReady(text: string): boolean {
  return text.trim().length > 0;
}

export function isMultiDraftReady(
  questions: MultiQuestionItem[],
  draft: MultiDraft,
): boolean {
  return questions.every((q) => {
    if (q.kind === "free_text") {
      return isFreeTextReady(draft.freeText[q.id] ?? "");
    }
    return draft.confirm[q.id]?.decision != null;
  });
}

export function isAcceptEligible(pending: AcceptEligibleInput): boolean {
  if (!pending) return false;
  const promptId = pending.promptId;
  const kind = pending.kind;
  return (
    Boolean(promptId) &&
    (kind === "confirm" || kind === "artifact_backed")
  );
}

function optionalNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed ? trimmed : undefined;
}

function buildDecisionAnswer(
  ref: PromptRef,
  intent: Extract<OperatorIntent, { type: "decision" }>,
): StageAnswer | null {
  if (ref.kind !== "confirm" && ref.kind !== "artifact_backed") return null;
  const text = optionalNote(intent.note);
  return text
    ? {
        promptId: ref.promptId,
        kind: ref.kind,
        decision: intent.decision,
        text,
      }
    : {
        promptId: ref.promptId,
        kind: ref.kind,
        decision: intent.decision,
      };
}

function buildMultiAnswer(
  promptId: string,
  questions: MultiQuestionItem[],
  draft: MultiDraft,
): StageAnswer {
  const answers: Extract<StageAnswer, { kind: "multi_question" }>["answers"] =
    {};
  for (const q of questions) {
    if (q.kind === "free_text") {
      answers[q.id] = { kind: "free_text", text: draft.freeText[q.id] ?? "" };
    } else {
      const entry = draft.confirm[q.id];
      const decision = entry?.decision;
      if (decision == null) continue;
      const text = optionalNote(entry.text);
      answers[q.id] = text
        ? { kind: "confirm", decision, text }
        : { kind: "confirm", decision };
    }
  }
  return { promptId, kind: "multi_question", answers };
}

export function buildOperatorAnswer(
  ref: PromptRef,
  intent: OperatorIntent,
  prompt?: PendingPrompt,
): StageAnswer | null {
  if (!ref.promptId) return null;

  if (intent.type === "decision") {
    return buildDecisionAnswer(ref, intent);
  }

  if (intent.type === "free_text") {
    if (ref.kind !== "free_text") return null;
    if (!isFreeTextReady(intent.text)) return null;
    return {
      promptId: ref.promptId,
      kind: "free_text",
      text: intent.text.trim(),
    };
  }

  if (ref.kind !== "multi_question") return null;
  if (!prompt || prompt.kind !== "multi_question") return null;
  if (!isMultiDraftReady(prompt.questions, intent.draft)) return null;
  return buildMultiAnswer(ref.promptId, prompt.questions, intent.draft);
}

export function pendingIdentityKey(pending: PromptRef | null): string | null {
  return pending ? `${pending.promptId}:${pending.kind}` : null;
}

function idleLock(): AnswerLockState {
  return { submitting: false, awaitingClear: false, error: null };
}

export function isLocked(state: AnswerLockState): boolean {
  return state.submitting || state.awaitingClear;
}

function beginSubmit(state: AnswerLockState): AnswerLockState {
  return { ...state, submitting: true, error: null };
}

function succeedSubmit(): AnswerLockState {
  return { submitting: false, awaitingClear: true, error: null };
}

function failSubmit(error: string): AnswerLockState {
  return { submitting: false, awaitingClear: false, error };
}

function samePending(a: PromptRef | null, b: PromptRef | null): boolean {
  return pendingIdentityKey(a) === pendingIdentityKey(b);
}

export async function postOperatorAnswer(args: {
  pending: PromptRef | null;
  getPending?: () => PromptRef | null;
  runId: string;
  stageId: string | undefined;
  intent: OperatorIntent;
  prompt?: PendingPrompt;
  submit: AnswerSubmitFn;
}): Promise<PostOperatorAnswerResult> {
  const { pending, runId, stageId, intent, prompt, submit } = args;
  if (!pending || !pending.promptId) {
    return { status: "refused", reason: "stale" };
  }
  if (!stageId) {
    return { status: "refused", reason: "missing_stage" };
  }
  const current = args.getPending?.() ?? pending;
  if (!samePending(current, pending)) {
    return { status: "refused", reason: "stale" };
  }
  const answer = buildOperatorAnswer(pending, intent, prompt);
  if (!answer || answer.promptId !== pending.promptId) {
    return { status: "refused", reason: "invalid" };
  }
  try {
    await submit(runId, stageId, answer);
    return { status: "posted" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type AnswerSession = {
  getState(): AnswerLockState;
  locked(): boolean;
  syncPending(): void;
  submitIntent(intent: OperatorIntent, prompt?: PendingPrompt): Promise<void>;
};

export function createAnswerSession(deps: {
  getPending: () => PromptRef | null;
  getTarget: () => { runId: string; stageId: string | undefined };
  submit: AnswerSubmitFn;
  refresh?: () => void | Promise<void>;
}): AnswerSession {
  let lock = idleLock();
  let lastKey = pendingIdentityKey(deps.getPending());

  return {
    getState() {
      return lock;
    },
    locked() {
      return isLocked(lock);
    },
    syncPending() {
      const nextKey = pendingIdentityKey(deps.getPending());
      if (nextKey === lastKey) return;
      lastKey = nextKey;
      lock = idleLock();
    },
    async submitIntent(intent, prompt) {
      if (isLocked(lock)) return;
      const pending = deps.getPending();
      const { runId, stageId } = deps.getTarget();
      lock = beginSubmit(lock);
      const result = await postOperatorAnswer({
        pending,
        getPending: deps.getPending,
        runId,
        stageId,
        intent,
        prompt,
        submit: deps.submit,
      });
      if (result.status === "posted") {
        lock = succeedSubmit();
        await deps.refresh?.();
        return;
      }
      if (result.status === "failed") {
        lock = failSubmit(result.error);
        return;
      }
      lock = idleLock();
    },
  };
}
