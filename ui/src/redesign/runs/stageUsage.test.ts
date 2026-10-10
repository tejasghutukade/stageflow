import { describe, expect, it } from "vitest";
import {
  formatTokenCount,
  formatWaitDuration,
  runSlotLabel,
  stagePrimaryModel,
  stageTokenTotals,
} from "./stageUsage";

const usage = {
  costUsd: 0.1,
  models: {
    "anthropic/claude-sonnet-4-5": {
      inputTokens: 12000,
      outputTokens: 2000,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 400,
      costUsd: 0.08,
    },
    "openai/gpt-5": {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.02,
    },
  },
};

describe("stageUsage", () => {
  it("picks the model with the most input+output tokens", () => {
    expect(stagePrimaryModel({ usage })).toBe("anthropic/claude-sonnet-4-5");
    expect(stagePrimaryModel({})).toBeNull();
  });

  it("sums tokens with cache on the input side", () => {
    expect(stageTokenTotals({ usage })).toEqual({ input: 16900, output: 2100 });
    expect(stageTokenTotals({})).toBeNull();
  });

  it("formats token counts", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(18400)).toBe("18.4k");
    expect(formatTokenCount(18000)).toBe("18k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("formats wait durations with padded seconds", () => {
    expect(formatWaitDuration(45_000)).toBe("45s");
    expect(formatWaitDuration(360_000)).toBe("6m 00s");
  });

  it("labels the held slot only when the run is active", () => {
    expect(runSlotLabel("b", { activeRunIds: ["a", "b"], maxConcurrent: 4 })).toBe("slot 2 of 4");
    expect(runSlotLabel("b", { activeRunIds: ["a", "b"], maxConcurrent: 0 })).toBe("holding a slot");
    expect(runSlotLabel("c", { activeRunIds: ["a"], maxConcurrent: 4 })).toBeNull();
    expect(runSlotLabel("c", null)).toBeNull();
  });
});
