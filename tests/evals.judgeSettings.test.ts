import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvalOutcome } from "../src/config/loadEval.js";
import type { LoadIssue } from "../src/config/loadOutcome.js";
import { buildConfig } from "../src/evals/engine/promptfoo/generate.js";
import { combineVotes } from "../src/evals/votes.js";
import {
  normalizeRecord,
  VOTE_METRIC_SEPARATOR,
  type RecordComponent,
  type ResultRecord,
} from "../src/evals/engine/promptfoo/normalize.js";
import { renderConversationRubricPrompt, renderRubricPrompt } from "../src/evals/engine/promptfoo/rubricPrompt.js";
import type { NormalizedGrade, ResolvedGrader } from "../src/evals/types.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { samplePlan } from "./evals/promptfooHelpers.js";

const GRADER_URL = pathToFileURL(path.resolve("src/evals/graders/index.ts")).href;

const HEAD = [
  "version: 1",
  "id: sample",
  "target:",
  "  kind: stage",
  "  file: ../stages/review.yaml",
  "dataset: ../datasets/sample.dataset.jsonl",
].join("\n");

function load(yaml: string) {
  return parseEvalOutcome(yaml, path.join(FIXTURES_ROOT, "evals", "sample.eval.yaml"), FIXTURES_ROOT);
}

function issues(yaml: string): LoadIssue[] {
  const outcome = load(yaml);
  return outcome.ok ? [] : outcome.issues;
}

const RUBRIC = ["graders:", "  - id: clear", "    type: rubric", "    rubric: Is it clear?"];

describe("judge_settings in the eval file", () => {
  it("merges grader settings over defaults key by key and puts them in the hash", () => {
    const withDefaults = load(
      [
        HEAD,
        "defaults:",
        "  judge: anthropic/claude-sonnet-4-5",
        "  judge_settings: { temperature: 0, votes: 3 }",
        ...RUBRIC,
        "    judge_settings: { votes: 5, reasoning: true }",
      ].join("\n"),
    );
    expect(withDefaults.ok).toBe(true);
    if (!withDefaults.ok) return;
    const grader = withDefaults.value.graders[0]!;
    expect(grader.type === "rubric" && grader.judgeSettings).toEqual({ temperature: 0, votes: 5, reasoning: true });

    const plain = load([HEAD, "defaults:", "  judge: anthropic/claude-sonnet-4-5", ...RUBRIC].join("\n"));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.value.graders[0]!.hash).not.toBe(grader.hash);
    const none = plain.value.graders[0]!;
    expect("judgeSettings" in none).toBe(false);
  });

  it("keeps the hash of a grader with no settings unchanged by the feature", () => {
    const a = load([HEAD, "defaults:", "  judge: anthropic/claude-sonnet-4-5", ...RUBRIC].join("\n"));
    const b = load([HEAD, "defaults:", "  judge: anthropic/claude-sonnet-4-5", ...RUBRIC, "    judge_settings: {}"].join("\n"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.graders[0]!.hash).toBe(a.value.graders[0]!.hash);
  });

  it("rejects bad values and unknown keys", () => {
    const bad = (settings: string) =>
      issues([HEAD, ...RUBRIC, `    judge_settings: ${settings}`].join("\n")).map((i) => i.message ?? "").join("|");
    expect(bad("{ votes: 2 }")).toMatch(/votes/);
    expect(bad("{ votes: 7 }")).toMatch(/votes/);
    expect(bad("{ temperature: 2 }")).toMatch(/temperature/);
    expect(bad("{ reasoning: yes_please }")).toMatch(/reasoning/);
    expect(bad("{ nope: 1 }")).toMatch(/nope/);
    expect(bad("[1]")).toMatch(/mapping/);
  });
});

