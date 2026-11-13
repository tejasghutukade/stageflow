import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_QUEUED_RUNS, maxQueuedRuns, startQueueDecision } from "./useStartRunForm";

describe("startQueueDecision", () => {
  it("starts immediately when a slot is free", () => {
    expect(
      startQueueDecision({ slotsAvailable: 1, queuedCount: 0, maxQueued: DEFAULT_MAX_QUEUED_RUNS }),
    ).toEqual({ queueFull: false, queueLabel: null });
  });

  it("allows Start and names the queue position when slots are full but the queue has room", () => {
    expect(
      startQueueDecision({ slotsAvailable: 0, queuedCount: 2, maxQueued: DEFAULT_MAX_QUEUED_RUNS }),
    ).toEqual({ queueFull: false, queueLabel: "will queue (position 3)" });
  });

  it("disables Start when the queue is full", () => {
    expect(
      startQueueDecision({ slotsAvailable: 0, queuedCount: 2, maxQueued: 2 }),
    ).toEqual({ queueFull: true, queueLabel: null });
  });

  it("disables Start when slots are full and the host queue limit is zero", () => {
    expect(startQueueDecision({ slotsAvailable: 0, queuedCount: 0, maxQueued: 0 })).toEqual({
      queueFull: true,
      queueLabel: null,
    });
  });

  it("reads maxQueued from health and otherwise uses the host default", () => {
    expect(maxQueuedRuns(null)).toBe(DEFAULT_MAX_QUEUED_RUNS);
    expect(maxQueuedRuns({ config: { maxQueued: 4 } })).toBe(4);
    expect(maxQueuedRuns({ config: { maxQueued: 0 } })).toBe(0);
  });
});
