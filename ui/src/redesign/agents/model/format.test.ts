import { describe, expect, it } from "vitest";
import { formatCost, formatDuration, formatTokens, relativeTime, sessionSubtitle, shortSessionId, sourceLabel } from "./format";

describe("agent formatting", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(relativeTime("2026-10-15T11:59:40Z", now)).toBe("Just now");
    expect(relativeTime("2026-10-15T11:48:00Z", now)).toBe("12 min ago");
    expect(relativeTime("2026-10-15T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-10-14T11:00:00Z", now)).toBe("Yesterday");
    expect(relativeTime(null, now)).toBe("—");
  });

  it("formats tokens, cost, durations and ids", () => {
    expect(formatTokens(0)).toBe("—");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(12_800)).toBe("12.8k");
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0.004)).toBe("$0.004");
    expect(formatCost(2.181)).toBe("$2.18");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(16_200)).toBe("16.2 s");
    expect(formatDuration(390_000)).toBe("6 m 30 s");
    expect(shortSessionId("ses_8f2c1a2b3c4d")).toBe("ses_8f2c");
  });

  it("labels web chat sessions and shortens the anonymous visitor id", () => {
    expect(sourceLabel("web")).toBe("Web chat");
    const visitor = "v_9f8e7d6c5b4a3210";
    expect(sessionSubtitle({ id: "ses_0123456789abcdef", source: "web", sourceRef: visitor })).toBe("Visitor v_9f8e7d · ses_0123");
    expect(sessionSubtitle({ id: "ses_0123456789abcdef", source: "telegram", sourceRef: "alice" })).toBe("alice · ses_0123");
    expect(sessionSubtitle({ id: "ses_0123456789abcdef", source: "web", sourceRef: null })).toBe("ses_0123");
  });
});
