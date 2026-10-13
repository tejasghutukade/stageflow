import { describe, expect, it } from "vitest";
import { runUsageSummary } from "./runUsageSummary";

describe("runUsageSummary", () => {
  it("returns null when usage is missing or empty", () => {
    expect(runUsageSummary([])).toBeNull();
    expect(runUsageSummary([{}])).toBeNull();
    expect(
      runUsageSummary([
        {
          usage: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                inputTokens: 0,
                outputTokens: 0,
              },
            },
          },
        },
      ]),
    ).toBeNull();
  });

  it("sums tokens and picks the model with the most input plus output", () => {
    expect(
      runUsageSummary([
        {
          usage: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                inputTokens: 100_000,
                outputTokens: 40_000,
                cacheReadInputTokens: 2_000,
                cacheCreationInputTokens: 600,
              },
            },
          },
        },
        {
          usage: {
            models: {
              "openai/gpt-4.1": {
                inputTokens: 10,
                outputTokens: 5,
              },
              "anthropic/claude-sonnet-4-5": {
                inputTokens: 1_000,
                outputTokens: 0,
              },
            },
          },
        },
      ]),
    ).toEqual({
      tokensLabel: "143.6k",
      modelLabel: "claude-sonnet-4-5",
    });
  });

  it("formats small counts as integers and millions with one decimal", () => {
    expect(
      runUsageSummary([
        {
          usage: {
            models: {
              "local-model": { inputTokens: 12, outputTokens: 8 },
            },
          },
        },
      ]),
    ).toEqual({ tokensLabel: "20", modelLabel: "local-model" });

    expect(
      runUsageSummary([
        {
          usage: {
            models: {
              "vendor/model": { inputTokens: 1_500_000, outputTokens: 0 },
            },
          },
        },
      ]),
    ).toEqual({ tokensLabel: "1.5m", modelLabel: "model" });
  });
});
