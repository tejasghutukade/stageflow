import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordMcpTools } from "../src/toolkit/record.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
import type { RunStatus, RunStore } from "../src/runstore/port.js";
import { RUN_STATS_DAY_CAP, RUN_STATS_WEEK_CAP, collectRunStats } from "../src/runstore/runStats.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openStore(): Promise<RunStore> {
  const root = await mkdtemp(path.join(tmpdir(), "sf-run-stats-"));
  const store = createRunStore({ rootDir: root });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return store;
}

async function seed(
  store: RunStore,
  rows: Array<{ pipeline: string; status: RunStatus; at: string; origin?: "eval"; path?: string }>,
): Promise<void> {
  const db = sqliteConnectionFromStore(store);
  if (!db) throw new Error("no sqlite connection");
  for (const row of rows) {
    const created = await store.createRun({
      pipelineId: row.pipeline,
      taskYaml: "id: t\ngoal: g\n",
      status: row.status,
      ...(row.origin ? { origin: row.origin } : {}),
      ...(row.path ? { pipelinePath: row.path } : {}),
    });
    db.prepare(`UPDATE runs SET created_at = ? WHERE run_id = ?`).run(row.at, created.runId);
  }
}

function counts(partial: Partial<Record<RunStatus, number>>) {
  return {
    created: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    ...partial,
  };
}

