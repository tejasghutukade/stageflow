import type { CompactionStrategy } from "../types.js";
import { piSummarize } from "./pi.js";

export const baseline: CompactionStrategy = {
  id: "baseline",
  description: "Pi default summarizer, exactly the inputs Pi uses for auto-compaction.",
  summarize: (input) => piSummarize(input),
};
