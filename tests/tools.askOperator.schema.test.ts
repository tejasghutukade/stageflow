import { describe, expect, it } from "vitest";
import {
  AskOperatorError,
  assertAnswerMatchesPrompt,
  normalizePromptIds,
  parseAskOperatorAnswer,
  parseAskOperatorParams,
} from "../src/tools/askOperator.js";

describe("askOperator schema", () => {
  it("parses each of the four kinds and round-trips after ID normalization", () => {
    const freeText = normalizePromptIds(
      parseAskOperatorParams({
        kind: "free_text",
        message: "What should the module name be?",
      }),
    );
    expect(freeText.kind).toBe("free_text");
    expect(freeText.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    if (freeText.kind !== "free_text") throw new Error("expected free_text");
    const freeTextAnswer = parseAskOperatorAnswer({
      promptId: freeText.id,
      kind: "free_text",
      text: "billing",
    });
    expect(() =>
      assertAnswerMatchesPrompt(freeText, freeTextAnswer),
    ).not.toThrow();

    const confirm = normalizePromptIds(
      parseAskOperatorParams({
        kind: "confirm",
        message: "Proceed with the plan?",
        id: "confirm-1",
      }),
    );
    expect(confirm).toMatchObject({
      kind: "confirm",
      id: "confirm-1",
      message: "Proceed with the plan?",
    });
    const confirmAnswer = parseAskOperatorAnswer({
      promptId: "confirm-1",
      kind: "confirm",
      decision: "accept",
    });
    expect(() =>
      assertAnswerMatchesPrompt(confirm, confirmAnswer),
    ).not.toThrow();

    const multi = normalizePromptIds(
      parseAskOperatorParams({
        kind: "multi_question",
        id: "multi-1",
        questions: [
          { kind: "free_text", message: "Name?", id: "q-name" },
          { kind: "confirm", message: "OK?", id: "q-ok" },
        ],
      }),
    );
    expect(multi.kind).toBe("multi_question");
    if (multi.kind !== "multi_question") throw new Error("expected multi");
    expect(multi.questions).toEqual([
      { kind: "free_text", message: "Name?", id: "q-name" },
      { kind: "confirm", message: "OK?", id: "q-ok" },
    ]);
    const multiAnswer = parseAskOperatorAnswer({
      promptId: "multi-1",
      kind: "multi_question",
      answers: {
        "q-name": { kind: "free_text", text: "alpha" },
        "q-ok": { kind: "confirm", decision: "accept" },
      },
    });
    expect(() => assertAnswerMatchesPrompt(multi, multiAnswer)).not.toThrow();

    const artifact = normalizePromptIds(
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Review the plan",
        artifacts: ["stages/plan-review/attempts/1/artifacts/plan.md"],
      }),
    );
    expect(artifact.kind).toBe("artifact_backed");
    if (artifact.kind !== "artifact_backed") {
      throw new Error("expected artifact_backed");
    }
    expect(artifact.artifacts).toEqual([
      "stages/plan-review/attempts/1/artifacts/plan.md",
    ]);
    expect(artifact.id.length).toBeGreaterThan(0);
    const artifactAnswer = parseAskOperatorAnswer({
      promptId: artifact.id,
      kind: "artifact_backed",
      decision: "reject",
      text: "Please add risk section",
    });
    expect(() =>
      assertAnswerMatchesPrompt(artifact, artifactAnswer),
    ).not.toThrow();
  });

  it("accepts multi_question with mixed free_text/confirm when answer covers all ids", () => {
    const prompt = normalizePromptIds(
      parseAskOperatorParams({
        kind: "multi_question",
        questions: [
          { kind: "free_text", message: "Module name?" },
          { kind: "confirm", message: "Ship it?" },
          { kind: "free_text", message: "Owner?" },
        ],
      }),
    );
    if (prompt.kind !== "multi_question") throw new Error("expected multi");
    const [a, b, c] = prompt.questions;
    const answer = parseAskOperatorAnswer({
      promptId: prompt.id,
      kind: "multi_question",
      answers: {
        [a.id]: { kind: "free_text", text: "payments" },
        [b.id]: { kind: "confirm", decision: "reject", text: "not yet" },
        [c.id]: { kind: "free_text", text: "tejas" },
      },
    });
    expect(() => assertAnswerMatchesPrompt(prompt, answer)).not.toThrow();
  });

  it("accepts artifact_backed run-relative stages/<id>/attempts/1/artifacts/... paths", () => {
    const prompt = normalizePromptIds(
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Approve artifacts",
        artifacts: [
          "stages/design/attempts/1/artifacts/design.md",
          "stages/design/attempts/1/artifacts/nested/notes.txt",
        ],
        id: "art-1",
      }),
    );
    expect(prompt).toMatchObject({
      kind: "artifact_backed",
      id: "art-1",
      artifacts: [
        "stages/design/attempts/1/artifacts/design.md",
        "stages/design/attempts/1/artifacts/nested/notes.txt",
      ],
    });
  });

  it("fills omitted ids and preserves supplied ids", () => {
    const filled = normalizePromptIds(
      parseAskOperatorParams({
        kind: "multi_question",
        questions: [
          { kind: "free_text", message: "A" },
          { kind: "confirm", message: "B", id: "keep-b" },
        ],
      }),
    );
    if (filled.kind !== "multi_question") throw new Error("expected multi");
    expect(filled.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(filled.questions[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(filled.questions[1].id).toBe("keep-b");

    const preserved = normalizePromptIds(
      parseAskOperatorParams({
        kind: "free_text",
        message: "Hello",
        id: "agent-id",
      }),
    );
    expect(preserved.id).toBe("agent-id");

    const blankId = normalizePromptIds(
      parseAskOperatorParams({
        kind: "confirm",
        message: "OK?",
        id: "   ",
      }),
    );
    expect(blankId.id).not.toBe("   ");
    expect(blankId.id.length).toBeGreaterThan(0);
  });

  it("rejects unknown kind with a validation error naming the kind", () => {
    expect(() =>
      parseAskOperatorParams({
        kind: "wizard",
        message: "nope",
      }),
    ).toThrow(AskOperatorError);
    expect(() =>
      parseAskOperatorParams({
        kind: "wizard",
        message: "nope",
      }),
    ).toThrow(/unsupported prompt kind "wizard"/);
  });

  it("rejects nested multi_question or artifact_backed inside questions", () => {
    expect(() =>
      parseAskOperatorParams({
        kind: "multi_question",
        questions: [
          {
            kind: "multi_question",
            message: "nested",
          },
        ],
      }),
    ).toThrow(/nested multi_question|unsupported sub-question kind "multi_question"/);

    expect(() =>
      parseAskOperatorParams({
        kind: "multi_question",
        questions: [
          {
            kind: "artifact_backed",
            message: "nested",
          },
        ],
      }),
    ).toThrow(/artifact_backed/);
  });

  it("rejects partial multi_question answers", () => {
    const prompt = normalizePromptIds(
      parseAskOperatorParams({
        kind: "multi_question",
        id: "m1",
        questions: [
          { kind: "free_text", message: "One", id: "q1" },
          { kind: "free_text", message: "Two", id: "q2" },
        ],
      }),
    );
    const partial = parseAskOperatorAnswer({
      promptId: "m1",
      kind: "multi_question",
      answers: {
        q1: { kind: "free_text", text: "only one" },
      },
    });
    expect(() => assertAnswerMatchesPrompt(prompt, partial)).toThrow(
      /missing response for sub-question id "q2"/,
    );
  });

  it("rejects confirm answer missing decision", () => {
    expect(() =>
      parseAskOperatorAnswer({
        promptId: "c1",
        kind: "confirm",
        text: "feedback only",
      }),
    ).toThrow(/decision/);

    expect(() =>
      parseAskOperatorAnswer({
        promptId: "a1",
        kind: "artifact_backed",
      }),
    ).toThrow(/decision/);
  });

  it("rejects empty message and empty artifacts", () => {
    expect(() =>
      parseAskOperatorParams({
        kind: "free_text",
        message: "   ",
      }),
    ).toThrow(/message must be a non-empty string/);

    expect(() =>
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Review",
        artifacts: [],
      }),
    ).toThrow(/at least one path/);

    expect(() =>
      parseAskOperatorParams({
        kind: "artifact_backed",
        message: "Review",
        artifacts: [""],
      }),
    ).toThrow(/artifacts\[0\] must be a non-empty string/);
  });
});
