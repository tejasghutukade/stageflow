import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type NormalizeContext,
  normalizeRecord,
  recordIdentity,
  recordsFromResultsFile,
  type ResultRecord,
} from "../src/evals/engine/promptfoo/normalize.js";
import type { EvalPlan, NormalizedResult } from "../src/evals/types.js";
import { OK_OUTPUT, okRun, samplePlan } from "./evals/promptfooHelpers.js";

const fixture: unknown = JSON.parse(
  readFileSync(path.resolve("tests/fixtures/evals/promptfoo-results.json"), "utf8"),
);

function fixturePlan(): EvalPlan {
  const base = samplePlan({ repeats: 2 });
  return {
    ...base,
    cases: ["c1", "c2", "c3", "c-fail", "c-bad", "c-throw"].map((id, position) => ({
      id,
      position,
      input: { q: id },
      tags: [],
    })),
    graders: [
      { ...base.graders[0], id: "field_answer" },
      { ...base.graders[1], id: "quality" },
    ],
  };
}

function normalizeAll(
  plan: EvalPlan,
  hostRun?: NormalizeContext["hostRun"],
): NormalizedResult[] {
  const records = recordsFromResultsFile(fixture) as ResultRecord[];
  return records.map((record) => {
    const identity = recordIdentity(record, plan);
    if (!identity) throw new Error("no identity");
    return normalizeRecord(record, identity, plan, {
      judgePrice: () => ({ inputPerMillion: 1, outputPerMillion: 2 }),
      ...(hostRun ? { hostRun } : {}),
    }).result;
  });
}

function find(results: NormalizedResult[], caseId: string, repeatIndex: number): NormalizedResult {
  const found = results.find((r) => r.caseId === caseId && r.repeatIndex === repeatIndex);
  if (!found) throw new Error(`missing ${caseId}#${repeatIndex}`);
  return found;
}

describe("normalizing the saved promptfoo results", () => {
  const results = normalizeAll(fixturePlan());

  it("yields one result per (case, repeat), joined by case id and testIdx", () => {
    expect(results).toHaveLength(12);
    expect(new Set(results.map((r) => `${r.caseId}#${r.repeatIndex}`)).size).toBe(12);
  });

  it("copies provider metadata into the run and the output from the response", () => {
    expect(find(results, "c1", 0).run).toEqual({
      ok: true,
      stageRunId: "run-c1-0",
      output: expect.objectContaining({ status: "success", payload: { answer: 7 } }),
      latencyMs: 250,
      costUsd: 0.0123,
      tokensIn: 1000,
      tokensOut: 200,
    });
    expect(find(results, "c1", 1).run).toMatchObject({ stageRunId: "run-c1-1" });
  });

  it("grades a 1-5 rubric from the raw component score without clamping", () => {
    const grades = (id: string) => find(results, id, 0).grades;
    const c1 = grades("c1");
    expect(c1[0]).toEqual({
      graderId: "field_answer",
      graderType: "field",
      status: "graded",
      passed: true,
      score: 1,
      rawValue: 1,
      reason: "answer matches",
    });
    expect(c1[1]).toMatchObject({
      graderId: "quality",
      graderType: "rubric",
      status: "graded",
      rawValue: 3,
      score: 0.5,
      passed: false,
      reason: "stub judge gave 3",
      judgeModel: "openai/stub-judge",
      judgeTokensIn: 111,
      judgeTokensOut: 22,
    });
    expect(c1[1].judgeCostUsd).toBeCloseTo((111 * 1 + 22 * 2) / 1_000_000, 12);
    expect(grades("c2")[1]).toMatchObject({ rawValue: 5, score: 1, passed: true });
    expect(grades("c3")[1]).toMatchObject({ rawValue: 1, score: 0, passed: false });
    expect(grades("c3")[0]).toMatchObject({ passed: false, score: 0, reason: "answer 7 != 8" });
  });

  it("maps a provider error to a failed run with no grades", () => {
    const r = find(results, "c-fail", 1);
    expect(r.run).toEqual({ ok: false, code: "EVAL_STAGE_FAILED", message: "stub stage failed" });
    expect(r.grades).toEqual([]);
  });

  it("maps a judge that returned non-JSON to a judge error and stores no reason", () => {
    const r = find(results, "c-bad", 0);
    expect(r.grades[0]).toMatchObject({ graderId: "field_answer", status: "graded", passed: true });
    expect(r.grades[1]).toMatchObject({
      graderId: "quality",
      status: "error",
      errorCode: "EVAL_JUDGE_ERROR",
      judgeTokensIn: 111,
    });
    expect(r.grades[1].reason).toBeUndefined();
    expect(JSON.stringify(results)).not.toContain("Could not extract JSON");
  });

  it("maps a thrown assertion to engine errors on every grader and drops the stack", () => {
    const r = find(results, "c-throw", 0);
    expect(r.run).toMatchObject({ ok: false, code: "EVAL_ENGINE_ERROR" });
    expect(r.grades).toEqual([]);
    expect(JSON.stringify(results)).not.toContain("exploded");
    expect(JSON.stringify(results)).not.toContain("/work/");
  });

  it("uses the Host's own record for a result whose assertion threw", () => {
    const withHost = normalizeAll(fixturePlan(), (caseId, repeatIndex) =>
      caseId === "c-throw" ? okRun(caseId, repeatIndex) : undefined,
    );
    const r = find(withHost, "c-throw", 1);
    expect(r.run).toMatchObject({ ok: true, stageRunId: "run-c-throw-1" });
    expect(r.grades).toEqual([
      { graderId: "field_answer", graderType: "field", status: "error", errorCode: "EVAL_ENGINE_ERROR" },
      { graderId: "quality", graderType: "rubric", status: "error", errorCode: "EVAL_ENGINE_ERROR" },
    ]);
  });
});

