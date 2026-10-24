import type { StageActivityEvent } from "./activity.js";
import { addModelUsage, type StageUsage } from "../types/usage.js";

export type CompactionEndSessionEvent = {
  type: "compaction_end";
  reason: "manual" | "threshold" | "overflow";
  result?: {
    summary?: string;
    tokensBefore?: number;
    estimatedTokensAfter?: number;
    usage?: CompactionUsage;
  };
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
};

export type CompactionUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

export type CompactionCost = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function compactionUsageCost(event: CompactionEndSessionEvent): CompactionCost {
  const u = event.result?.usage;
  return {
    inputTokens: u?.input ?? 0,
    outputTokens: u?.output ?? 0,
    costUsd: u?.cost?.total ?? 0,
  };
}

export function compactionActivityEvent(
  event: CompactionEndSessionEvent,
  tokensAfter: number | null,
): Extract<StageActivityEvent, { event: "context_compacted" }> {
  const result = event.result;
  return {
    event: "context_compacted",
    reason: event.reason,
    tokensBefore: result?.tokensBefore ?? 0,
    tokensAfter: tokensAfter ?? result?.estimatedTokensAfter ?? null,
    summaryChars: result?.summary?.length ?? 0,
    costUsd: compactionUsageCost(event).costUsd,
    willRetry: event.willRetry ?? false,
    aborted: event.aborted ?? false,
    ...(event.errorMessage ? { error: event.errorMessage } : {}),
  };
}

export function addCompactionUsage(
  usage: StageUsage,
  model: string | undefined,
  event: CompactionEndSessionEvent,
): void {
  const u = event.result?.usage;
  if (!u || !model) return;
  addModelUsage(usage, model, {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadInputTokens: u.cacheRead,
    cacheCreationInputTokens: u.cacheWrite,
    costUsd: u.cost?.total ?? 0,
  });
}
