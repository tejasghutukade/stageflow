import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDuration,
  formatPercent,
  formatPoints,
  formatRelativeTime,
  formatScore,
  formatTokens,
} from "./format";

describe("formatPercent", () => {
  it("shows one decimal", () => {
    expect(formatPercent(0.875)).toBe("87.5%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.783)).toBe("78.3%");
  });
  it("shows a dash when missing", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
  });
});

describe("formatScore", () => {
  it("shows two decimals", () => {
    expect(formatScore(0.86)).toBe("0.86");
    expect(formatScore(1)).toBe("1.00");
    expect(formatScore(null)).toBe("—");
  });
});

describe("formatCost", () => {
  it("shows two decimals and a floor below a cent", () => {
    expect(formatCost(0.64)).toBe("$0.64");
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.004)).toBe("< $0.01");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("shows seconds under a minute", () => {
    expect(formatDuration(3900)).toBe("3.9 s");
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(59_000)).toBe("59.0 s");
  });
  it("shows minutes and seconds from a minute", () => {
    expect(formatDuration(221_000)).toBe("3 m 41 s");
    expect(formatDuration(60_000)).toBe("1 m 00 s");
    expect(formatDuration(59_990)).toBe("1 m 00 s");
    expect(formatDuration(3_725_000)).toBe("62 m 05 s");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands", () => {
    expect(formatTokens(142_000)).toBe("142k");
    expect(formatTokens(2100)).toBe("2.1k");
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(undefined)).toBe("—");
  });
});

describe("formatPoints", () => {
  it("signs the change with a real minus", () => {
    expect(formatPoints(2.1)).toBe("+2.1 pts");
    expect(formatPoints(-9.2)).toBe("−9.2 pts");
    expect(formatPoints(0)).toBe("0.0 pts");
    expect(formatPoints(-0.04)).toBe("0.0 pts");
    expect(formatPoints(null)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  it("uses the shared relative helper", () => {
    expect(formatRelativeTime("2026-10-20T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-10-18T12:00:00Z", now)).toBe("2d ago");
  });
  it("shows a dash without a time", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
  });
});
