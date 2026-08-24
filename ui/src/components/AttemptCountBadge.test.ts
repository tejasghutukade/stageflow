import { describe, expect, it } from "vitest";
import { formatAttemptCount } from "./AttemptCountBadge";

describe("formatAttemptCount", () => {
  it("formats counts above 1", () => {
    expect(formatAttemptCount(3)).toBe("×3");
  });

  it("returns null for 1 and undefined", () => {
    expect(formatAttemptCount(1)).toBeNull();
    expect(formatAttemptCount(undefined)).toBeNull();
  });
});
