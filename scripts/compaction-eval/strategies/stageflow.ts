import { scrubSecrets } from "../../../src/compaction/pin.js";
import { COMPACTION_FOCUS, prepareSummaryInputs, renderSections } from "../../../src/compaction/summarize.js";
import type { ClearingPolicy } from "../../../src/compaction/mask.js";
import type { CompactionStrategy } from "../types.js";
import { piSummarize } from "./pi.js";

function make(id: string, description: string, opts: { focus: boolean; clear?: ClearingPolicy }): CompactionStrategy {
  return {
    id,
    description,
    async summarize(input) {
      const prepared = prepareSummaryInputs({
        messages: input.messages as never,
        ...(opts.clear ? { clearInSummary: opts.clear } : {}),
      });
      const out = await piSummarize({ ...input, messages: prepared.messagesForSummarizer as never }, opts.focus ? COMPACTION_FOCUS : undefined);
      const sections = renderSections({ pinned: prepared.pinned, cleared: prepared.cleared, state: [], directives: prepared.directives });
      const core = scrubSecrets(out.summary).trimEnd();
      return { ...out, summary: sections ? `${core}\n\n${sections}` : core };
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
