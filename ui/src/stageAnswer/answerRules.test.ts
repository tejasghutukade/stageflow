import { describe, expect, it, vi } from "vitest";
import type { MultiQuestionItem, PendingPrompt } from "../api";
import {
  buildOperatorAnswer,
  createAnswerSession,
  emptyMultiDraft,
  isAcceptEligible,
  isFreeTextReady,
  isMultiDraftReady,
  postOperatorAnswer,
  type MultiDraft,
  type PromptRef,
} from "./answerRules";

const confirmRef: PromptRef = { promptId: "prompt-1", kind: "confirm" };
const artifactRef: PromptRef = { promptId: "ab-1", kind: "artifact_backed" };
const freeTextRef: PromptRef = { promptId: "ft-1", kind: "free_text" };
const multiRef: PromptRef = { promptId: "mq-1", kind: "multi_question" };

const questions: MultiQuestionItem[] = [
  { id: "q-text", kind: "free_text", message: "Name?" },
  { id: "q-ok", kind: "confirm", message: "Ship it?" },
];

const multiPrompt: Extract<PendingPrompt, { kind: "multi_question" }> = {
  id: "mq-1",
  kind: "multi_question",
  questions,
};

function completeDraft(): MultiDraft {
  const draft = emptyMultiDraft(questions);
  draft.freeText["q-text"] = "Ada";
  draft.confirm["q-ok"] = { decision: "accept", text: "  go  " };
  return draft;
}

describe("buildOperatorAnswer", () => {
  it("confirm + accept builds a decision with no text", () => {
    expect(
      buildOperatorAnswer(confirmRef, {
        type: "decision",
        decision: "accept",
      }),
    ).toEqual({
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
    });
  });

  it("confirm + note trims the note and omits whitespace-only notes", () => {
    expect(
      buildOperatorAnswer(confirmRef, {
        type: "decision",
        decision: "accept",
        note: "  looks good  ",
      }),
    ).toEqual({
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
      text: "looks good",
    });
    expect(
      buildOperatorAnswer(confirmRef, {
        type: "decision",
        decision: "reject",
        note: "   \n\t  ",
      }),
    ).toEqual({
      promptId: "prompt-1",
      kind: "confirm",
      decision: "reject",
    });
  });

  it("artifact_backed + reject keeps kind artifact_backed", () => {
    expect(
      buildOperatorAnswer(artifactRef, {
        type: "decision",
        decision: "reject",
      }),
    ).toEqual({
      promptId: "ab-1",
      kind: "artifact_backed",
      decision: "reject",
    });
  });

  it("free_text empty or whitespace is not valid", () => {
    expect(isFreeTextReady("")).toBe(false);
    expect(isFreeTextReady("   \n")).toBe(false);
    expect(
      buildOperatorAnswer(freeTextRef, { type: "free_text", text: "" }),
    ).toBeNull();
    expect(
      buildOperatorAnswer(freeTextRef, { type: "free_text", text: "  " }),
    ).toBeNull();
  });

  it("free_text with text builds a trimmed free_text answer", () => {
    expect(
      buildOperatorAnswer(freeTextRef, {
        type: "free_text",
        text: "  hello world  ",
      }),
    ).toEqual({
      promptId: "ft-1",
      kind: "free_text",
      text: "hello world",
    });
  });

  it("multi_question is invalid when a free_text or confirm answer is missing", () => {
    const missingText = emptyMultiDraft(questions);
    missingText.confirm["q-ok"] = { decision: "accept", text: "" };
    expect(isMultiDraftReady(questions, missingText)).toBe(false);
    expect(
      buildOperatorAnswer(
        multiRef,
        { type: "multi", draft: missingText },
        multiPrompt,
      ),
    ).toBeNull();

    const missingConfirm = emptyMultiDraft(questions);
    missingConfirm.freeText["q-text"] = "Ada";
    expect(isMultiDraftReady(questions, missingConfirm)).toBe(false);
    expect(
      buildOperatorAnswer(
        multiRef,
        { type: "multi", draft: missingConfirm },
        multiPrompt,
      ),
    ).toBeNull();
  });

  it("complete multi_question is valid and builds one matching entry per question", () => {
    const draft = completeDraft();
    expect(isMultiDraftReady(questions, draft)).toBe(true);
    expect(
      buildOperatorAnswer(multiRef, { type: "multi", draft }, multiPrompt),
    ).toEqual({
      promptId: "mq-1",
      kind: "multi_question",
      answers: {
        "q-text": { kind: "free_text", text: "Ada" },
        "q-ok": { kind: "confirm", decision: "accept", text: "go" },
      },
    });
  });
});

