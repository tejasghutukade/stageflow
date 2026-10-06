import { describe, expect, it } from "vitest";
import type { StageSnapshot } from "../api";
import { stageSegments, timelineBounds } from "./stageTimeline";

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
});
