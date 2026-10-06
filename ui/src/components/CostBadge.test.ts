import { describe, expect, it } from "vitest";
import { formatCostUsd } from "./CostBadge";

describe("formatCostUsd", () => {
  it("formats a positive cost to 4 decimal places", () => {
    expect(formatCostUsd(0.0123)).toBe("$0.0123");
  });

  it("shows an explicit $0.0000 for a tracked-but-zero cost", () => {
    expect(formatCostUsd(0)).toBe("$0.0000");
  });

  it("returns null only when cost was never tracked", () => {
    expect(formatCostUsd(undefined)).toBeNull();
  });
});