describe("reasoning prompt variant", () => {
  it("asks for the reason before the verdict and leaves the default prompt untouched", () => {
    const plain = renderRubricPrompt({ scale: "pass_fail", examples: [] });
    const reasoning = renderRubricPrompt({ scale: "pass_fail", examples: [], reasoning: true });
    expect(plain).toContain('{"pass": true|false, "score": <1 or 0>, "reason": "<one sentence>"}');
    expect(reasoning).toContain('writing "reason" first: {"reason"');
    expect(reasoning).not.toContain('"reason": "<one sentence>"');
    expect(renderRubricPrompt({ scale: "pass_fail", examples: [], reasoning: false })).toBe(plain);
    const conversation = renderConversationRubricPrompt({ scale: "1_to_5", examples: [], reasoning: true });
    expect(conversation).toContain('writing "reason" first');
    expect(conversation).toContain("<integer 1-5>");
  });
});

function rubricGrader(settings?: { temperature?: number; reasoning?: boolean; votes?: number }): ResolvedGrader {
  return {
    id: "pf",
    type: "rubric",
    weight: 1,
    mustPass: false,
    hash: "h",
    rubric: "Is it good?",
    scale: "pass_fail",
    passAt: 1,
    judge: "anthropic/claude-sonnet-4-5",
    ...(settings !== undefined ? { judgeSettings: settings } : {}),
    examples: [],
  };
}

describe("generated config with judge settings", () => {
  const assertionsOf = (graders: ResolvedGrader[], options: Record<string, unknown> = {}) => {
    const config = buildConfig(samplePlan({ graders }), { graderModuleUrl: GRADER_URL, ...options }) as {
      tests: Array<{ assert: Array<Record<string, any>> }>;
    };
    return config.tests[0]!.assert;
  };

  it("adds one assertion per vote, the first keeping the grader id", () => {
    const a = assertionsOf([rubricGrader({ votes: 3 })]);
    expect(a.map((x) => x.metric)).toEqual(["pf", `pf${VOTE_METRIC_SEPARATOR}2`, `pf${VOTE_METRIC_SEPARATOR}3`]);
    expect(a.every((x) => x.type === "llm-rubric")).toBe(true);
  });

  it("sets temperature on the judge provider only when given, keeping other provider config", () => {
    expect(assertionsOf([rubricGrader()])[0]!.provider).toBe("anthropic:messages:claude-sonnet-4-5");
    expect(assertionsOf([rubricGrader({ temperature: 0.3 })])[0]!.provider).toEqual({
      id: "anthropic:messages:claude-sonnet-4-5",
      config: { temperature: 0.3 },
    });
    expect(
      assertionsOf([rubricGrader({ temperature: 0 })], { judgeProviderConfig: { apiBaseUrl: "http://x" } })[0]!.provider,
    ).toEqual({ id: "anthropic:messages:claude-sonnet-4-5", config: { apiBaseUrl: "http://x", temperature: 0 } });
  });

  it("uses the reasoning prompt only when asked", () => {
    expect(assertionsOf([rubricGrader({ reasoning: true })])[0]!.rubricPrompt).toContain('writing "reason" first');
    expect(assertionsOf([rubricGrader({ votes: 3 })])[0]!.rubricPrompt).not.toContain('writing "reason" first');
  });
});

const graded = (over: Partial<NormalizedGrade>): NormalizedGrade => ({
  graderId: "pf",
  graderType: "rubric",
  status: "graded",
  judgeModel: "m",
  judgeTokensIn: 10,
  judgeTokensOut: 2,
  judgeCostUsd: 0.01,
  ...over,
});

