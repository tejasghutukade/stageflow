import {
  compact as piCompact,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { applyClearing, planClearing, type ClearingPolicy } from "./mask.js";
import {
  COMPACTION_FOCUS,
  composeCompactionSummary,
  readStageflowDetails,
  stageflowDetails,
  type StageflowCompactionDetails,
} from "./summarize.js";
import { getWorkingStateSections } from "./workingState.js";
import type { LooseMessage } from "./pin.js";

export type CompactionPolicy = {
  /** Clear stale re-fetchable tool results in the text the summarizer reads. */
  clearInSummary?: ClearingPolicy;
  /** Clear stale re-fetchable tool results in every request once the window is this full (0-1). */
  preemptive?: { usageFraction: number; policy: ClearingPolicy };
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {};

type CompactFn = typeof piCompact;
type CompactionPreparation = Parameters<typeof piCompact>[0];

export type CompactionExtensionOptions = {
  policy?: CompactionPolicy;
  compact?: CompactFn;
  onWarn?: (message: string) => void;
};

type PreCompactContext = {
  model: { provider?: string; id?: string } | undefined;
  thinkingLevel?: unknown;
  modelRegistry: { getApiKeyAndHeaders(model: never): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } | { ok: false; error: string }> };
  sessionManager: { getEntries(): readonly unknown[] };
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
};

function lastCompactionDetails(branch: readonly unknown[]): StageflowCompactionDetails | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as { type?: string; details?: unknown };
    if (e?.type === "compaction") return readStageflowDetails(e.details);
  }
  return undefined;
}

export function createCompactionExtension(options: CompactionExtensionOptions = {}): ExtensionFactory {
  const policy = options.policy ?? DEFAULT_COMPACTION_POLICY;
  const compact = options.compact ?? piCompact;
  const warn = options.onWarn ?? (() => {});

  return (pi) => {
    pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, rawCtx) => {
      const ctx = rawCtx as unknown as PreCompactContext;
      const model = ctx.model;
      if (!model) return undefined;
      try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
        if (!auth.ok) return undefined;
        const { preparation } = event;
        const previousDetails = lastCompactionDetails(event.branchEntries);
        const historyCount = preparation.messagesToSummarize.length;
        const composed = await composeCompactionSummary({
          messages: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages] as LooseMessage[],
          ...(preparation.previousSummary !== undefined ? { previousSummary: preparation.previousSummary } : {}),
          ...(previousDetails ? { previousDetails } : {}),
          state: getWorkingStateSections(ctx.sessionManager.getEntries() as never),
          ...(policy.clearInSummary ? { clearInSummary: policy.clearInSummary } : {}),
          summarize: ({ messages, previousSummary }) =>
            compact(
              {
                ...preparation,
                messagesToSummarize: messages.slice(0, historyCount) as CompactionPreparation["messagesToSummarize"],
                turnPrefixMessages: messages.slice(historyCount) as CompactionPreparation["turnPrefixMessages"],
                ...(previousSummary !== undefined ? { previousSummary } : {}),
              },
              model as never,
              auth.apiKey,
              auth.headers,
              COMPACTION_FOCUS,
              event.signal,
              ctx.thinkingLevel as never,
              undefined,
              auth.env,
            ),
        });
        const { result, prepared } = composed;
        return {
          compaction: {
            summary: composed.summary,
            firstKeptEntryId: result.firstKeptEntryId,
            tokensBefore: result.tokensBefore,
            ...(result.usage ? { usage: result.usage } : {}),
            details: stageflowDetails(result.details as never, previousDetails, prepared.pinned, prepared.cleared, prepared.directives),
          },
        };
      } catch (err) {
        if (event.signal.aborted) throw err;
        warn(`stageflow compaction fell back to Pi default: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    });

    const preemptive = policy.preemptive;
    if (preemptive) {
      pi.on("context", async (event, rawCtx) => {
        const ctx = rawCtx as unknown as PreCompactContext;
        const usage = ctx.getContextUsage();
        if (!usage || usage.tokens === null || usage.contextWindow <= 0) return undefined;
        if (usage.tokens / usage.contextWindow < preemptive.usageFraction) return undefined;
        const plan = planClearing(event.messages as unknown as LooseMessage[], preemptive.policy);
        if (plan.cleared.length === 0) return undefined;
        return { messages: applyClearing(event.messages as unknown as LooseMessage[], plan) as never };
      });
    }
  };
}
