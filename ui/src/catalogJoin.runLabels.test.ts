import { describe, expect, it } from "vitest";
import type { RunSummary } from "./api";
import {
  formatRunShortTimestamp,
  runAnsweredGateLabel,
  runShortId,
} from "./catalogJoin";

describe("runShortId", () => {
  it("does not truncate ISO-prefixed run ids to a date prefix", () => {
    const id = "2026-09-28T15:30:00.000Z";
    expect(runShortId(id)).not.toBe("2026-09-");
    expect(runShortId(id).length).toBeGreaterThan(0);
  });

  it("keeps uuid prefix for standard uuids", () => {
    expect(runShortId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("a1b2c3d4");
  });
});

describe("formatRunShortTimestamp", () => {
  it("formats a valid iso timestamp", () => {
    const label = formatRunShortTimestamp("2026-09-28T15:30:00.000Z");
    expect(label).toMatch(/Sep 28 · \d{1,2}:\d{2}/);
  });

  it("does not return a bare date prefix for invalid iso", () => {
    expect(formatRunShortTimestamp("2026-09-")).not.toBe("2026-09-");
  });
});

describe("runAnsweredGateLabel", () => {
  it("prefers waiting stage id when present", () => {
    const run = {
      run_id: "2026-09-28T15:30:00.000Z",
      pipeline_id: "p",
      waiting_stage_id: "review",
    } as RunSummary;
    expect(runAnsweredGateLabel(run)).toBe("review");
  });
});
