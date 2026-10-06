/** Per-model token/cost breakdown, as computed by the backend SDK itself. */
export type ModelUsageBreakdown = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
};

/** Accumulated LLM usage/cost for one stage attempt, across every turn/call it made. */
export type StageUsage = {
  costUsd: number;
  models: Record<string, ModelUsageBreakdown>;
};

function emptyBreakdown(): ModelUsageBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

/** Merge one model's usage from a single call into an accumulator, in place. */
export function addModelUsage(
  usage: StageUsage,
  model: string,
  delta: Partial<ModelUsageBreakdown>,
): void {
  const current = usage.models[model] ?? emptyBreakdown();
  usage.models[model] = {
    inputTokens: current.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: current.outputTokens + (delta.outputTokens ?? 0),
    cacheReadInputTokens: current.cacheReadInputTokens + (delta.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      current.cacheCreationInputTokens + (delta.cacheCreationInputTokens ?? 0),
    costUsd: current.costUsd + (delta.costUsd ?? 0),
  };
  usage.costUsd += delta.costUsd ?? 0;
}

export function emptyStageUsage(): StageUsage {
  return { costUsd: 0, models: {} };
}
