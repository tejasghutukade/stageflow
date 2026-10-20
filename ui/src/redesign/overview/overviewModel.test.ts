import { describe, expect, it } from "vitest";
import type { CapacityHealth, OverviewSummary, RunSummary, TriggerListItem } from "../../api";
import type { AgentSessionListItem } from "../../api/agents";
import type { AgentApprovalItem } from "../inbox/needsQueue";
import {
  activityRows,
  ageShort,
  chartModel,
  failedRows,
  formatDuration,
  formatWait,
  headline,
  kpis,
  liveRows,
  needsRows,
  oldestWaiting,
  pipelineRows,
  runStoreLine,
  sessionRows,
  sessionStatsLine,
  subline,
  triggerRows,
  triggerSummary,
} from "./overviewModel";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

function run(over: Partial<RunSummary> & Pick<RunSummary, "run_id">): RunSummary {
  return { pipeline_id: "feature-ship", status: "running", created_at: ago(30 * MIN), stages: [], ...over };
}

function approval(over: Partial<AgentApprovalItem> = {}): AgentApprovalItem {
  return {
    id: "a1",
    sessionId: "s1",
    turnId: null,
    tool: "slack_post",
    payload: { channel: "#releases" },
    payloadHash: "h",
    status: "pending",
    createdAt: ago(2 * MIN),
    expiresAt: ago(-MIN),
    decidedAt: null,
    actor: null,
    agentId: "release",
    agentName: "Release coordinator",
    ...over,
  };
}

function overview(over: Partial<OverviewSummary> = {}): OverviewSummary {
  const totals = { runs: 48, succeeded: 39, failed: 4, cancelled: 1, in_flight: 4, finished: 43, success_rate: 39 / 43, cost_usd: 18.4 };
  return {
    range: "7d",
    generated_at: ago(0),
    since: ago(7 * 24 * 60 * MIN),
    totals,
    previous: { ...totals, runs: 40, success_rate: 0.85, cost_usd: 16.3 },
    buckets: Array.from({ length: 7 }, (_, i) => ({ start: ago((7 - i) * 24 * 60 * MIN), succeeded: i + 1, failed: i % 2, cancelled: 0 })),
    pipelines: [],
    ...over,
  };
}

