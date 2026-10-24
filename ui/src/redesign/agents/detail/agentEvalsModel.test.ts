import { describe, expect, it } from "vitest";
import type { EvalListItem } from "../../../api";
import { AGENT_EVALS_GUIDANCE, agentEvaluateHref, buildAgentEvalsModel } from "./agentEvalsModel";

const NOW = Date.parse("2026-10-22T12:00:00Z");

function item(id: string, extra: Record<string, unknown> = {}): EvalListItem {
  return {
    id,
    name: id,
    description: null,
    type: "capability",
    path: `evals/${id}.eval.yaml`,
    target: { kind: "agent", agent_id: "support", agent_name: "Support", model: null, revision: 2, label: "support" },
    dataset_path: "d.dataset.jsonl",
    dataset_cases: 3,
    repeats: 1,
    grader_count: 1,
    rubric_count: 0,
    valid: true,
    finding_count: 0,
    status: "passing",
    last_run: null,
    last_run_delta_pts: null,
    trend: [],
    ...extra,
  } as EvalListItem;
}

describe("agentEvaluateHref", () => {
  it("one eval opens its Run dialog", () => {
    expect(agentEvaluateHref("support", ["a"])).toBe("/evals/a?openRun=1");
  });
  it("none goes to the wizard preselected for the agent", () => {
    expect(agentEvaluateHref("support", [])).toBe("/evals/new?agent=support");
  });
  it("two or more go to the filtered list", () => {
    expect(agentEvaluateHref("support", ["a", "b"])).toBe("/evals?agent=support");
  });
});

describe("buildAgentEvalsModel", () => {
  it("rows for two evals with guidance", () => {
    const model = buildAgentEvalsModel(
      "support",
      [item("a", { last_run: { finished_at: "2026-10-22T10:00:00Z", pass_rate: 0.5 } }), item("b", { dataset_cases: 1 })],
      NOW,
    );
    expect(model.total).toBe(2);
    expect(model.rows[0]!.meta).toContain("3 cases · last run");
    expect(model.rows[0]!.passRateLabel).toBe("50.0%");
    expect(model.rows[1]!.meta).toBe("1 case · never run");
    expect(model.rows[1]!.passRate).toBeNull();
    expect(model.evaluateHref).toBe("/evals?agent=support");
    expect(model.guidance).toBe(AGENT_EVALS_GUIDANCE);
  });

  it("empty state sends Evaluate to the wizard and has no guidance", () => {
    const model = buildAgentEvalsModel("support", [], NOW);
    expect(model.total).toBe(0);
    expect(model.evaluateHref).toBe("/evals/new?agent=support");
    expect(model.newEvalHref).toBe("/evals/new?agent=support");
    expect(model.guidance).toBeNull();
  });

  it("ignores evals of other agents and stages", () => {
    const other = item("x", { target: { kind: "agent", agent_id: "other", agent_name: "O", model: null, revision: 1, label: "o" } });
    const stage = item("y", { target: { kind: "stage", label: "s" } });
    expect(buildAgentEvalsModel("support", [other, stage], NOW).total).toBe(0);
  });
});
