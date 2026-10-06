import { describe, expect, it } from "vitest";
import { deriveExecutionPatchFromEvent } from "../src/runstore/stageExecution.js";
import type { StageUsage } from "../src/types/usage.js";

const current = { status: "running" as const, started_at: "2026-01-01T00:00:00.000Z" };

describe("deriveExecutionPatchFromEvent — usage", () => {
  it("carries usage/cost_usd into the patch on succeeded", () => {
    const usage: StageUsage = {
      costUsd: 0.05,
      models: { "claude-opus-4-7": {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0.05,
      } },
    };
    const patch = deriveExecutionPatchFromEvent(
      { event: "succeeded", at: "2026-01-01T00:01:00.000Z", usage },
      current,
    );
    expect(patch.status).toBe("succeeded");
    expect(patch.cost_usd).toBe(0.05);
    expect(patch.usage).toEqual(usage);
  });

  it("carries usage/cost_usd into the patch on failed", () => {
    const usage: StageUsage = { costUsd: 0.02, models: {} };
    const patch = deriveExecutionPatchFromEvent(
      { event: "failed", reason: "boom", at: "2026-01-01T00:01:00.000Z", usage },
      current,
    );
    expect(patch.status).toBe("failed");
    expect(patch.cost_usd).toBe(0.02);
  });

  it("omits cost_usd/usage when the event carries none", () => {
    const patch = deriveExecutionPatchFromEvent(
      { event: "succeeded", at: "2026-01-01T00:01:00.000Z" },
      current,
    );
    expect(patch.status).toBe("succeeded");
    expect(patch.cost_usd).toBeUndefined();
    expect(patch.usage).toBeUndefined();
  });
});
