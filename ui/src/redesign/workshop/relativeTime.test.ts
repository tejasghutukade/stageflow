import { describe, expect, it } from "vitest";
import { formatAgo, toEpochMs } from "./relativeTime";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("formatAgo", () => {
  it("formats seconds, minutes, hours, and days", () => {
    expect(formatAgo(NOW - 500, NOW)).toBe("just now");
    expect(formatAgo(NOW - 4_000, NOW)).toBe("4s ago");
    expect(formatAgo(NOW - 59_000, NOW)).toBe("59s ago");
    expect(formatAgo(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(formatAgo(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  it("accepts ISO strings and Dates", () => {
    expect(formatAgo("2026-10-06T11:59:00.000Z", NOW)).toBe("1m ago");
    expect(formatAgo(new Date(NOW - 10_000), NOW)).toBe("10s ago");
  });

  it("clamps future times and ignores invalid input", () => {
    expect(formatAgo(NOW + 60_000, NOW)).toBe("just now");
    expect(formatAgo("not a date", NOW)).toBe("");
  });

  it("converts inputs to epoch ms", () => {
    expect(toEpochMs(NOW)).toBe(NOW);
    expect(toEpochMs("2026-10-06T12:00:00.000Z")).toBe(NOW);
  });
});
