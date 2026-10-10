import { describe, expect, it } from "vitest";
import {
  buildAcceptIntent,
  buildRejectIntent,
  buildStageAnswerPayload,
} from "./gateAnswerIntents";

describe("gateAnswerIntents", () => {
  it("builds confirm accept payload", () => {
    const ref = { promptId: "p1", kind: "confirm" as const };
    const intent = buildAcceptIntent(ref, null, "", { freeText: {}, confirm: {} });
    expect(intent).toEqual({ type: "decision", decision: "accept" });
    const answer = buildStageAnswerPayload(ref, intent!);
    expect(answer).toEqual({
      promptId: "p1",
      kind: "confirm",
      decision: "accept",
    });
  });

  it("requires note for reject on decision gates", () => {
    const ref = { promptId: "p1", kind: "confirm" as const };
    expect(buildRejectIntent(ref, "  ")).toBeNull();
    const intent = buildRejectIntent(ref, "please revise");
    expect(intent).toEqual({
      type: "decision",
      decision: "reject",
      note: "please revise",
    });
    const answer = buildStageAnswerPayload(ref, intent!);
    expect(answer).toEqual({
      promptId: "p1",
      kind: "confirm",
      decision: "reject",
      text: "please revise",
    });
  });

  it("rejects reject intent for free_text gates", () => {
    const ref = { promptId: "p2", kind: "free_text" as const };
    expect(buildRejectIntent(ref, "note")).toBeNull();
  });

  it("rejects reject intent for multi_question gates", () => {
    const ref = { promptId: "p3", kind: "multi_question" as const };
    expect(buildRejectIntent(ref, "note")).toBeNull();
  });

  it("allows reject for artifact_backed gates", () => {
    const ref = { promptId: "p4", kind: "artifact_backed" as const };
    expect(buildRejectIntent(ref, "fix draft")).toEqual({
      type: "decision",
      decision: "reject",
      note: "fix draft",
    });
  });

  it("builds free_text accept when text is ready", () => {
    const ref = { promptId: "p2", kind: "free_text" as const };
    const intent = buildAcceptIntent(ref, null, "hello", {
      freeText: {},
      confirm: {},
    });
    expect(intent).toEqual({ type: "free_text", text: "hello" });
  });
});