describe("normalizeRecord details", () => {
  const plan = samplePlan();
  const identity = { caseId: "c1", repeatIndex: 0 };
  const base: ResultRecord = {
    metadata: { caseId: "c1", repeatIndex: 0, stageRunId: "s", latencyMs: 1, costUsd: 0, tokensIn: 1, tokensOut: 1 },
    output: JSON.stringify(OK_OUTPUT),
    failureReason: 0,
    components: [],
  };

  it("prefers the full grade carried in component metadata", () => {
    const stageflow = {
      graderId: "field_answer",
      graderType: "field",
      status: "graded",
      passed: true,
      score: 1,
      rawValue: 1,
      details: { checks: [] },
    };
    const { result } = normalizeRecord(
      {
        ...base,
        components: [
          { metric: "field_answer", pass: true, score: 1, graderError: false, stageflow },
          { metric: "quality", pass: true, score: 4, tokensIn: 10, tokensOut: 5, graderError: false },
        ],
      },
      identity,
      plan,
    );
    expect(result.grades[0]).toEqual(stageflow);
  });

  it("flags an unknown judge price, counts it as zero and reports the model once", () => {
    const outcome = normalizeRecord(
      { ...base, components: [{ metric: "quality", pass: true, score: 4, tokensIn: 10, tokensOut: 5, graderError: false }] },
      identity,
      plan,
    );
    expect(outcome.priceUnknownModels).toEqual(["openai/stub-judge"]);
    expect(outcome.judgeCostUsd).toBe(0);
    expect(outcome.result.grades[1]).toMatchObject({ judgeCostUsd: 0, details: { judgeCostUnknown: true } });
  });

  it("treats an out-of-range 1-5 score as a judge error", () => {
    const { result } = normalizeRecord(
      { ...base, components: [{ metric: "quality", pass: true, score: 9, graderError: false }] },
      identity,
      plan,
    );
    expect(result.grades[1]).toMatchObject({ status: "error", errorCode: "EVAL_JUDGE_ERROR" });
    expect(result.grades[0]).toMatchObject({ status: "error", errorCode: "EVAL_ENGINE_ERROR" });
  });

  it("prefers the echoed repeat index over the test index", () => {
    expect(recordIdentity({ ...base, testIdx: 5, metadata: { caseId: "c2", repeatIndex: 1 } }, plan)).toEqual({
      caseId: "c2",
      repeatIndex: 1,
    });
    expect(recordIdentity({ ...base, caseId: "zzz", metadata: {} }, plan)).toBeUndefined();
  });
});