describe("run_stats", () => {
  it("fills empty days and counts created_at in UTC", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "succeeded", at: "2026-01-01T10:00:00.000Z" },
      { pipeline: "alpha", status: "failed", at: "2026-01-03T10:00:00.000Z" },
      { pipeline: "beta", status: "cancelled", at: "2026-01-03T11:00:00.000Z" },
      { pipeline: "alpha", status: "succeeded", at: "2026-01-04T00:00:00.000Z" },
      { pipeline: "hidden", status: "failed", at: "2026-01-02T12:00:00.000Z", origin: "eval" },
    ]);
    const result = await collectRunStats(store, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-03T23:00:00.000Z",
      group_by: "day",
      timezone: "UTC",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
    expect(result.value.by_status).toEqual(counts({ succeeded: 1, failed: 1, cancelled: 1 }));
    expect(result.value.buckets.map((bucket) => [bucket.key, bucket.total, bucket.by_status.succeeded, bucket.by_status.failed, bucket.by_status.cancelled])).toEqual([
      ["2026-01-01", 1, 1, 0, 0],
      ["2026-01-02", 0, 0, 0, 0],
      ["2026-01-03", 2, 0, 1, 1],
    ]);
    expect(result.value.capped).toBeUndefined();
  });

  it("groups weeks by the Monday of created_at", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "succeeded", at: "2026-01-06T15:00:00.000Z" },
      { pipeline: "alpha", status: "failed", at: "2026-01-13T15:00:00.000Z" },
    ]);
    const result = await collectRunStats(store, {
      since: "2026-01-05T00:00:00.000Z",
      until: "2026-01-18T23:00:00.000Z",
      group_by: "week",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timezone).toBe("UTC");
    expect(result.value.buckets).toEqual([
      { key: "2026-01-05", label: "Week of 2026-01-05", total: 1, by_status: counts({ succeeded: 1 }) },
      { key: "2026-01-12", label: "Week of 2026-01-12", total: 1, by_status: counts({ failed: 1 }) },
    ]);
  });

  it("groups by pipeline and applies status and pipeline filters", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "succeeded", at: "2026-01-01T10:00:00.000Z" },
      { pipeline: "alpha", status: "failed", at: "2026-01-02T10:00:00.000Z" },
      { pipeline: "beta", status: "cancelled", at: "2026-01-02T11:00:00.000Z", path: "pipelines/beta.pipeline.yaml" },
    ]);
    const window = { since: "2026-01-01T00:00:00.000Z", until: "2026-01-03T00:00:00.000Z" };
    const byPipeline = await collectRunStats(store, { ...window, group_by: "pipeline" });
    expect(byPipeline.ok && byPipeline.value.buckets.map((bucket) => [bucket.key, bucket.total])).toEqual([
      ["alpha", 2],
      ["beta", 1],
    ]);
    const failed = await collectRunStats(store, { ...window, group_by: "day", status: "failed" });
    expect(failed.ok && failed.value.total).toBe(1);
    expect(failed.ok && failed.value.by_status.failed).toBe(1);
    expect(failed.ok && failed.value.buckets[1]?.total).toBe(1);
    const beta = await collectRunStats(store, { ...window, group_by: "pipeline", pipeline: "pipelines/beta.pipeline.yaml" });
    expect(beta.ok && beta.value.total).toBe(1);
    expect(beta.ok && beta.value.buckets).toEqual([
      { key: "beta", label: "beta", total: 1, by_status: counts({ cancelled: 1 }) },
    ]);
  });

  it("uses the timezone's calendar day", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "succeeded", at: "2026-01-02T03:00:00.000Z" },
      { pipeline: "alpha", status: "failed", at: "2026-01-02T06:00:00.000Z" },
    ]);
    const result = await collectRunStats(store, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T12:00:00.000Z",
      group_by: "day",
      timezone: "America/New_York",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets.map((bucket) => [bucket.key, bucket.total])).toEqual([
      ["2025-12-31", 0],
      ["2026-01-01", 1],
      ["2026-01-02", 1],
    ]);
    expect(result.value.buckets[1]?.by_status.succeeded).toBe(1);
    expect(result.value.buckets[2]?.by_status.failed).toBe(1);
  });

  it("rejects a bad date, an inverted window, and an unknown timezone", async () => {
    const store = await openStore();
    const now = new Date("2026-03-31T00:00:00.000Z");
    expect(await collectRunStats(store, { since: "not-a-date" }, now)).toEqual({ ok: false, message: "since must be a valid date" });
    expect(await collectRunStats(store, { since: "2026-02-02T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" }, now)).toEqual({
      ok: false,
      message: "since must be at or before until",
    });
    expect(await collectRunStats(store, { timezone: "Not/AZone" }, now)).toEqual({
      ok: false,
      message: "timezone must be a valid IANA name, or omit it for UTC",
    });
    const defaults = await collectRunStats(store, {}, now);
    expect(defaults.ok && defaults.value.since).toBe("2026-03-01T00:00:00.000Z");
    expect(defaults.ok && defaults.value.until).toBe("2026-03-31T00:00:00.000Z");
    expect(defaults.ok && defaults.value.group_by).toBe("day");
  });

  it("caps day buckets at 366 and pipelines at 50 plus other", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "early", status: "succeeded", at: "2024-06-01T00:00:00.000Z" },
      { pipeline: "kept", status: "failed", at: "2024-12-31T12:00:00.000Z" },
    ]);
    const days = await collectRunStats(store, {
      since: "2024-01-01T00:00:00.000Z",
      until: "2025-12-31T00:00:00.000Z",
      group_by: "day",
      timezone: "UTC",
    });
    expect(days.ok).toBe(true);
    if (!days.ok) return;
    expect(days.value.capped).toBe(true);
    expect(days.value.buckets).toHaveLength(RUN_STATS_DAY_CAP);
    expect(days.value.buckets[0]?.key).toBe("2024-12-31");
    expect(days.value.buckets.at(-1)?.key).toBe("2025-12-31");
    expect(days.value.total).toBe(1);
    expect(days.value.by_status.failed).toBe(1);

    const pipelines = Array.from({ length: 51 }, (_, index) => ({
      pipeline: `p${String(index).padStart(2, "0")}`,
      status: "succeeded" as const,
      at: "2026-01-02T00:00:00.000Z",
    }));
    await seed(store, pipelines);
    const grouped = await collectRunStats(store, {
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-03T00:00:00.000Z",
      group_by: "pipeline",
    });
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    expect(grouped.value.capped).toBe(true);
    expect(grouped.value.buckets).toHaveLength(51);
    expect(grouped.value.buckets.at(-1)).toMatchObject({ key: "other", label: "Other", total: 1 });
    expect(grouped.value.total).toBe(51);
    expect(grouped.value.buckets.some((bucket) => bucket.key === "p50")).toBe(false);
  });

  it("keeps the latest buckets for an all-time window", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "failed", at: "2026-11-26T12:00:00.000Z" },
      { pipeline: "alpha", status: "succeeded", at: "2019-05-01T12:00:00.000Z" },
    ]);
    const days = await collectRunStats(store, { since: "1970-01-01T00:00:00.000Z", until: "2026-11-27T12:00:00.000Z", group_by: "day" });
    expect(days.ok).toBe(true);
    if (!days.ok) return;
    expect(days.value.buckets).toHaveLength(RUN_STATS_DAY_CAP);
    expect(days.value.buckets.at(-1)?.key).toBe("2026-11-27");
    expect(days.value.buckets.at(-2)).toMatchObject({ key: "2026-11-26", total: 1 });
    expect(days.value.total).toBe(1);
    expect(days.value.capped).toBe(true);
    const weeks = await collectRunStats(store, { since: "1970-01-01T00:00:00.000Z", until: "2026-11-27T12:00:00.000Z", group_by: "week" });
    expect(weeks.ok).toBe(true);
    if (!weeks.ok) return;
    expect(weeks.value.buckets).toHaveLength(RUN_STATS_WEEK_CAP);
    expect(weeks.value.buckets.at(-1)).toMatchObject({ key: "2026-11-23", total: 1 });
    expect(weeks.value.capped).toBe(true);
  });

  it("puts a spring-forward night on the right local days", async () => {
    const store = await openStore();
    await seed(store, [
      { pipeline: "alpha", status: "succeeded", at: "2026-03-08T03:30:00.000Z" },
      { pipeline: "alpha", status: "failed", at: "2026-03-09T04:30:00.000Z" },
    ]);
    const result = await collectRunStats(store, {
      since: "2026-03-07T05:00:00.000Z",
      until: "2026-03-09T23:00:00.000Z",
      group_by: "day",
      timezone: "America/New_York",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets.map((bucket) => [bucket.key, bucket.total])).toEqual([
      ["2026-03-07", 1],
      ["2026-03-08", 0],
      ["2026-03-09", 1],
    ]);
  });

  it("is the read-only MCP tool", async () => {
    const store = await openStore();
    await seed(store, [{ pipeline: "alpha", status: "succeeded", at: "2026-01-01T08:00:00.000Z" }]);
    const tool = recordMcpTools({ cwd: process.cwd(), store, manager: {} as never }).find((entry) => entry.name === "run_stats");
    expect(tool?.readOnlyHint).toBe(true);
    expect(tool?.description).not.toContain("/api/");
    const raw = await tool?.handler(
      { since: "2026-01-01T00:00:00.000Z", until: "2026-01-01T23:00:00.000Z", group_by: "day", timezone: "UTC" },
      {},
    );
    const body = JSON.parse((raw as { content: Array<{ text: string }> }).content[0]!.text) as { total: number; buckets: Array<{ key: string; total: number }> };
    expect(body.total).toBe(1);
    expect(body.buckets).toEqual([expect.objectContaining({ key: "2026-01-01", total: 1 })]);
    const bad = await tool?.handler({ since: "nope" }, {});
    expect(bad).toMatchObject({ isError: true });
  });
});
