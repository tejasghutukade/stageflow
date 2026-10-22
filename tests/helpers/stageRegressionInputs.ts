import type { ComponentsInput, SnapshotInput } from "../../src/evals/snapshot.js";
import type { ComputeStatsInput } from "../../src/evals/stats.js";
import type { GradeRecord, ResultRecord } from "../../src/evals/statsTypes.js";

/** Fixed stage-eval inputs for the release 2 regression gate. Do not edit: the golden file was produced from release 1 code. */
export function stageRegressionInputs(): { stats: ComputeStatsInput; components: ComponentsInput; snapshot: SnapshotInput } {
  const result = (
    caseId: string,
    repeatIndex: number,
    status: ResultRecord["status"],
    passed: 0 | 1,
    score: number | null,
    latencyMs: number | null,
    costUsd: number | null,
  ): ResultRecord => ({ caseId, repeatIndex, status, latencyMs, costUsd, tokensIn: 100, tokensOut: 20, score, passed });
  const grade = (caseId: string, repeatIndex: number, graderId: string, graderType: string, passed: 0 | 1, rawValue: number): GradeRecord => ({
    caseId,
    repeatIndex,
    graderId,
    graderType,
    status: "graded",
    passed,
    score: passed,
    rawValue,
    judgeCostUsd: graderType === "rubric" ? 0.002 : null,
    judgeTokensIn: graderType === "rubric" ? 50 : null,
    judgeTokensOut: graderType === "rubric" ? 5 : null,
  });
  const results: ResultRecord[] = [
    result("c1", 0, "completed", 1, 1, 120, 0.01),
    result("c1", 1, "completed", 1, 1, 140, 0.01),
    result("c2", 0, "completed", 1, 0.9, 200, 0.012),
    result("c2", 1, "completed", 0, 0.4, 260, 0.012),
    result("c3", 0, "stage_failed", 0, null, 90, 0.004),
    result("c3", 1, "stage_failed", 0, null, 95, 0.004),
    result("c4", 0, "completed", 0, 0.2, 310, 0.02),
    result("c4", 1, "completed", 0, 0.3, 330, 0.02),
  ];
  const grades: GradeRecord[] = [];
  for (const r of results.filter((x) => x.status === "completed")) {
    grades.push(grade(r.caseId, r.repeatIndex, "shape", "schema", r.passed, r.passed));
    grades.push(grade(r.caseId, r.repeatIndex, "quality", "rubric", r.passed, r.passed === 1 ? 5 : 2));
  }
  const graders = [
    { id: "shape", type: "schema", hash: "h-shape" },
    { id: "quality", type: "rubric", hash: "h-quality" },
  ];
  const components: ComponentsInput = {
    stageVersionHash: "stagehash",
    model: "anthropic/claude-sonnet-4-5",
    datasetHash: "datasethash",
    caseIds: ["c4", "c3", "c2", "c1"],
    graders: [
      { id: "quality", hash: "h-quality" },
      { id: "shape", hash: "h-shape" },
    ],
    judge: "anthropic/claude-sonnet-4-5",
    repeats: 2,
    passThreshold: 0.8,
    engine: { name: "promptfoo", version: "0.124.0" },
  };
  const snapshot: SnapshotInput = {
    evalId: "regression",
    evalPath: "evals/regression.eval.yaml",
    evalHash: "evalhash",
    evalDefinition: { id: "regression" },
    overrides: { repeats: null, judge: null, model: null, max_cost_usd: null, case_ids: null, tags: null, only_failed_from: null },
    target: {
      pipeline_path: "pipelines/p.pipeline.yaml",
      stage_id: "review",
      file: null,
      stage_version_hash: "stagehash",
      stage_definition: { id: "review" },
      model: "anthropic/claude-sonnet-4-5",
      model_tier: "standard",
      input_schema_hash: "in",
      output_schema_hash: "out",
    },
    dataset: { path: "datasets/d.jsonl", hash: "datasethash", format: "jsonl", case_count: 4, cases_run: 4, cases_skipped: 0, skipped_case_ids: [] },
    graders: [],
    settings: { repeats: 2, pass_threshold: 0.8, judge: "anthropic/claude-sonnet-4-5", judge_same_as_stage: true, max_cost_usd: 1, concurrency: 2, suite_type: "capability" },
    engine: { name: "promptfoo", version: "0.124.0", nodeVersion: "22.22.0" },
    stageflowVersion: "0.40.0",
  };
  return { stats: { results, grades, graders, repeats: 2, passThreshold: 0.8 }, components, snapshot };
}
