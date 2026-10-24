import { describe, expect, it } from "vitest";
import { compareRuns, CompareMismatchError, type CompareRunInput } from "../../src/evals/compare.js";
import { AGENT_ESTIMATE_ASSUMPTIONS, estimateRun } from "../../src/evals/estimate.js";
import { computeStats } from "../../src/evals/stats.js";
import { toResultRecord } from "../../src/evals/statsAdapter.js";
import type { ResultRecord } from "../../src/evals/statsTypes.js";
import type { EvalResultRow } from "../../src/evals/storeTypes.js";
import { mkResults } from "./helpers.js";

function agentResults(): ResultRecord[] {
  const base = mkResults("c", [true, true, true, true]);
  const turns = [2, 4, null, 6];
  const calls = [1, 3, null, 5];
  return base.map((r, i) => ({
    ...r,
    ...(i === 2 ? { status: "error" as const, score: null, passed: 0 as const } : {}),
    turns: turns[i],
    toolCalls: calls[i],
  }));
}

function input(results: ResultRecord[], extra: Partial<CompareRunInput> = {}): CompareRunInput {
  return {
    evalId: "e",
    runNumber: 1,
    datasetHash: "d",
    stageVersionHash: "s",
    stageDefinition: null,
    configComponents: { stage: "s" },
    results,
    grades: [],
    graders: [],
    repeats: 4,
    passThreshold: 0.8,
    ...extra,
  };
}

const stats = (results: ResultRecord[], targetKind?: "agent") =>
  computeStats({ results, grades: [], graders: [], repeats: 4, passThreshold: 0.8, ...(targetKind ? { targetKind } : {}) });

describe("agent stats", () => {
  it("mean_turns of [2,4,null,6] with one errored = 4; mean_tool_calls of [1,3,null,5] = 3", () => {
    const s = stats(agentResults());
    expect(s.mean_turns).toBe(4);
    expect(s.mean_tool_calls).toBe(3);
  });

  it("ignores turns of results that were not executed", () => {
    const rs = agentResults();
    rs.push({ ...rs[0], caseId: "d", status: "skipped_budget", turns: 100, toolCalls: 100 });
    const s = stats(rs);
    expect(s.mean_turns).toBe(4);
    expect(s.mean_tool_calls).toBe(3);
  });

  it("agent run without any value gives null, not a missing key", () => {
    const s = stats(mkResults("c", [true]), "agent");
    expect(s.mean_turns).toBeNull();
    expect(s.mean_tool_calls).toBeNull();
  });

  it("stage stats keep exactly their keys", () => {
    const s = stats(mkResults("c", [true, false]));
    expect(Object.keys(s)).not.toContain("mean_turns");
    expect(Object.keys(s)).not.toContain("mean_tool_calls");
  });

  it("toResultRecord copies turns and tool calls only when present", () => {
    const row = {
      caseId: "c", repeatIndex: 0, status: "completed", latencyMs: 1, costUsd: 1, tokensIn: 1, tokensOut: 1,
      score: 1, passed: true, turns: 3, toolCallCount: 2,
    } as EvalResultRow;
    expect(toResultRecord(row)).toMatchObject({ turns: 3, toolCalls: 2 });
    const stage = toResultRecord({ ...row, turns: null, toolCallCount: null });
    expect("turns" in stage).toBe(false);
    expect("toolCalls" in stage).toBe(false);
  });
});

describe("agent compare", () => {
  const agent = (results: ResultRecord[], extra: Partial<CompareRunInput> = {}) =>
    input(results, { targetKind: "agent", agentId: "support", agentRevision: 1, agentDefinition: { instructions: "a" }, ...extra });

  it("adds mean_turns and mean_tool_calls deltas for agent pairs", () => {
    const a = agentResults();
    const b = agentResults().map((r) => ({ ...r, turns: r.turns === null ? null : r.turns + 1, toolCalls: r.toolCalls }));
    const r = compareRuns(agent(a), agent(b));
    expect(r.deltas.mean_turns).toEqual({ a: 4, b: 5, delta: 1, percent_change: 25 });
    expect(r.deltas.mean_tool_calls).toEqual({ a: 3, b: 3, delta: 0, percent_change: 0 });
    expect(r.stage_diff).toBeNull();
  });

  it("stage pairs carry neither delta nor agent_diff", () => {
    const r = compareRuns(input(mkResults("c", [true])), input(mkResults("c", [true])));
    expect(Object.keys(r.deltas)).not.toContain("mean_turns");
    expect("agent_diff" in r).toBe(false);
  });

  it("agent_diff names changed keys, an instructions line diff and both revisions", () => {
    const a = agent(agentResults(), {
      stageVersionHash: "h1",
      agentRevision: 3,
      agentDefinition: { instructions: "one\ntwo", model: { id: "m" } },
    });
    const b = agent(agentResults(), {
      stageVersionHash: "h2",
      agentRevision: 4,
      agentDefinition: { instructions: "one\nthree", model: { id: "m" } },
    });
    const r = compareRuns(a, b);
    expect(r.agent_diff).toEqual({
      changed_keys: ["instructions"],
      instructions_diff: [
        { op: "same", text: "one" },
        { op: "remove", text: "two" },
        { op: "add", text: "three" },
      ],
      revision: { a: 3, b: 4 },
    });
    expect(r.stage_diff).toBeNull();
  });

  it("agent_diff is null when the definition hashes match", () => {
    expect(compareRuns(agent(agentResults()), agent(agentResults())).agent_diff).toBeNull();
  });

  it("a stage run and an agent run mismatch", () => {
    const stage = input(mkResults("c", [true]));
    expect(() => compareRuns(stage, agent(agentResults()))).toThrow(CompareMismatchError);
    expect(() => compareRuns(agent(agentResults()), stage)).toThrow(CompareMismatchError);
  });

  it("two different agents mismatch", () => {
    expect(() => compareRuns(agent(agentResults()), agent(agentResults(), { agentId: "other" }))).toThrow(
      CompareMismatchError,
    );
  });
});

