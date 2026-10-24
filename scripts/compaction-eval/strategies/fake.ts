import { messageText } from "../scenarios/builder.js";
import type { CompactionStrategy } from "../types.js";

export const fake: CompactionStrategy = {
  id: "fake",
  description: "Deterministic offline strategy for tests: the head of every message, capped. No network.",
  async summarize({ messages, previousSummary }) {
    const parts = messages.map((m) => `[${m.role}] ${messageText(m).slice(0, 200).replace(/\s+/g, " ")}`);
    const summary = [previousSummary, ...parts].filter(Boolean).join("\n").slice(0, 8000);
    return { summary, usageCostUsd: 0, tokensIn: 0, tokensOut: Math.ceil(summary.length / 4) };
  },
};
