import { describe, expect, it, vi } from "vitest";
import {
  createAskOperatorTool,
  type AskOperatorAnswer,
  type AskOperatorPrompt,
} from "../src/tools/askOperator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ask_operator tool", () => {
  it("blocks until bridge resolves free_text and returns non-terminating answer", async () => {
    const bridge = deferred<AskOperatorAnswer>();
    const requestWait = vi.fn((prompt: AskOperatorPrompt) => {
      expect(prompt.kind).toBe("free_text");
      expect(prompt.id).toBeTruthy();
      return bridge.promise;
    });
    const tool = createAskOperatorTool({ requestWait });

    const pending = tool.execute("1", {
      kind: "free_text",
      message: "What should the module name be?",
      id: "q-module",
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(requestWait).toHaveBeenCalledTimes(1);

    bridge.resolve({
      promptId: "q-module",
      kind: "free_text",
      text: "payments",
    });

    const out = await pending;
    expect(settled).toBe(true);
    expect(out.isError).toBeUndefined();
    expect(out.terminate).toBeUndefined();
    expect(out.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("payments"),
    });
    expect(out.details).toMatchObject({
      prompt: {
        id: "q-module",
        kind: "free_text",
        message: "What should the module name be?",
      },
      answer: {
        promptId: "q-module",
        kind: "free_text",
        text: "payments",
      },
      error: "",
    });
  });

  it("round-trips confirm accept and reject answers", async () => {
    const requestWait = vi.fn(async (prompt: AskOperatorPrompt) => {
      expect(prompt.kind).toBe("confirm");
      return {
        promptId: prompt.id,
        kind: "confirm",
        decision: "accept",
      } satisfies AskOperatorAnswer;
    });
    const tool = createAskOperatorTool({ requestWait });

    const acceptOut = await tool.execute("1", {
      kind: "confirm",
      message: "Ship this?",
      id: "c1",
    });
    expect(acceptOut.isError).toBeUndefined();
    expect(acceptOut.terminate).toBeUndefined();
    expect(acceptOut.details.answer).toMatchObject({
      promptId: "c1",
      kind: "confirm",
      decision: "accept",
    });

    requestWait.mockImplementationOnce(async (prompt: AskOperatorPrompt) => ({
      promptId: prompt.id,
      kind: "confirm",
      decision: "reject",
      text: "needs clearer wording",
    }));

    const rejectOut = await tool.execute("2", {
      kind: "confirm",
      message: "Ship this?",
      id: "c2",
    });
    expect(rejectOut.isError).toBeUndefined();
    expect(rejectOut.terminate).toBeUndefined();
    expect(rejectOut.details.answer).toMatchObject({
      promptId: "c2",
      kind: "confirm",
      decision: "reject",
      text: "needs clearer wording",
    });
  });

  it("resolves multi_question only with a full answer map", async () => {
    const requestWait = vi.fn(async (prompt: AskOperatorPrompt) => {
      expect(prompt.kind).toBe("multi_question");
      if (prompt.kind !== "multi_question") {
        throw new Error("expected multi_question");
      }
      return {
        promptId: prompt.id,
        kind: "multi_question",
        answers: {
          [prompt.questions[0]!.id]: { kind: "free_text", text: "alpha" },
          [prompt.questions[1]!.id]: {
            kind: "confirm",
            decision: "accept",
          },
          [prompt.questions[2]!.id]: { kind: "free_text", text: "gamma" },
        },
      } satisfies AskOperatorAnswer;
    });
    const tool = createAskOperatorTool({ requestWait });

    const out = await tool.execute("1", {
      kind: "multi_question",
      id: "batch-1",
      questions: [
        { kind: "free_text", message: "Name?", id: "q1" },
        { kind: "confirm", message: "Ready?", id: "q2" },
        { kind: "free_text", message: "Owner?", id: "q3" },
      ],
    });

    expect(out.isError).toBeUndefined();
    expect(out.terminate).toBeUndefined();
    expect(out.details.answer).toMatchObject({
      promptId: "batch-1",
      kind: "multi_question",
      answers: {
        q1: { kind: "free_text", text: "alpha" },
        q2: { kind: "confirm", decision: "accept" },
        q3: { kind: "free_text", text: "gamma" },
      },
    });
  });

  it("includes artifact paths in prompt details for artifact_backed", async () => {
    const artifactPath = "stages/plan-review/attempts/1/artifacts/plan.md";
    const requestWait = vi.fn(async (prompt: AskOperatorPrompt) => {
      expect(prompt).toMatchObject({
        kind: "artifact_backed",
        artifacts: [artifactPath],
      });
      return {
        promptId: prompt.id,
        kind: "artifact_backed",
        decision: "reject",
        text: "add rollout section",
      } satisfies AskOperatorAnswer;
    });
    const tool = createAskOperatorTool({ requestWait });

    const out = await tool.execute("1", {
      kind: "artifact_backed",
      message: "Approve this plan?",
      artifacts: [artifactPath],
      id: "ab-1",
    });

    expect(out.isError).toBeUndefined();
    expect(out.terminate).toBeUndefined();
    expect(out.details.prompt).toMatchObject({
      kind: "artifact_backed",
      artifacts: [artifactPath],
    });
    expect(out.details.answer).toMatchObject({
      promptId: "ab-1",
      kind: "artifact_backed",
      decision: "reject",
      text: "add rollout section",
    });
  });

  it("fills omitted IDs before requestWait sees the prompt", async () => {
    const requestWait = vi.fn(async (prompt: AskOperatorPrompt) => {
      expect(prompt.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      if (prompt.kind === "multi_question") {
        for (const q of prompt.questions) {
          expect(q.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          );
        }
        return {
          promptId: prompt.id,
          kind: "multi_question",
          answers: Object.fromEntries(
            prompt.questions.map((q) => [
              q.id,
              q.kind === "free_text"
                ? { kind: "free_text" as const, text: "ok" }
                : { kind: "confirm" as const, decision: "accept" as const },
            ]),
          ),
        } satisfies AskOperatorAnswer;
      }
      throw new Error("unexpected kind");
    });
    const tool = createAskOperatorTool({ requestWait });

    const out = await tool.execute("1", {
      kind: "multi_question",
      questions: [
        { kind: "free_text", message: "A?" },
        { kind: "confirm", message: "B?" },
      ],
    });

    expect(out.isError).toBeUndefined();
    expect(requestWait).toHaveBeenCalledTimes(1);
    const seen = requestWait.mock.calls[0]![0] as AskOperatorPrompt;
    expect(seen.id).toBeTruthy();
    expect(seen).toMatchObject({ kind: "multi_question" });
  });

  it("returns isError for bad params and never calls requestWait", async () => {
    const requestWait = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const tool = createAskOperatorTool({ requestWait });

    const out = await tool.execute("1", {
      kind: "wizard",
      message: "nope",
    });

    expect(requestWait).not.toHaveBeenCalled();
    expect(out.isError).toBe(true);
    expect(out.terminate).toBeUndefined();
    expect(out.details).toMatchObject({
      prompt: null,
      answer: null,
    });
    expect(out.details.error).toMatch(/unsupported prompt kind "wizard"/i);
  });

  it("returns isError without terminate when answer mismatches after resolve", async () => {
    const requestWait = vi.fn(async (prompt: AskOperatorPrompt) => ({
      promptId: prompt.id,
      kind: "confirm",
      decision: "accept",
    }));
    const tool = createAskOperatorTool({ requestWait });

    const out = await tool.execute("1", {
      kind: "free_text",
      message: "Name?",
      id: "ft-1",
    });

    expect(requestWait).toHaveBeenCalledTimes(1);
    expect(out.isError).toBe(true);
    expect(out.terminate).toBeUndefined();
    expect(out.details.prompt).toMatchObject({
      id: "ft-1",
      kind: "free_text",
    });
    expect(out.details.answer).toBeNull();
    expect(out.details.error).toMatch(/does not match prompt kind/i);
  });

  it("supports a second ask after the first resolves (multi-wait)", async () => {
    const first = deferred<AskOperatorAnswer>();
    const second = deferred<AskOperatorAnswer>();
    const requestWait = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const tool = createAskOperatorTool({ requestWait });

    const firstPending = tool.execute("1", {
      kind: "artifact_backed",
      message: "Review plan v1",
      artifacts: ["stages/plan-review/attempts/1/artifacts/plan-v1.md"],
      id: "ask-1",
    });

    let firstSettled = false;
    void firstPending.then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    first.resolve({
      promptId: "ask-1",
      kind: "artifact_backed",
      decision: "reject",
      text: "expand risks",
    });
    const firstOut = await firstPending;
    expect(firstOut.isError).toBeUndefined();
    expect(firstOut.terminate).toBeUndefined();
    expect(firstOut.details.answer).toMatchObject({
      decision: "reject",
      text: "expand risks",
    });

    const secondPending = tool.execute("2", {
      kind: "artifact_backed",
      message: "Review plan v2",
      artifacts: ["stages/plan-review/attempts/1/artifacts/plan-v2.md"],
      id: "ask-2",
    });

    let secondSettled = false;
    void secondPending.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    second.resolve({
      promptId: "ask-2",
      kind: "artifact_backed",
      decision: "accept",
    });
    const secondOut = await secondPending;
    expect(secondOut.isError).toBeUndefined();
    expect(secondOut.terminate).toBeUndefined();
    expect(secondOut.details.answer).toMatchObject({
      promptId: "ask-2",
      decision: "accept",
    });
    expect(requestWait).toHaveBeenCalledTimes(2);
  });
});
