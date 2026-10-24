import { describe, expect, it } from "vitest";
import type { EvalListItem } from "../../api/evalTypes";
import { evalRowModel, evalTabs, filterEvals, targetLabelOf } from "./evalListModel";

function base(overrides: Partial<EvalListItem> = {}): EvalListItem {
  return {
    id: "review-findings",
    name: "Review findings",
    description: null,
    type: "capability",
    path: "evals/review-findings.eval.yaml",
    target: { kind: "stage", pipeline_path: "pipelines/p.pipeline.yaml", stage_id: "review", label: "p · review" },
    dataset_path: "datasets/review-diffs.dataset.jsonl",
    dataset_cases: 24,
    repeats: 3,
    grader_count: 2,
    rubric_count: 1,
    valid: true,
    finding_count: 0,
    status: "passing",
    last_run: null,
    last_run_delta_pts: null,
    trend: [],
    ...overrides,
  };
}

const agentEval = (overrides: Partial<EvalListItem> = {}) =>
  base({
    id: "support-eval",
    name: "Support eval",
    path: "evals/support-eval.eval.yaml",
    dataset_path: "datasets/support-cases.dataset.jsonl",
    dataset_cases: 6,
    target: { kind: "agent", agent_id: "support", agent_name: "Support", model: "anthropic/claude-sonnet-4-5", revision: 4, label: "Support" },
    conversation: { mode: "simulated", max_turns: 8, tools: "read_only", approvals: "record_only" },
    ...overrides,
  });

describe("agent rows in the evals list", () => {
  it("shows an Agent chip, the agent with its revision and the model beneath", () => {
    const row = evalRowModel(agentEval());
    expect(row).toMatchObject({ targetKind: "Agent", targetLabel: "Support · r4", targetPath: "anthropic/claude-sonnet-4-5" });
    expect(row.datasetMeta).toBe("Capability · 6 scenarios · 3 repeats");
  });

  it("falls back to the id and drops the revision when the agent is gone", () => {
    const gone = agentEval({ target: { kind: "agent", agent_id: "support", agent_name: "", model: null, revision: null, label: "support" } });
    expect(targetLabelOf(gone)).toBe("support");
    expect(evalRowModel(gone).targetPath).toBe("");
  });

  it("keeps stage rows as they were", () => {
    expect(evalRowModel(base())).toMatchObject({ targetKind: "Stage", targetLabel: "p · review", targetPath: "pipelines/p.pipeline.yaml", datasetMeta: "Capability · 24 cases · 3 repeats" });
  });
});

describe("Agents filter", () => {
  const all = [base(), agentEval()];

  it("stays a placeholder unless agents are live", () => {
    expect(evalTabs(all)[2]).toEqual({ id: "agents", label: "Agents", soon: true });
  });

  it("counts agent evals when live", () => {
    expect(evalTabs(all, true).map((t) => [t.id, t.count])).toEqual([["all", 2], ["stages", 1], ["agents", 1], ["regressed", 0]]);
  });

  it("filters to agent evals, and to one agent", () => {
    expect(filterEvals(all, { tab: "agents", query: "" }).map((i) => i.id)).toEqual(["support-eval"]);
    expect(filterEvals(all, { tab: "stages", query: "" }).map((i) => i.id)).toEqual(["review-findings"]);
    expect(filterEvals(all, { tab: "all", query: "", agent: "support" }).map((i) => i.id)).toEqual(["support-eval"]);
    expect(filterEvals(all, { tab: "all", query: "", agent: "other" })).toEqual([]);
    expect(filterEvals(all, { tab: "all", query: "support" }).map((i) => i.id)).toEqual(["support-eval"]);
  });
});