describe("formatting", () => {
  it("ages and durations read at a glance", () => {
    expect(ageShort(ago(10_000), NOW)).toBe("just now");
    expect(ageShort(ago(6 * MIN), NOW)).toBe("6m");
    expect(ageShort(ago(125 * MIN), NOW)).toBe("2h");
    expect(ageShort(ago(50 * 60 * MIN), NOW)).toBe("2d");
    expect(ageShort(undefined, NOW)).toBe("");
    expect(formatDuration(14 * MIN + 20_000)).toBe("14m 20s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125 * MIN)).toBe("2h 05m");
    expect(formatDuration(null)).toBe("—");
    expect(formatWait(41 * MIN)).toBe("41m");
    expect(formatWait(130 * MIN)).toBe("2h 10m");
  });
});

describe("needs you", () => {
  const waiting = run({ run_id: "r1", task_id: "fix-login", waiting_stage_id: "review", waiting_summary: "Ship it?", updated_at: ago(6 * MIN) });
  const older = run({ run_id: "r2", task_id: "rate-limit", waiting_stage_id: "fix", updated_at: ago(41 * MIN) });

  it("merges gates and agent approvals, longest waiting first", () => {
    const rows = needsRows([waiting, older], [approval()], NOW);
    expect(rows.map((row) => row.key)).toEqual(["r2", "r1", "agent:a1"]);
    expect(rows[0]).toMatchObject({ kind: "gate", runId: "r2", title: "feature-ship is waiting on you" });
    expect(rows[1]).toMatchObject({ title: "Ship it?" });
    expect(rows[1]!.meta).toBe("fix-login · feature-ship · review · waiting 6m");
    expect(rows[2]).toMatchObject({ kind: "agent", agentId: "release", title: "Release coordinator wants to use slack_post" });
  });

  it("finds the oldest waiter and phrases the headline", () => {
    const rows = needsRows([waiting, older], [], NOW);
    expect(oldestWaiting(rows, NOW)).toEqual({ ms: 41 * MIN, label: "rate-limit · feature-ship · fix" });
    expect(oldestWaiting([], NOW)).toBeNull();
    expect(headline(0)).toEqual({ tone: "ok", accent: "All clear.", rest: " Nothing needs you." });
    expect(headline(1)).toMatchObject({ accent: "1 thing", rest: " needs you." });
    expect(headline(3)).toMatchObject({ tone: "needs", accent: "3 things", rest: " need you." });
  });

  it("lists failed runs newest first and counts the last hour", () => {
    const f1 = run({ run_id: "f1", status: "failed", failed_stage_id: "reproduce", failed_reason: "429\nretry exhausted", updated_at: ago(12 * MIN) });
    const f2 = run({ run_id: "f2", status: "failed", updated_at: ago(3 * 60 * MIN) });
    expect(failedRows([f2, f1]).map((row) => row.runId)).toEqual(["f1", "f2"]);
    expect(failedRows([f1])[0]).toMatchObject({ label: "f1 · reproduce", reason: "429" });
    expect(subline([f1, f2, waiting], NOW)).toEqual({ inFlight: 1, failedLastHour: 1 });
  });
});

describe("kpis", () => {
  it("computes deltas against the previous window", () => {
    const [runs, success, spend] = kpis(overview());
    expect(runs).toMatchObject({ label: "Runs this week", value: "48", delta: { text: "▲ 20%", direction: "up" } });
    expect(success).toMatchObject({ value: "91%", note: "39 of 43 finished", delta: { text: "▲ 5.7 pts", good: true } });
    expect(spend).toMatchObject({ value: "$18.40", delta: { text: "▲ $2.10" } });
  });

  it("omits deltas when there is nothing to compare", () => {
    const empty = overview({
      totals: { runs: 0, succeeded: 0, failed: 0, cancelled: 0, in_flight: 0, finished: 0, success_rate: null, cost_usd: 0 },
      previous: { runs: 0, succeeded: 0, failed: 0, cancelled: 0, in_flight: 0, finished: 0, success_rate: null, cost_usd: 0 },
    });
    const [runs, success, spend] = kpis(empty);
    expect(runs!.delta).toBeNull();
    expect(success).toMatchObject({ value: "—", delta: null, note: "no finished runs yet" });
    expect(spend!.delta).toBeNull();
  });
});

describe("chart and pipelines", () => {
  it("rounds the axis up and marks the newest bar", () => {
    const model = chartModel(overview());
    expect(model.bars).toHaveLength(7);
    expect(model.bars.at(-1)).toMatchObject({ label: "Today", current: true });
    expect(model.max).toBe(9);
    expect(model.ticks).toEqual([9, 6, 3, 0]);
  });

  it("keeps a floor axis for an empty window", () => {
    expect(chartModel(overview({ buckets: [{ start: ago(0), succeeded: 0, failed: 0, cancelled: 0 }] })).max).toBe(3);
  });

  it("flags flaky pipelines only after two finished runs", () => {
    const base = { cancelled: 0, median_duration_ms: 1000, cost_usd: 1, last_run_at: ago(0) };
    const rows = pipelineRows(
      overview({
        pipelines: [
          { pipeline_id: "a", runs: 2, succeeded: 1, failed: 1, success_rate: 0.5, ...base },
          { pipeline_id: "b", runs: 1, succeeded: 0, failed: 1, success_rate: 0, ...base },
          { pipeline_id: "c", runs: 5, succeeded: 5, failed: 0, success_rate: 1, ...base },
          { pipeline_id: "d", runs: 1, succeeded: 0, failed: 0, success_rate: null, ...base },
        ],
      }),
    );
    expect(rows.map((row) => [row.pipeline_id, row.flaky, row.tone])).toEqual([
      ["a", true, "fail"],
      ["b", false, "fail"],
      ["c", false, "ok"],
      ["d", false, "none"],
    ]);
  });
});

describe("live, sessions and activity", () => {
  it("puts waiting runs first and names the active stage", () => {
    const running = run({ run_id: "r3", task_id: "csv", stages: [{ id: "implement", status: "running", attempt_count: 2 }] });
    const gate = run({ run_id: "r1", waiting_stage_id: "review" });
    const rows = liveRows([running, gate]);
    expect(rows.map((row) => [row.runId, row.waiting, row.stage])).toEqual([
      ["r1", true, "review · waiting on you"],
      ["r3", false, "implement · try 2"],
    ]);
    expect(rows[1]!.name).toBe("csv");
  });

  it("lists only running or waiting agent sessions", () => {
    const base = { agentId: "ops", revision: 1, backend: "pi", source: "slack", sourceRef: null, threadKey: null, createdAt: ago(MIN), updatedAt: ago(MIN), turnCount: 1, inputTokens: 0, outputTokens: 0, costUsd: null, lastTurnStatus: null } as const;
    const sessions = [
      { ...base, id: "s1", status: "running", title: "#incidents" },
      { ...base, id: "s2", status: "closed", title: null },
      { ...base, id: "s3", status: "waiting", title: null },
    ] as AgentSessionListItem[];
    const rows = sessionRows(sessions, new Map([["ops", "Operations assistant"]]));
    expect(rows.map((row) => row.sessionId)).toEqual(["s1", "s3"]);
    expect(rows[0]).toMatchObject({ name: "Operations assistant", detail: "slack · #incidents" });
    expect(rows[1]!.detail).toBe("slack · waiting");
  });

  it("summarises seven-day agent stats only when there were turns", () => {
    const stats = { total: 3, active: 1, last7Days: 3, waiting: 0, lastActivityAt: null, turnsFinished7d: 31, turnsSucceeded7d: 29, cost7d: 4.2, costTotal: 9 };
    expect(sessionStatsLine(stats)).toBe("last 7d · 31 turns · 94% succeeded · $4.20");
    expect(sessionStatsLine({ ...stats, turnsFinished7d: 0 })).toBeNull();
    expect(sessionStatsLine(null)).toBeNull();
  });

  it("merges finished runs and trigger fires, newest first", () => {
    const ok = run({ run_id: "r1", task_id: "csv", status: "succeeded", finished_at: ago(26 * MIN) });
    const bad = run({ run_id: "r2", status: "failed", failed_stage_id: "reproduce", finished_at: ago(12 * MIN) });
    const live = run({ run_id: "r3", status: "running" });
    const trigger = { id: "pr-opened", pipeline: "feature-ship", kind: "event", enabled: true, definition_ref: "x", last_fired_at: ago(31 * MIN), last_run_id: "r9" } as TriggerListItem;
    const rows = activityRows([ok, bad, live], [trigger]);
    expect(rows.map((row) => [row.subject, row.text, row.tone])).toEqual([
      ["r2", "failed at reproduce", "fail"],
      ["csv", "succeeded", "ok"],
      ["pr-opened", "trigger started feature-ship", "idle"],
    ]);
  });
});

describe("triggers and health", () => {
  const triggers = [
    { id: "manual-one", pipeline: "p", kind: "manual", enabled: true, definition_ref: "m" },
    { id: "weekly", pipeline: "spec-review", kind: "schedule", schedule: { cron: "0 9 * * 1" }, enabled: true, definition_ref: "w", next_run_at: new Date(NOW + 2 * 24 * 60 * MIN).toISOString() },
    { id: "nightly", pipeline: "digest", kind: "schedule", schedule: { cron: "0 23 * * *" }, enabled: true, definition_ref: "n", next_run_at: new Date(NOW + 5 * 60 * MIN).toISOString() },
    { id: "pr", pipeline: "feature-ship", kind: "event", event: { source: "github" }, enabled: true, definition_ref: "p", last_fired_at: ago(31 * MIN) },
    { id: "tag", pipeline: "release", kind: "event", event: { source: "github" }, enabled: false, definition_ref: "t" },
  ] as TriggerListItem[];

  it("orders by next fire, skips manual triggers and marks paused ones", () => {
    const rows = triggerRows(triggers, NOW, 10);
    expect(rows.map((row) => [row.id, row.when, row.tone])).toEqual([
      ["nightly", "in 5h", "ok"],
      ["weekly", "in 2d", "ok"],
      ["pr", "fired 31m ago", "ok"],
      ["tag", "off", "idle"],
    ]);
    expect(rows[1]!.detail).toBe("cron · 0 9 * * 1 → spec-review");
    expect(triggerSummary(triggers)).toEqual({ armed: 3, total: 4 });
  });

  it("states the run store size and free disk", () => {
    const gb = 1024 ** 3;
    const health = { ok: true, activeRunIds: [], activeCount: 0, maxConcurrent: 4, slotsAvailable: 4, disk: { runs_bytes: 100 * 1024 ** 2, worktrees_bytes: 0, repos_bytes: 0, state_db_bytes: 112 * 1024 ** 2, a2a_artifacts_bytes: 0, free_bytes: 48 * gb } } as CapacityHealth;
    expect(runStoreLine(health)).toBe("212 MB · 48 GB free");
    expect(runStoreLine(null)).toBeNull();
  });
});
