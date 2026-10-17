import { describe, expect, it } from "vitest";
import {
  buildOverview,
  isOverviewRange,
  overviewWindowMs,
  type OverviewRunRow,
} from "../src/runstore/overviewSummary.js";

const NOW = new Date("2026-10-17T12:00:00.000Z");
const HOUR = 3_600_000;

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function row(partial: Partial<OverviewRunRow> & { ageMs: number }): OverviewRunRow {
  const { ageMs, ...rest } = partial;
  return {
    run_id: `run_${Math.random().toString(36).slice(2, 8)}`,
    pipeline_id: "feature-ship",
    status: "succeeded",
    created_at: ago(ageMs),
    ...rest,
  };
}

describe("buildOverview", () => {
  it("validates ranges", () => {
    expect(isOverviewRange("7d")).toBe(true);
    expect(isOverviewRange("1y")).toBe(false);
    expect(overviewWindowMs("24h")).toBe(24 * HOUR);
  });

  it("counts outcomes and treats cancelled runs as neither success nor failure", () => {
    const summary = buildOverview(
      [
        row({ ageMs: HOUR }),
        row({ ageMs: 2 * HOUR }),
        row({ ageMs: 3 * HOUR, status: "failed" }),
        row({ ageMs: 4 * HOUR, status: "cancelled" }),
        row({ ageMs: 5 * HOUR, status: "running" }),
        row({ ageMs: 6 * HOUR, status: "queued" }),
      ],
      "7d",
      NOW,
    );
    expect(summary.totals).toMatchObject({
      runs: 6,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      in_flight: 2,
      finished: 3,
    });
    expect(summary.totals.success_rate).toBeCloseTo(2 / 3);
  });

  it("has a null success rate when nothing has finished", () => {
    const summary = buildOverview([row({ ageMs: HOUR, status: "running" })], "7d", NOW);
    expect(summary.totals.success_rate).toBeNull();
    expect(buildOverview([], "7d", NOW).totals.runs).toBe(0);
  });

  it("splits the window into the documented rolling buckets", () => {
    expect(buildOverview([], "24h", NOW).buckets).toHaveLength(8);
    expect(buildOverview([], "7d", NOW).buckets).toHaveLength(7);
    expect(buildOverview([], "30d", NOW).buckets).toHaveLength(10);
  });

  it("places runs in the bucket that covers their creation time, newest in the last", () => {
    const summary = buildOverview(
      [
        row({ ageMs: 10 * 60_000 }),
        row({ ageMs: 10 * 60_000, status: "failed" }),
        row({ ageMs: 6 * 24 * HOUR + HOUR, status: "cancelled" }),
      ],
      "7d",
      NOW,
    );
    const last = summary.buckets[summary.buckets.length - 1]!;
    expect(last).toMatchObject({ succeeded: 1, failed: 1, cancelled: 0 });
    expect(summary.buckets[0]).toMatchObject({ cancelled: 1 });
    expect(summary.buckets.reduce((n, b) => n + b.succeeded + b.failed + b.cancelled, 0)).toBe(3);
  });

  it("feeds `previous` from the window before the current one and ignores older runs", () => {
    const summary = buildOverview(
      [
        row({ ageMs: HOUR }),
        row({ ageMs: 8 * 24 * HOUR }),
        row({ ageMs: 9 * 24 * HOUR, status: "failed" }),
        row({ ageMs: 20 * 24 * HOUR }),
      ],
      "7d",
      NOW,
    );
    expect(summary.totals.runs).toBe(1);
    expect(summary.previous).toMatchObject({ runs: 2, succeeded: 1, failed: 1 });
  });

  it("sums cost and rounds away float noise", () => {
    const summary = buildOverview(
      [row({ ageMs: HOUR, cost_usd: 0.1 }), row({ ageMs: HOUR, cost_usd: 0.2 }), row({ ageMs: HOUR })],
      "24h",
      NOW,
    );
    expect(summary.totals.cost_usd).toBe(0.3);
  });

  it("groups by pipeline with median duration over finished runs only", () => {
    const summary = buildOverview(
      [
        row({ ageMs: 5 * HOUR, finished_at: ago(5 * HOUR - 60_000) }),
        row({ ageMs: 4 * HOUR, finished_at: ago(4 * HOUR - 180_000) }),
        row({ ageMs: 3 * HOUR, finished_at: ago(3 * HOUR - 300_000), status: "failed" }),
        row({ ageMs: 2 * HOUR, status: "running" }),
        row({ ageMs: HOUR, pipeline_id: "bugfix-loop", cost_usd: 1.5 }),
      ],
      "24h",
      NOW,
    );
    const feature = summary.pipelines.find((p) => p.pipeline_id === "feature-ship")!;
    expect(feature).toMatchObject({ runs: 4, succeeded: 2, failed: 1 });
    expect(feature.median_duration_ms).toBe(180_000);
    expect(feature.last_run_at).toBe(ago(2 * HOUR));
    const bugfix = summary.pipelines.find((p) => p.pipeline_id === "bugfix-loop")!;
    expect(bugfix.median_duration_ms).toBeNull();
    expect(bugfix.cost_usd).toBe(1.5);
    expect(summary.pipelines.map((p) => p.pipeline_id)).toEqual(["feature-ship", "bugfix-loop"]);
  });

  it("skips rows with unparseable timestamps", () => {
    const bad: OverviewRunRow = { run_id: "x", pipeline_id: "p", status: "succeeded", created_at: "nope" };
    expect(buildOverview([bad], "7d", NOW).totals.runs).toBe(0);
  });
});
