import { describe, expect, it } from "vitest";
import type { EvalCompareResult, EvalStats } from "../../../api/evalTypes";
import { fixtureStats } from "../results/fixtures";
import {
  agentDiffSummary,
  agentIdOfRun,
  agentSettingChanges,
  buildAgentDiff,
  buildKpiTiles,
  buildStrip,
  isAgentCompare,
} from "./compareModel";

function result(overrides: Partial<EvalCompareResult> = {}): EvalCompareResult {
  const stats = (extra: Partial<EvalStats> = {}) => fixtureStats(extra);
  return {
    shared_cases: 24,
    cases_a: 24,
    cases_b: 24,
    mean_difference: 0.04,
    ci: { low: -0.02, high: 0.1 },
    verdict: "no_clear_difference",
    cases: [],
    graders: [],
    deltas: {
      cost_per_result: { a: 0.01, b: 0.012, delta: 0.002, percent_change: null },
      latency_p50: { a: 3000, b: 3500, delta: 500, percent_change: null },
      latency_p95: { a: 6000, b: 7000, delta: 1000, percent_change: null },
      flaky_cases: { a: 4, b: 3, delta: -1, percent_change: null },
      mean_score: { a: 0.8, b: 0.84, delta: 0.04, percent_change: null },
      mean_turns: { a: 3.2, b: 4.1, delta: 0.9, percent_change: null },
      mean_tool_calls: { a: 2, b: 2, delta: 0, percent_change: null },
    },
    stage_diff: null,
    agent_diff: {
      changed_keys: ["instructions"],
      instructions_diff: [
        { op: "same", text: "You are a support agent." },
        { op: "remove", text: "Be brief." },
        { op: "add", text: "Be thorough." },
      ],
      revision: { a: 2, b: 4 },
    },
    components: [
      { key: "stage", status: "changed", a: "a1b2c3d4e5f6", b: "b2c3d4e5f6a1" },
      { key: "dataset", status: "same", a: "9b41c0ffff", b: "9b41c0ffff" },
      { key: "agent", status: "same", a: { revision: 2, mode: "simulated", max_turns: 8, tools: "read_only", approvals: "record_only", user_model: "m/u" }, b: { revision: 4, mode: "simulated", max_turns: 8, tools: "read_only", approvals: "record_only", user_model: "m/u" } },
    ],
    same_config: false,
    warnings: [],
    sd_d: 0.1,
    cases_needed_5pts: 40,
    stats_a: stats(),
    stats_b: stats(),
    ...overrides,
  };
}

describe("agent compare", () => {
  it("recognises two agent runs", () => {
    expect(isAgentCompare(result())).toBe(true);
    const stage = result();
    delete stage.deltas.mean_turns;
    delete stage.deltas.mean_tool_calls;
    stage.agent_diff = null;
    expect(isAgentCompare(stage)).toBe(false);
  });

  it("adds Turns and Tool calls deltas without a verdict", () => {
    const tiles = buildKpiTiles(result());
    expect(tiles.map((t) => t.key)).toEqual(["pass_rate", "mean_score", "flaky", "latency_p50", "cost", "mean_turns", "mean_tool_calls"]);
    expect(tiles[5]).toEqual({ key: "mean_turns", label: "Turns", value: "3.2 → 4.1", sub: "+0.9 per conversation", subTone: "muted" });
    expect(tiles[6]).toMatchObject({ value: "2 → 2", sub: "no change", subTone: "muted" });
  });

  it("leaves a stage compare with its five tiles", () => {
    const stage = result();
    delete stage.deltas.mean_turns;
    delete stage.deltas.mean_tool_calls;
    expect(buildKpiTiles(stage).map((t) => t.key)).toEqual(["pass_rate", "mean_score", "flaky", "latency_p50", "cost"]);
  });
});

describe("agent diff card", () => {
  it("names the agent, the revisions and the instruction lines", () => {
    const card = buildAgentDiff(result(), "support", false);
    expect(card).toMatchObject({
      title: "What changed in agent support",
      hashes: "r2 → r4",
      canExpand: true,
      summary: "Instructions edited · model, tools and limits unchanged",
    });
    expect(card?.lines.map((l) => l.op)).toEqual(["remove", "add"]);
    expect(buildAgentDiff(result(), "support", true)?.lines).toHaveLength(3);
  });

  it("collapses long diffs to twelve changed lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ op: "add" as const, text: `line ${i}` }));
    const r = result();
    r.agent_diff = { changed_keys: ["instructions"], instructions_diff: lines, revision: { a: 1, b: 2 } };
    const card = buildAgentDiff(r, null, false);
    expect(card?.title).toBe("What changed in the agent");
    expect(card?.lines).toHaveLength(12);
    expect(card?.canExpand).toBe(true);
  });

  it("is hidden when the agent did not change", () => {
    expect(buildAgentDiff(result({ agent_diff: null }), "support", false)).toBeNull();
  });

  it("summarises other changed keys", () => {
    expect(agentDiffSummary(["model", "tools"])).toBe("model changed, tools changed · limits unchanged");
    expect(agentDiffSummary(["instructions", "model", "tools", "limits"])).toBe("Instructions edited, model changed, tools changed, limits changed");
    expect(agentDiffSummary([])).toBe("Agent changed");
  });

  it("reads the agent id from a run snapshot", () => {
    expect(agentIdOfRun({ config: { target: { kind: "agent", agent_id: "support" } } })).toBe("support");
    expect(agentIdOfRun(null)).toBeNull();
  });
});

describe("held constant and changed strip", () => {
  it("holds the conversation settings that stayed the same", () => {
    const strip = buildStrip(result());
    expect(strip.held).toContain("tool policy read_only · approvals record_only · mode simulated · 8 turns · user model m/u");
    expect(strip.changed).toEqual(["agent definition a1b2c3 to b2c3d4"]);
    expect(strip.amber).toBe(false);
  });

  it("names tool policy, approvals, mode, max turns and user model when they differ, in amber", () => {
    const changed = result({
      components: [
        { key: "agent", status: "changed", a: { revision: 2, mode: "script", max_turns: 8, tools: "read_only", approvals: "record_only", user_model: null }, b: { revision: 4, mode: "simulated", max_turns: 12, tools: "mocked", approvals: "deny", user_model: "m/u" } },
      ],
    });
    const strip = buildStrip(changed);
    expect(strip.amber).toBe(true);
    expect(strip.changed).toEqual([
      "tool policy read_only to mocked",
      "approvals record_only to deny",
      "mode script to simulated",
      "max turns 8 to 12",
      "user model none to m/u",
    ]);
    expect(agentSettingChanges({ tools: "read_only" }, { tools: "read_only" })).toEqual([]);
  });

  it("is untouched for stage compares", () => {
    const stage: EvalCompareResult = result({
      agent_diff: null,
      deltas: { cost_per_result: { a: 1, b: 1, delta: 0, percent_change: null }, latency_p50: { a: 1, b: 1, delta: 0, percent_change: null }, latency_p95: { a: 1, b: 1, delta: 0, percent_change: null }, flaky_cases: { a: 0, b: 0, delta: 0, percent_change: null }, mean_score: { a: 1, b: 1, delta: 0, percent_change: null } },
      components: [{ key: "stage", status: "changed", a: "3f9a1c0000", b: "a82e07ffff" }],
    });
    expect(buildStrip(stage).changed).toEqual(["stage version 3f9a1c to a82e07"]);
  });
});
