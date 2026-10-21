import { describe, expect, it } from "vitest";
import type { CapacityHealth } from "../../api";
import { computeConcurrencySlots } from "./settingsConcurrency";

function health(partial: Partial<CapacityHealth>): CapacityHealth {
  return {
    ok: true,
    activeRunIds: [],
    activeCount: 0,
    maxConcurrent: 4,
    slotsAvailable: 2,
    ...partial,
  };
}

describe("computeConcurrencySlots", () => {
  it("labels running, held, and free within maxConcurrent", () => {
    const result = computeConcurrencySlots(health({ maxConcurrent: 4, slotsAvailable: 1 }), 1);
    expect(result.running).toBe(2);
    expect(result.held).toBe(1);
    expect(result.free).toBe(1);
    expect(result.slotStates.slice(0, 4)).toEqual([
      "running",
      "running",
      "held",
      "free",
    ]);
    expect(result.slotStates.slice(4)).toEqual(["disabled", "disabled"]);
  });

  it("marks ticks above maxConcurrent as disabled", () => {
    const result = computeConcurrencySlots(health({ maxConcurrent: 2, slotsAvailable: 2 }), 0);
    expect(result.slotStates).toEqual([
      "free",
      "free",
      "disabled",
      "disabled",
      "disabled",
      "disabled",
    ]);
  });
});
