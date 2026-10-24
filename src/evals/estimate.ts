export interface EstimatePreviousRun {
  runNumber: number;
  costStage: number;
  costJudge: number;
  resultsExecuted: number;
  rubricGradesGraded: number;
  wallSeconds: number | null;
}

export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const AGENT_ESTIMATE_ASSUMPTIONS = {
  maxTurnsCap: 6,
  toolCallsPerTurn: 2,
  agentCall: { tokensIn: 2000, tokensOut: 200 },
  simulatorCall: { tokensIn: 1000, tokensOut: 60 },
  judgeCall: { tokensIn: 3000, tokensOut: 100 },
} as const;

export interface AgentEstimateBlock {
  turnsPerCase: number;
  simulatorCallsPerCase: number;
  judgeTranscriptTokens: number;
  agentPrice?: TokenPrice | null;
  simulatorPrice?: TokenPrice | null;
  judgePrice?: TokenPrice | null;
}

export interface EstimateRunInput {
  resultsTotal: number;
  rubricGraderCount: number;
  previous: EstimatePreviousRun | null;
  recentStageCosts: number[];
  agent?: AgentEstimateBlock;
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
  simulator_calls?: number;
  estimate_basis?: "previous_run" | "assumptions" | null;
}

function callCost(price: TokenPrice, tokensIn: number, tokensOut: number): number {
  return (tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000;
}

function assumedAgentCosts(agent: AgentEstimateBlock): { stage: number | null; judge: number | null } {
  const a = AGENT_ESTIMATE_ASSUMPTIONS;
  const agentCalls = agent.turnsPerCase * (1 + a.toolCallsPerTurn);
  let stage: number | null = null;
  if (agent.agentPrice && (agent.simulatorCallsPerCase === 0 || agent.simulatorPrice)) {
    stage = agentCalls * callCost(agent.agentPrice, a.agentCall.tokensIn, a.agentCall.tokensOut);
    if (agent.simulatorPrice) {
      stage += agent.simulatorCallsPerCase * callCost(agent.simulatorPrice, a.simulatorCall.tokensIn, a.simulatorCall.tokensOut);
    }
  }
  const judge = agent.judgePrice
    ? callCost(agent.judgePrice, agent.judgeTranscriptTokens, a.judgeCall.tokensOut)
    : null;
  return { stage, judge };
}

export function estimateRun(input: EstimateRunInput): RunEstimate {
  const { previous } = input;
  const stageCalls = input.resultsTotal;
  const judgeCalls = input.resultsTotal * input.rubricGraderCount;

  const usePrevious = previous !== null && previous.resultsExecuted > 0;
  const assumed = input.agent && !usePrevious ? assumedAgentCosts(input.agent) : null;

  let avgStage: number | null = null;
  if (usePrevious) {
    avgStage = previous.costStage / previous.resultsExecuted;
  } else if (input.agent) {
    avgStage = assumed?.stage ?? null;
  } else if (input.recentStageCosts.length > 0) {
    avgStage = input.recentStageCosts.reduce((a, b) => a + b, 0) / input.recentStageCosts.length;
  }

  const avgJudge =
    previous && previous.rubricGradesGraded > 0
      ? previous.costJudge / previous.rubricGradesGraded
      : (assumed?.judge ?? null);

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
    based_on_run_number: input.agent && !usePrevious ? null : previous ? previous.runNumber : null,
    estimate_seconds: seconds,
    ...(input.agent
      ? {
          simulator_calls: input.resultsTotal * input.agent.simulatorCallsPerCase,
          estimate_basis: usePrevious ? ("previous_run" as const) : avgStage !== null ? ("assumptions" as const) : null,
        }
      : {}),
  };
}
