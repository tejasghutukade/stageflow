export interface EstimatePreviousRun {
  runNumber: number;
  costStage: number;
  costJudge: number;
  resultsExecuted: number;
  rubricGradesGraded: number;
  wallSeconds: number | null;
}

export interface EstimateRunInput {
  resultsTotal: number;
  rubricGraderCount: number;
  previous: EstimatePreviousRun | null;
  recentStageCosts: number[];
}

export interface RunEstimate {
  estimate_usd: number | null;
  avg_stage_cost: number | null;
  avg_judge_cost: number | null;
  stage_calls: number;
  judge_calls: number;
  judge_excluded: boolean;
  based_on_run_number: number | null;
  estimate_seconds: number | null;
}

export function estimateRun(input: EstimateRunInput): RunEstimate {
  const { previous } = input;
  const stageCalls = input.resultsTotal;
  const judgeCalls = input.resultsTotal * input.rubricGraderCount;

  let avgStage: number | null = null;
  if (previous && previous.resultsExecuted > 0) {
    avgStage = previous.costStage / previous.resultsExecuted;
  } else if (input.recentStageCosts.length > 0) {
    avgStage = input.recentStageCosts.reduce((a, b) => a + b, 0) / input.recentStageCosts.length;
  }

  const avgJudge =
    previous && previous.rubricGradesGraded > 0 ? previous.costJudge / previous.rubricGradesGraded : null;

  const judgeExcluded = judgeCalls > 0 && avgJudge === null;
  const estimate =
    avgStage === null ? null : stageCalls * avgStage + judgeCalls * (avgJudge ?? 0);

  const seconds =
    previous && previous.resultsExecuted > 0 && previous.wallSeconds !== null
      ? (previous.wallSeconds * input.resultsTotal) / previous.resultsExecuted
      : null;

  return {
    estimate_usd: estimate,
    avg_stage_cost: avgStage,
    avg_judge_cost: avgJudge,
    stage_calls: stageCalls,
    judge_calls: judgeCalls,
    judge_excluded: judgeExcluded,
    based_on_run_number: previous ? previous.runNumber : null,
    estimate_seconds: seconds,
  };
}
