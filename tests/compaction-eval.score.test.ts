import { describe, expect, it } from "vitest";
import { aggregate, runProbes, scoreSummary, stat } from "../scripts/compaction-eval/score.js";
import { createDryRunModel, CostMeter } from "../scripts/compaction-eval/model.js";
import type { Scenario } from "../scripts/compaction-eval/types.js";

const scenario: Scenario = {
  id: "t",
  family: "t",
  description: "t",
  messages: [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "tail answer is KEPT-9" }] },
  ],
  keepTail: 1,
  facts: [
    { id: "a", mustContain: "INC-1", where: "early", critical: true },
    { id: "b", mustContain: /rate=\d+/, where: "mid", critical: true },
    { id: "c", mustContain: "https://x.example/p", where: "late", critical: false },
    { id: "d", mustContain: "late-two", where: "late", critical: false },
  ],
  probes: [
    { question: "Which incident?", expected: /INC-1/, factIds: ["a"] },
    { question: "Which tail value?", expected: /KEPT-9/, factIds: [] },
    { question: "Which url?", expected: /x\.example/, factIds: ["c"] },
  ],
  secrets: ["SECRET-ONE", "SECRET-TWO"],
};

describe("compaction-eval scoring", () => {
  it("scores recall overall, critical and by position", () => {
    const score = scoreSummary(scenario, "Incident INC-1 at rate=40 per sec");
    expect(score.recall).toBe(0.5);
    expect(score.criticalRecall).toBe(1);
    expect(score.recallByPosition).toEqual({ early: 1, mid: 1, late: 0 });
    expect(score.missedFacts).toEqual(["c", "d"]);
  });

  it("counts secret leakage", () => {
    expect(scoreSummary(scenario, "a SECRET-ONE b").leaks).toBe(1);
    expect(scoreSummary(scenario, "SECRET-ONE and SECRET-TWO").leaks).toBe(2);
    expect(scoreSummary(scenario, "nothing").leaks).toBe(0);
  });

  it("returns null ratios for empty fact sets", () => {
    const empty = { ...scenario, facts: [], secrets: [] };
    const score = scoreSummary(empty, "x");
    expect(score.recall).toBeNull();
    expect(score.recallByPosition.early).toBeNull();
  });

  it("runs probes against summary plus kept tail", async () => {
    const model = createDryRunModel(new CostMeter(1));
    const result = await runProbes(scenario, "INC-1 only", model);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.failed).toEqual(["Which url?"]);
  });

  it("aggregates mean, min and max", () => {
    expect(stat([1, 3, null])).toEqual({ mean: 2, min: 1, max: 3, n: 2 });
    expect(stat([])).toBeNull();
    const run = (recall: number) => ({
      ...scoreSummary(scenario, ""),
      recall,
      probePass: 1,
      probeFailed: [],
      summaryCostUsd: 0,
      probeCostUsd: 0,
      totalCostUsd: 0.1,
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 5,
    });
    const agg = aggregate([run(0.2), run(0.6)]);
    expect(agg.recall).toEqual({ mean: 0.4, min: 0.2, max: 0.6, n: 2 });
    expect(agg.totalCostUsd?.mean).toBeCloseTo(0.1);
  });

  it("aborts when the cost cap is exceeded", () => {
    const meter = new CostMeter(0.5);
    meter.add(0.4);
    expect(() => meter.add(0.2)).toThrow(/cost cap/);
  });
});
