import { describe, expect, it } from "vitest";
import { resolveTypesafeKey } from "../src/evals/triage/credentials.js";
import { JEV_MODEL_ID } from "../src/evals/triage/constants.js";
import { createJevClassifier } from "../src/evals/triage/jevClassifier.js";

/**
 * Opt-in: calls the real System One endpoint and costs a fraction of a cent.
 * STAGEFLOW_JEV_SMOKE=1 npx vitest run tests/evals.jev.smoke.test.ts   (with a key in TYPESAFE_API_KEY, JEV_API_KEY or STAGEFLOW_PROVIDER_TYPESAFE_API_KEY)
 */
const lookup = process.env.STAGEFLOW_JEV_SMOKE === "1" ? resolveTypesafeKey(process.cwd()) : undefined;

describe.skipIf(lookup?.key === undefined)("Jev smoke (real endpoint)", () => {
  it("classifies one obviously wrong agent output", async () => {
    const jev = createJevClassifier({ apiKey: lookup!.key as string });
    const state = JSON.stringify({
      target_kind: "agent",
      case: { title: "Refund status", input: "Where is my refund for order 42?", expected: "States the refund status from the order tool." },
      output: { transcript: "[turn 1] USER: Where is my refund for order 42?\n[turn 1] AGENT: I like turtles." },
      failed_graders: [{ id: "answers-question", type: "rubric", reason: "The reply does not address the question." }],
      passed_graders: [],
    });
    const out = await jev.classify({ targetKind: "agent", state, graderQuestions: [{ graderId: "answers-question", type: "rubric" }] });
    expect(["agent_wrong", "grader_wrong", "case_wrong", "unclear"]).toContain(out.bucket);
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    expect(out.answeredModel ?? JEV_MODEL_ID).toContain("jev");
    expect(out.graderFalseAlarms).toHaveLength(1);
  });
});
