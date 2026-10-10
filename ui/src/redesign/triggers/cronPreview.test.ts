import { describe, expect, it } from "vitest";
import { nextScheduleRuns } from "./cronPreview";

describe("nextScheduleRuns", () => {
  it("returns upcoming cron fires", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const runs = nextScheduleRuns({ cron: "0 * * * *", timezone: "UTC" }, from, 3);
    expect(runs.length).toBe(3);
    expect(runs[0]!.getUTCMinutes()).toBe(0);
  });
});
