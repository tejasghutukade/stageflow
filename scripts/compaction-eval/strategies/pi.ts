import type { SummarizeInput, SummarizeOutput } from "../types.js";

export async function piSummarize(input: SummarizeInput, customInstructions?: string): Promise<SummarizeOutput> {
  const { piModel } = input.model;
  if (!piModel) throw new Error("this strategy needs a real model (not --dry-run)");
  const { generateSummaryWithUsage } = await import("@earendil-works/pi-coding-agent");
  const result = await generateSummaryWithUsage(
    input.messages as never,
    piModel,
    input.model.reserveTokens,
    input.model.apiKey,
    input.model.headers,
    input.signal,
    customInstructions,
    input.previousSummary,
    undefined,
    undefined,
    input.model.env,
  );
  return {
    summary: result.text,
    usageCostUsd: result.usage.cost.total,
    tokensIn: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
    tokensOut: result.usage.output,
  };
}
