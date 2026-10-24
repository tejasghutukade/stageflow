import { COMPACTION_FOCUS, composeCompactionSummary } from "../../../src/compaction/summarize.js";
import type { ClearingPolicy } from "../../../src/compaction/mask.js";
import type { CompactionStrategy } from "../types.js";
import { piSummarize } from "./pi.js";

function make(id: string, description: string, opts: { focus: boolean; clear?: ClearingPolicy }): CompactionStrategy {
  return {
    id,
    description,
    async summarize(input) {
      const composed = await composeCompactionSummary({
        messages: input.messages as never,
        ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
        state: [],
        ...(opts.clear ? { clearInSummary: opts.clear } : {}),
        summarize: ({ messages, previousSummary }) =>
          piSummarize({ ...input, messages: messages as never, ...(previousSummary !== undefined ? { previousSummary } : {}) }, opts.focus ? COMPACTION_FOCUS : undefined),
      });
      return { ...composed.result, summary: composed.summary };
    },
  };
}

const CLEAR_ALL_OLD: ClearingPolicy = { keepRecentTurns: 0, minBytes: 2000 };

export const stageflowPins = make("sf-pins", "Pi default prompt plus deterministic pinned facts.", { focus: false });
export const stageflowFocusPins = make("sf-focus-pins", "Stageflow focus prompt plus pinned facts.", { focus: true });
export const stageflowFull = make("sf-full", "Focus prompt, pinned facts, and stale tool results cleared in the summarizer input.", {
  focus: true,
  clear: CLEAR_ALL_OLD,
});
