import { describe, expect, it } from "vitest";
import type { StageSnapshot } from "../api";
import {
  axisSpanMs,
  futureBarSlots,
  stageSegments,
  timelineBounds,
  visibleStageBars,
} from "./stageTimeline";

function stage(
  overrides: Partial<StageSnapshot> & Pick<StageSnapshot, "stage_id" | "status">,
): StageSnapshot {
  return {
    events: [],
    envelope: null,
    artifacts: [],
    attempt_count: 1,
    ...overrides,
  };
}

describe("stageTimeline", () => {
  const now = Date.parse("2026-10-05T12:00:30.000Z");

  it("extends waiting segment to now while waiting_for_input", () => {
    const st = stage({
      stage_id: "review",
      status: "waiting_for_input",
      events: [
        { event: "started", at: "2026-10-05T12:00:00.000Z" },
        { event: "waiting_for_input", at: "2026-10-05T12:00:10.000Z" },
      ],
    });
    const waiting = stageSegments(st, now).find((s) => s.kind === "waiting");
    expect(waiting?.endMs).toBe(now);
    expect((waiting?.endMs ?? 0) - (waiting?.startMs ?? 0)).toBe(20_000);
  });

  it("bounds failed segment at failed event", () => {
    const st = stage({
      stage_id: "build",
      status: "failed",
      events: [
        { event: "started", at: "2026-10-05T11:00:00.000Z" },
        { event: "failed", at: "2026-10-05T11:05:00.000Z", reason: "boom" },
      ],
    });
    const failed = stageSegments(st, now).find((s) => s.kind === "failed");
    expect(failed?.startMs).toBe(Date.parse("2026-10-05T11:05:00.000Z"));
  });

  it("uses blocked segment for pending blocked track nodes", () => {
    const st = stage({
      stage_id: "ship",
      status: "pending",
    });
    const blocked = stageSegments(st, now, { readiness: "blocked" }).find(
      (s) => s.kind === "blocked",
    );
    expect(blocked).toBeDefined();
  });

  it("timelineBounds includes active waiting end", () => {
    const run = {
      created_at: "2026-10-05T10:00:00.000Z",
      finished_at: undefined,
    };
    const stages = [
      stage({
        stage_id: "a",
        status: "waiting_for_input",
        events: [
          { event: "started", at: "2026-10-05T11:00:00.000Z" },
          { event: "waiting_for_input", at: "2026-10-05T11:01:00.000Z" },
        ],
      }),
    ];
    const bounds = timelineBounds(run, stages, now);
    expect(bounds.endMs).toBeGreaterThanOrEqual(now);
  });

  it("opens the axis on the next mark past now", () => {
    const elapsed = 17 * 60_000 + 40_000;
    expect(axisSpanMs(elapsed, true)).toBe(20 * 60_000);
    expect(axisSpanMs(19.5 * 60_000, true)).toBe(30 * 60_000);
    expect(axisSpanMs(9_000, true)).toBe(10_000);
    expect(axisSpanMs(elapsed, false)).toBe(elapsed);
  });

  it("paints a succeeded stage green across its whole run", () => {
    const st = stage({
      stage_id: "plan",
      status: "succeeded",
      events: [
        { event: "started", at: "2026-10-05T11:00:00.000Z" },
        { event: "succeeded", at: "2026-10-05T11:01:48.000Z" },
      ],
    });
    expect(visibleStageBars(st, now)).toEqual([
      {
        kind: "succeeded",
        startMs: Date.parse("2026-10-05T11:00:00.000Z"),
        endMs: Date.parse("2026-10-05T11:01:48.000Z"),
      },
    ]);
  });

  it("keeps agent work blue and the open gate orange through now", () => {
    const st = stage({
      stage_id: "review",
      status: "waiting_for_input",
      events: [
        { event: "started", at: "2026-10-05T12:00:00.000Z" },
        { event: "waiting_for_input", at: "2026-10-05T12:00:10.000Z" },
      ],
    });
    const bars = visibleStageBars(st, now);
    expect(bars.map((bar) => bar.kind)).toEqual(["running", "waiting"]);
    expect(bars[0]?.endMs).toBe(bars[1]?.startMs);
    expect(bars[1]?.endMs).toBe(now);
  });

  it("places future stages as short dashes after now", () => {
    const slots = futureBarSlots(2, 88.3);
    expect(slots[0]?.left).toBeGreaterThan(88.3);
    expect(slots[0]?.width).toBeLessThanOrEqual(6);
    expect(slots[1]?.left).toBeGreaterThan((slots[0]?.left ?? 0) + (slots[0]?.width ?? 0) - 0.01);
    expect((slots[1]?.left ?? 0) + (slots[1]?.width ?? 0)).toBeLessThanOrEqual(100.01);
  });
});
