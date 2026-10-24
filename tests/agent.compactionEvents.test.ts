import { describe, expect, it } from "vitest";
import {
  addCompactionUsage,
  compactionActivityEvent,
  type CompactionEndSessionEvent,
} from "../src/agent/compactionEvents.js";
import { emptyStageUsage } from "../src/types/usage.js";

const end: CompactionEndSessionEvent = {
  type: "compaction_end",
  reason: "threshold",
  result: {
    summary: "x".repeat(120),
    tokensBefore: 150000,
    usage: { input: 1000, output: 200, cacheRead: 5, cacheWrite: 7, cost: { total: 0.004 } },
  },
  aborted: false,
  willRetry: false,
};

describe("compactionActivityEvent", () => {
  it("maps a finished compaction", () => {
    expect(compactionActivityEvent(end, 30000)).toEqual({
      event: "context_compacted",
      reason: "threshold",
      tokensBefore: 150000,
      tokensAfter: 30000,
      summaryChars: 120,
      costUsd: 0.004,
      willRetry: false,
      aborted: false,
    });
  });

  it("handles aborted or failed compaction", () => {
    const ev = compactionActivityEvent(
      { type: "compaction_end", reason: "overflow", result: undefined, aborted: true, willRetry: true, errorMessage: "boom" },
      null,
    );
    expect(ev).toMatchObject({ tokensAfter: null, tokensBefore: 0, costUsd: 0, aborted: true, willRetry: true, error: "boom" });
  });
});

describe("addCompactionUsage", () => {
  it("charges the compaction call to the model that ran it", () => {
    const usage = emptyStageUsage();
    usage.costUsd = 0.01;
    usage.models["m1"] = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.01 };
    addCompactionUsage(usage, "m1", end);
    expect(usage.costUsd).toBeCloseTo(0.014);
    expect(usage.models["m1"]).toMatchObject({ inputTokens: 1001, outputTokens: 201, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 });
    expect(usage.models["m1"]!.costUsd).toBeCloseTo(0.014);
  });

  it("ignores events without usage", () => {
    const usage = emptyStageUsage();
    addCompactionUsage(usage, "m1", { ...end, result: undefined });
    expect(usage.costUsd).toBe(0);
  });
});
