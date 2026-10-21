import { describe, expect, it } from "vitest";
import { capacityHintLine, capacitySlotKinds } from "./capacitySlots";

describe("capacitySlotKinds", () => {
  it("renders all free segments when active count is zero", () => {
    expect(
      capacitySlotKinds(
        {
          ok: true,
          activeRunIds: [],
          activeCount: 0,
          maxConcurrent: 6,
          slotsAvailable: 6,
        },
        3,
      ),
    ).toEqual(["free", "free", "free", "free", "free", "free"]);
  });

  it("orders running, held, then free segments", () => {
    expect(
      capacitySlotKinds(
        {
          ok: true,
          activeRunIds: [],
          activeCount: 3,
          maxConcurrent: 4,
          slotsAvailable: 1,
        },
        1,
      ),
    ).toEqual(["running", "running", "held", "free"]);
  });
});

describe("capacityHintLine", () => {
  it("returns null when nothing is held", () => {
    expect(capacityHintLine(0)).toBeNull();
  });

  it("uses singular copy for one held slot", () => {
    expect(capacityHintLine(1)).toBe("1 slot held by a run waiting on you");
  });
});
