import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../api";
import {
  isDisplayableFailedStageEvent,
  isInterruptedFailedRun,
  lastDisplayableFailedStageEvents,
  partitionFailedRuns,
  sortFailedRuns,
} from "./failedViews";

function run(partial: Partial<RunSummary> & { run_id: string }): RunSummary {
  return {
    pipeline_id: "p",
    status: "failed",
    created_at: "2026-01-01T00:00:00.000Z",
    stages: [],
    ...partial,
  };
}

describe("isInterruptedFailedRun", () => {
  it("detects process_interrupted reasons", () => {
    expect(
      isInterruptedFailedRun(
        run({
          run_id: "a",
          failed_reason: "process_interrupted: no active worker (server restart)",
        }),
      ),
    ).toBe(true);
  });

  it("detects compact interrupted stage status", () => {
    expect(
      isInterruptedFailedRun(
        run({
          run_id: "b",
          failed_stage_id: "plan",
          stages: [{ id: "plan", status: "interrupted", attempt_count: 1 }],
        }),
      ),
    ).toBe(true);
  });
});

describe("sortFailedRuns", () => {
  it("orders by updated_at newest first", () => {
    const runs = [
      run({ run_id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      run({ run_id: "new", updated_at: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(sortFailedRuns(runs, "newest").map((r) => r.run_id)).toEqual([
      "new",
      "old",
    ]);
    expect(sortFailedRuns(runs, "oldest").map((r) => r.run_id)).toEqual([
      "old",
      "new",
    ]);
  });
});

describe("partitionFailedRuns", () => {
  it("splits interrupted from other failures", () => {
    const interrupted = run({
      run_id: "i",
      failed_reason: "process_interrupted: host shutdown",
    });
    const other = run({ run_id: "o", failed_reason: "tool error" });
    const parts = partitionFailedRuns([interrupted, other]);
    expect(parts.interrupted.map((r) => r.run_id)).toEqual(["i"]);
    expect(parts.other.map((r) => r.run_id)).toEqual(["o"]);
  });
});

describe("displayable failed stage events", () => {
  it("drops noisy events and caps at twelve", () => {
    const events = Array.from({ length: 24 }, (_, i) => ({
      event: i % 2 === 0 ? "agent_start" : "message",
      text: `line ${i}`,
      role: "assistant",
    }));
    const last = lastDisplayableFailedStageEvents(events, 12);
    expect(last).toHaveLength(12);
    expect(last.every(isDisplayableFailedStageEvent)).toBe(true);
  });
});