describe("isAcceptEligible", () => {
  it("offers accept for confirm and artifact_backed with a prompt id", () => {
    expect(isAcceptEligible(confirmRef)).toBe(true);
    expect(isAcceptEligible(artifactRef)).toBe(true);
  });

  it("withholds accept for free_text, multi_question, and missing prompt id", () => {
    expect(isAcceptEligible(freeTextRef)).toBe(false);
    expect(isAcceptEligible(multiRef)).toBe(false);
    expect(isAcceptEligible({ kind: "confirm" })).toBe(false);
    expect(isAcceptEligible({ promptId: "", kind: "confirm" })).toBe(false);
    expect(isAcceptEligible(null)).toBe(false);
  });
});

describe("answer lock and submit", () => {
  it("AE3: after successful submit, lock stays until prompt id changes or the reference disappears", async () => {
    let pending: PromptRef | null = confirmRef;
    const submit = vi.fn(async () => ({ ok: true as const }));
    const session = createAnswerSession({
      getPending: () => pending,
      getTarget: () => ({ runId: "run-1", stageId: "stage-1" }),
      submit,
    });
    session.syncPending();

    await session.submitIntent({ type: "decision", decision: "accept" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("run-1", "stage-1", {
      promptId: "prompt-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(session.locked()).toBe(true);

    session.syncPending();
    expect(session.locked()).toBe(true);

    pending = { promptId: "prompt-2", kind: "confirm" };
    session.syncPending();
    expect(session.locked()).toBe(false);

    pending = confirmRef;
    session.syncPending();
    await session.submitIntent({ type: "decision", decision: "accept" });
    expect(session.locked()).toBe(true);

    pending = null;
    session.syncPending();
    expect(session.locked()).toBe(false);
  });

  it("failed submit releases the lock and surfaces the error", async () => {
    const submit = vi.fn(async () => {
      throw new Error("server rejected");
    });
    const session = createAnswerSession({
      getPending: () => confirmRef,
      getTarget: () => ({ runId: "run-1", stageId: "stage-1" }),
      submit,
    });
    session.syncPending();

    await session.submitIntent({ type: "decision", decision: "accept" });
    expect(session.locked()).toBe(false);
    expect(session.getState().error).toBe("server rejected");
  });

  it("refuses a submit whose prompt id no longer matches the pending prompt before any network call", async () => {
    const submit = vi.fn(async () => ({ ok: true as const }));
    const result = await postOperatorAnswer({
      pending: confirmRef,
      getPending: () => ({ promptId: "prompt-2", kind: "confirm" }),
      runId: "run-1",
      stageId: "stage-1",
      intent: { type: "decision", decision: "accept" },
      submit,
    });
    expect(result).toEqual({ status: "refused", reason: "stale" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("refreshes after a successful post and not after a failed one", async () => {
    const submit = vi.fn(async () => ({ ok: true as const }));
    const refresh = vi.fn(async () => {});
    const session = createAnswerSession({
      getPending: () => confirmRef,
      getTarget: () => ({ runId: "run-1", stageId: "stage-1" }),
      submit,
      refresh,
    });
    session.syncPending();
    await session.submitIntent({ type: "decision", decision: "accept" });
    expect(refresh).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error("nope");
    });
    const refresh2 = vi.fn(async () => {});
    const failed = createAnswerSession({
      getPending: () => confirmRef,
      getTarget: () => ({ runId: "run-1", stageId: "stage-1" }),
      submit: failing,
      refresh: refresh2,
    });
    failed.syncPending();
    await failed.submitIntent({ type: "decision", decision: "accept" });
    expect(refresh2).not.toHaveBeenCalled();
  });
});