describe("combineVotes", () => {
  const pf = { scale: "pass_fail" as const, passAt: 1 };

  it("returns a single vote unchanged", () => {
    const one = graded({ passed: true, score: 1, rawValue: 1, reason: "ok" });
    expect(combineVotes(pf, [one])).toBe(one);
  });

  it("takes the majority and sums tokens and cost", () => {
    const out = combineVotes(pf, [
      graded({ passed: true, score: 1, rawValue: 1, reason: "yes a" }),
      graded({ passed: false, score: 0, rawValue: 0, reason: "no" }),
      graded({ passed: true, score: 1, rawValue: 1, reason: "yes b" }),
    ]);
    expect(out).toMatchObject({ status: "graded", passed: true, score: 1, reason: "yes a", judgeTokensIn: 30, judgeTokensOut: 6 });
    expect(out.judgeCostUsd).toBeCloseTo(0.03, 10);
    expect((out.details as { votes: unknown[] }).votes).toHaveLength(3);
  });

  it("leaves errored votes out, and a tie among the rest fails", () => {
    const err = graded({ status: "error", errorCode: "EVAL_JUDGE_ERROR" });
    const tie = combineVotes(pf, [
      graded({ passed: true, score: 1, rawValue: 1 }),
      graded({ passed: false, score: 0, rawValue: 0 }),
      err,
    ]);
    expect(tie).toMatchObject({ status: "graded", passed: false });
    const two = combineVotes(pf, [graded({ passed: true, score: 1, rawValue: 1 }), err, err]);
    expect(two).toMatchObject({ status: "graded", passed: true });
  });

  it("is an error grade, with cost kept, when every vote errored", () => {
    const err = graded({ status: "error", errorCode: "EVAL_JUDGE_ERROR" });
    const out = combineVotes(pf, [err, err, err]);
    expect(out).toMatchObject({ status: "error", errorCode: "EVAL_JUDGE_ERROR", judgeTokensIn: 30 });
  });

  it("averages 1 to 5 raw scores and applies pass_at to the mean", () => {
    const scale = { scale: "1_to_5" as const, passAt: 4 };
    const out = combineVotes(scale, [
      graded({ passed: true, rawValue: 5, score: 1 }),
      graded({ passed: true, rawValue: 4, score: 0.75 }),
      graded({ passed: false, rawValue: 2, score: 0.25 }),
    ]);
    expect(out.rawValue).toBeCloseTo(11 / 3, 10);
    expect(out.score).toBeCloseTo((11 / 3 - 1) / 4, 10);
    expect(out.passed).toBe(false);
  });
});

describe("normalizeRecord with votes", () => {
  it("combines the vote components of a grader into one grade", () => {
    const plan = samplePlan({ graders: [rubricGrader({ votes: 3 })] });
    const comp = (metric: string, pass: boolean): RecordComponent => ({
      metric,
      type: "llm-rubric",
      pass,
      score: pass ? 1 : 0,
      reason: pass ? "good" : "bad",
      tokensIn: 100,
      tokensOut: 10,
      graderError: false,
    });
    const record: ResultRecord = {
      caseId: "c1",
      metadata: {
        caseId: "c1",
        repeatIndex: 0,
        stageRunId: "sr_1",
        latencyMs: 1,
        costUsd: 0,
      },
      output: JSON.stringify({ status: "success", summary: "s", artifacts: [] }),
      components: [comp("pf", true), comp(`pf${VOTE_METRIC_SEPARATOR}2`, false), comp(`pf${VOTE_METRIC_SEPARATOR}3`, true)],
    };
    const out = normalizeRecord(record, { caseId: "c1", repeatIndex: 0 }, plan, {
      judgePrice: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
    });
    expect(out.result.grades).toHaveLength(1);
    expect(out.result.grades[0]).toMatchObject({ graderId: "pf", passed: true, judgeTokensIn: 300 });
    expect(out.judgeCostUsd).toBeCloseTo(330 / 1_000_000, 10);
  });
});

import { isFloatingModelId, modelFamily, sameModelFamily } from "../src/evals/judgeProviders.js";

describe("model family helpers", () => {
  it("groups ids by model line", () => {
    expect(modelFamily("anthropic/claude-sonnet-4-5")).toBe("claude");
    expect(modelFamily("openrouter/anthropic/claude-3.5-sonnet")).toBe("claude");
    expect(modelFamily("openai/gpt-4o")).toBe("gpt");
    expect(modelFamily("google/gemini-2.5-pro")).toBe("gemini");
    expect(sameModelFamily("anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(sameModelFamily("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5")).toBe(false);
    expect(sameModelFamily("anthropic/claude-sonnet-4-5", "openai/gpt-4o")).toBe(false);
  });

  it("flags only floating ids", () => {
    expect(isFloatingModelId("anthropic/claude-sonnet-latest")).toBe(true);
    expect(isFloatingModelId("openai/gpt-4o:latest")).toBe(true);
    expect(isFloatingModelId("anthropic/claude-sonnet-4-5-20250929")).toBe(false);
    expect(isFloatingModelId("anthropic/claude-sonnet-4-5")).toBe(false);
  });
});
