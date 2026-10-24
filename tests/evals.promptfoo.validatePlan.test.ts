import { describe, expect, it } from "vitest";
import { getEngine } from "../src/evals/engine/index.js";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import type { EvalPlan, ResolvedGrader } from "../src/evals/types.js";

function rubric(judge: string): ResolvedGrader {
  return {
    id: "r",
    type: "rubric",
    weight: 1,
    mustPass: false,
    hash: "abc123",
    rubric: "be good",
    scale: "pass_fail",
    passAt: 1,
    judge,
    examples: [],
  } as ResolvedGrader;
}

function engine() {
  return getEngine("promptfoo", { tokens: new RunTokenRegistry(), callbackUrl: "http://127.0.0.1:1/x" });
}

describe("PromptfooEngine.validatePlan", () => {
  it("rejects a judge with no promptfoo mapping before any run exists", () => {
    expect(() => engine().validatePlan?.({ graders: [rubric("cursor/auto")] } as unknown as EvalPlan)).toThrow(
      /cannot be used/,
    );
  });

  it("accepts a mapped judge", () => {
    expect(() =>
      engine().validatePlan?.({ graders: [rubric("anthropic/claude-sonnet-4-5")] } as unknown as EvalPlan),
    ).not.toThrow();
  });
});