describe("agent estimate", () => {
  const price = { inputPerMillion: 1, outputPerMillion: 5 };
  const base = { resultsTotal: 10, rubricGraderCount: 1, recentStageCosts: [] as number[] };

  it("without a previous run applies the fixed assumptions", () => {
    const e = estimateRun({
      ...base,
      previous: null,
      agent: {
        turnsPerCase: 2,
        simulatorCallsPerCase: 1,
        judgeTranscriptTokens: 3000,
        agentPrice: price,
        simulatorPrice: price,
        judgePrice: price,
      },
    });
    // agent: 2 turns * (1 + 2 tool calls) = 6 calls * (2000*1 + 200*5)/1e6 = 6 * 0.003 = 0.018
    // simulator: 1 call * (1000*1 + 60*5)/1e6 = 0.0013
    // judge: (3000*1 + 100*5)/1e6 = 0.0035
    expect(e.avg_stage_cost).toBeCloseTo(0.0193, 12);
    expect(e.avg_judge_cost).toBeCloseTo(0.0035, 12);
    expect(e.estimate_usd).toBeCloseTo(10 * 0.0193 + 10 * 0.0035, 12);
    expect(e.based_on_run_number).toBeNull();
    expect(e.estimate_basis).toBe("assumptions");
    expect(e.simulator_calls).toBe(10);
    expect(e.judge_excluded).toBe(false);
    expect(AGENT_ESTIMATE_ASSUMPTIONS.toolCallsPerTurn).toBe(2);
  });

  it("an unknown agent price makes the estimate null; unknown judge price excludes the judge", () => {
    const e = estimateRun({
      ...base,
      previous: null,
      agent: { turnsPerCase: 2, simulatorCallsPerCase: 0, judgeTranscriptTokens: 3000, agentPrice: null },
    });
    expect(e.estimate_usd).toBeNull();
    expect(e.estimate_basis).toBeNull();
    const f = estimateRun({
      ...base,
      previous: null,
      agent: { turnsPerCase: 1, simulatorCallsPerCase: 0, judgeTranscriptTokens: 3000, agentPrice: price },
    });
    expect(f.estimate_usd).toBeCloseTo(10 * 3 * 0.003, 12);
    expect(f.judge_excluded).toBe(true);
    expect(f.simulator_calls).toBe(0);
  });

  it("with a previous run uses the actual per-result mean", () => {
    const e = estimateRun({
      ...base,
      previous: { runNumber: 4, costStage: 0.5, costJudge: 0.1, resultsExecuted: 5, rubricGradesGraded: 5, wallSeconds: 10 },
      agent: { turnsPerCase: 2, simulatorCallsPerCase: 1, judgeTranscriptTokens: 3000, agentPrice: price },
    });
    expect(e.avg_stage_cost).toBeCloseTo(0.1, 12);
    expect(e.avg_judge_cost).toBeCloseTo(0.02, 12);
    expect(e.estimate_usd).toBeCloseTo(10 * 0.1 + 10 * 0.02, 12);
    expect(e.based_on_run_number).toBe(4);
    expect(e.estimate_basis).toBe("previous_run");
    expect(e.estimate_seconds).toBe(20);
  });

  it("stage estimates have no agent keys", () => {
    const e = estimateRun({ ...base, previous: null, recentStageCosts: [0.2, 0.4] });
    expect(e.estimate_usd).toBeCloseTo(10 * 0.3, 12);
    expect("estimate_basis" in e).toBe(false);
    expect("simulator_calls" in e).toBe(false);
  });
});
