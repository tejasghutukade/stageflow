import type {
  CapacityHealth,
  OverviewBucket,
  OverviewPipeline,
  OverviewRange,
  OverviewSummary,
  RunSummary,
  TriggerListItem,
} from "../../api";
import type { AgentSessionListItem, SessionStats } from "../../api/agents";
import { bucketViews } from "../../catalog/views";
import { mergeNeedsQueue, approvalPreview, type AgentApprovalItem } from "../inbox/needsQueue";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OVERVIEW_RANGES: readonly OverviewRange[] = ["24h", "7d", "30d"];

export const FLAKY_BELOW = 0.7;

function buckets(runs: readonly RunSummary[]) {
  return bucketViews({ runs: [...runs], health: null });
}

/** "just now", "6m", "2h", "3d". */
export function ageShort(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** "just now" or "6m ago". */
export function agoPhrase(iso: string | undefined, now: number): string {
  const short = ageShort(iso, now);
  return short === "" || short === "just now" ? short : `${short} ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatPercent(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/** "41m", "2h 10m". */
export function formatWait(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${h}h` : `${h}h ${minutes % 60}m`;
}

function runLabel(run: RunSummary): string {
  return run.task_id ?? run.run_id;
}

// ── Needs you ───────────────────────────────────────────────────────────────

export type NeedsRow =
  | {
      kind: "gate";
      key: string;
      runId: string;
      title: string;
      meta: string;
      since: string;
    }
  | {
      kind: "agent";
      key: string;
      approvalId: string;
      agentId: string;
      sessionId: string;
      title: string;
      meta: string;
      since: string;
    };

export type FailedRow = {
  key: string;
  runId: string;
  stageId: string | null;
  label: string;
  reason: string;
  at: string;
};

export function needsRows(runs: readonly RunSummary[], approvals: readonly AgentApprovalItem[], now: number): NeedsRow[] {
  return mergeNeedsQueue(buckets(runs).waiting, [...approvals]).map((item): NeedsRow => {
    if (item.kind === "run") {
      const run = item.run;
      const stage = run.waiting_stage_id ? ` · ${run.waiting_stage_id}` : "";
      return {
        kind: "gate",
        key: item.key,
        runId: run.run_id,
        title: run.waiting_summary?.trim() || `${run.pipeline_id} is waiting on you`,
        meta: `${runLabel(run)} · ${run.pipeline_id}${stage} · waiting ${ageShort(item.at, now)}`,
        since: item.at,
      };
    }
    const approval = item.approval;
    const who = approval.agentName ?? approval.agentId;
    const detail = approvalPreview(approval.payload, 60);
    return {
      kind: "agent",
      key: item.key,
      approvalId: approval.id,
      agentId: approval.agentId,
      sessionId: approval.sessionId,
      title: `${who} wants to use ${approval.tool}`,
      meta: `${detail ? `${detail} · ` : ""}waiting ${ageShort(item.at, now)}`,
      since: item.at,
    };
  });
}

export function failedRows(runs: readonly RunSummary[], limit = 3): FailedRow[] {
  return buckets(runs)
    .broken.slice()
    .sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at))
    .slice(0, limit)
    .map((run) => ({
      key: run.run_id,
      runId: run.run_id,
      stageId: run.failed_stage_id ?? null,
      label: `${runLabel(run)}${run.failed_stage_id ? ` · ${run.failed_stage_id}` : ""}`,
      reason: run.failed_reason?.split("\n")[0]?.trim() ?? "",
      at: run.updated_at ?? run.created_at,
    }));
}

/** The gate or approval that has waited longest, for the "longest waiting" tile. */
export function oldestWaiting(rows: readonly NeedsRow[], now: number): { ms: number; label: string } | null {
  let oldest: NeedsRow | null = null;
  for (const row of rows) if (!oldest || row.since < oldest.since) oldest = row;
  if (!oldest) return null;
  return {
    ms: Math.max(0, now - Date.parse(oldest.since)),
    label: oldest.meta.split(" · waiting")[0] ?? oldest.title,
  };
}

// ── Headline ────────────────────────────────────────────────────────────────

export type Headline = { tone: "needs" | "ok"; accent: string; rest: string };

export function headline(needsCount: number): Headline {
  if (needsCount === 0) return { tone: "ok", accent: "All clear.", rest: " Nothing needs you." };
  return {
    tone: "needs",
    accent: `${needsCount} ${needsCount === 1 ? "thing" : "things"}`,
    rest: needsCount === 1 ? " needs you." : " need you.",
  };
}

export type Subline = { inFlight: number; failedLastHour: number };

export function subline(runs: readonly RunSummary[], now: number): Subline {
  const grouped = buckets(runs);
  return {
    inFlight: grouped.inFlight.length + grouped.waiting.length,
    failedLastHour: grouped.broken.filter((run) => now - Date.parse(run.updated_at ?? run.created_at) <= HOUR).length,
  };
}

// ── KPIs ────────────────────────────────────────────────────────────────────

export type Kpi = {
  id: "runs" | "success" | "spend";
  label: string;
  value: string;
  delta: { text: string; direction: "up" | "down" | "flat"; good: boolean | null } | null;
  note: string;
  series: number[];
};

const RANGE_PHRASE: Record<OverviewRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const RANGE_NOUN: Record<OverviewRange, string> = { "24h": "today", "7d": "this week", "30d": "this month" };

export function kpis(overview: OverviewSummary): Kpi[] {
  const { totals, previous, range } = overview;

  let runsDelta: Kpi["delta"] = null;
  if (previous.runs > 0) {
    const change = Math.round(((totals.runs - previous.runs) / previous.runs) * 100);
    runsDelta = {
      text: `${change < 0 ? "▼" : "▲"} ${Math.abs(change)}%`,
      direction: change === 0 ? "flat" : change > 0 ? "up" : "down",
      good: null,
    };
  }

  let rateDelta: Kpi["delta"] = null;
  if (totals.success_rate != null && previous.success_rate != null) {
    const pts = Math.round((totals.success_rate - previous.success_rate) * 1000) / 10;
    rateDelta = {
      text: `${pts < 0 ? "▼" : "▲"} ${Math.abs(pts)} pts`,
      direction: pts === 0 ? "flat" : pts > 0 ? "up" : "down",
      good: pts === 0 ? null : pts > 0,
    };
  }

  const costChange = totals.cost_usd - previous.cost_usd;
  const costDelta: Kpi["delta"] =
    Math.abs(costChange) < 0.005
      ? null
      : { text: `${costChange > 0 ? "▲" : "▼"} ${formatUsd(Math.abs(costChange))}`, direction: costChange > 0 ? "up" : "down", good: null };

  return [
    {
      id: "runs",
      label: `Runs ${RANGE_NOUN[range]}`,
      value: String(totals.runs),
      delta: runsDelta,
      note: `vs previous ${RANGE_PHRASE[range]}`,
      series: overview.buckets.map((b) => b.succeeded + b.failed + b.cancelled),
    },
    {
      id: "success",
      label: "Success rate",
      value: formatPercent(totals.success_rate),
      delta: rateDelta,
      note: totals.finished > 0 ? `${totals.succeeded} of ${totals.finished} finished` : "no finished runs yet",
      series: overview.buckets.map((b) => {
        const finished = b.succeeded + b.failed;
        return finished > 0 ? b.succeeded / finished : 0;
      }),
    },
    {
      id: "spend",
      label: "Pipeline spend",
      value: formatUsd(totals.cost_usd),
      delta: costDelta,
      note: `vs previous ${RANGE_PHRASE[range]}`,
      series: [],
    },
  ];
}

// ── Chart ───────────────────────────────────────────────────────────────────

export type ChartBar = {
  key: string;
  label: string;
  succeeded: number;
  failed: number;
  cancelled: number;
  total: number;
  current: boolean;
};

export type ChartModel = { bars: ChartBar[]; max: number; ticks: number[] };

function bucketLabel(bucket: OverviewBucket, range: OverviewRange, last: boolean): string {
  const date = new Date(bucket.start);
  if (range === "24h") return `${String(date.getHours()).padStart(2, "0")}:00`;
  if (range === "7d") return last ? "Today" : date.toLocaleDateString("en-US", { weekday: "short" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A multiple of 3, so the three gridlines land on whole numbers. */
function niceMax(value: number): number {
  if (value <= 3) return 3;
  const step = value <= 12 ? 3 : value <= 45 ? 15 : value <= 120 ? 30 : 150;
  return Math.ceil(value / step) * step;
}

export function chartModel(overview: OverviewSummary): ChartModel {
  const bars = overview.buckets.map((bucket, index): ChartBar => ({
    key: bucket.start,
    label: bucketLabel(bucket, overview.range, index === overview.buckets.length - 1),
    succeeded: bucket.succeeded,
    failed: bucket.failed,
    cancelled: bucket.cancelled,
    total: bucket.succeeded + bucket.failed + bucket.cancelled,
    current: index === overview.buckets.length - 1,
  }));
  const max = niceMax(Math.max(0, ...bars.map((bar) => bar.total)));
  const ticks = [max, (max * 2) / 3, max / 3, 0].map((tick) => Math.round(tick));
  return { bars, max, ticks };
}

// ── Pipelines ───────────────────────────────────────────────────────────────

export type PipelineRow = OverviewPipeline & { flaky: boolean; tone: "ok" | "needs" | "fail" | "none" };

export function pipelineRows(overview: OverviewSummary): PipelineRow[] {
  return overview.pipelines.map((pipeline) => {
    const rate = pipeline.success_rate;
    const finished = pipeline.succeeded + pipeline.failed;
    return {
      ...pipeline,
      flaky: finished >= 2 && rate != null && rate < FLAKY_BELOW,
      tone: rate == null ? "none" : rate >= 0.9 ? "ok" : rate >= FLAKY_BELOW ? "needs" : "fail",
    };
  });
}

// ── Live now ────────────────────────────────────────────────────────────────

export type LiveRow = {
  key: string;
  runId: string;
  name: string;
  pipeline: string;
  waiting: boolean;
  stage: string;
  stages: RunSummary["stages"];
  startedAt: string;
};

export function liveRows(runs: readonly RunSummary[], limit = 6): LiveRow[] {
  const grouped = buckets(runs);
  const toRow = (run: RunSummary, waiting: boolean): LiveRow => {
    const active = run.stages.find((stage) => stage.status === "running");
    const stage = waiting
      ? `${run.waiting_stage_id ?? "gate"} · waiting on you`
      : active
        ? `${active.id}${active.attempt_count > 1 ? ` · try ${active.attempt_count}` : ""}`
        : "starting";
    return {
      key: run.run_id,
      runId: run.run_id,
      name: runLabel(run),
      pipeline: run.pipeline_id,
      waiting,
      stage,
      stages: run.stages,
      startedAt: run.created_at,
    };
  };
  return [...grouped.waiting.map((run) => toRow(run, true)), ...grouped.inFlight.map((run) => toRow(run, false))]
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function elapsedLabel(startedAt: string, now: number): string {
  return formatDuration(Math.max(0, now - Date.parse(startedAt)));
}

// ── Agent sessions ──────────────────────────────────────────────────────────

export type SessionRow = { key: string; agentId: string; sessionId: string; name: string; detail: string; startedAt: string };

export function sessionRows(
  sessions: readonly AgentSessionListItem[],
  agentNames: ReadonlyMap<string, string>,
  limit = 3,
): SessionRow[] {
  return sessions
    .filter((session) => session.status === "running" || session.status === "waiting")
    .slice(0, limit)
    .map((session) => ({
      key: session.id,
      agentId: session.agentId,
      sessionId: session.id,
      name: agentNames.get(session.agentId) ?? session.agentId,
      detail: `${session.source}${session.title ? ` · ${session.title}` : ""}${session.status === "waiting" ? " · waiting" : ""}`,
      startedAt: session.createdAt,
    }));
}

export function sessionStatsLine(stats: SessionStats | null): string | null {
  if (!stats || stats.turnsFinished7d === 0) return null;
  const rate = Math.round((stats.turnsSucceeded7d / stats.turnsFinished7d) * 100);
  const cost = stats.cost7d != null ? ` · ${formatUsd(stats.cost7d)}` : "";
  return `last 7d · ${stats.turnsFinished7d} turns · ${rate}% succeeded${cost}`;
}

// ── Activity ────────────────────────────────────────────────────────────────

export type ActivityRow = {
  key: string;
  tone: "ok" | "fail" | "idle";
  subject: string;
  text: string;
  at: string;
  runId?: string;
};

export function activityRows(runs: readonly RunSummary[], triggers: readonly TriggerListItem[], limit = 7): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const run of runs) {
    if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled") continue;
    const at = run.finished_at ?? run.updated_at ?? run.created_at;
    const base = { key: `run:${run.run_id}`, subject: runLabel(run), at, runId: run.run_id };
    if (run.status === "succeeded") rows.push({ ...base, tone: "ok", text: "succeeded" });
    else if (run.status === "failed") rows.push({ ...base, tone: "fail", text: run.failed_stage_id ? `failed at ${run.failed_stage_id}` : "failed" });
    else rows.push({ ...base, tone: "idle", text: "cancelled" });
  }
  for (const trigger of triggers) {
    if (!trigger.last_fired_at) continue;
    rows.push({
      key: `trigger:${trigger.project_root ?? ""}:${trigger.id}`,
      tone: "idle",
      subject: trigger.id,
      text: `trigger started ${trigger.pipeline}`,
      at: trigger.last_fired_at,
      ...(trigger.last_run_id ? { runId: trigger.last_run_id } : {}),
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// ── Triggers ────────────────────────────────────────────────────────────────

export type TriggerRow = {
  key: string;
  id: string;
  project_root?: string;
  tone: "ok" | "idle" | "fail";
  detail: string;
  when: string;
};

function untilLabel(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "due";
  if (ms < HOUR) return `in ${Math.max(1, Math.round(ms / MINUTE))}m`;
  if (ms < DAY) return `in ${Math.round(ms / HOUR)}h`;
  return `in ${Math.round(ms / DAY)}d`;
}

export function triggerRows(triggers: readonly TriggerListItem[], now: number, limit = 4): TriggerRow[] {
  const rank = (t: TriggerListItem) => (t.enabled ? (t.next_run_at ? 0 : 1) : 2);
  return triggers
    .filter((trigger) => trigger.kind !== "manual")
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (a.next_run_at ?? "￿").localeCompare(b.next_run_at ?? "￿") || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((trigger): TriggerRow => {
      const via = trigger.kind === "schedule" ? `cron · ${trigger.schedule?.cron ?? ""}` : `event · ${trigger.event?.source ?? ""}`;
      return {
        key: `${trigger.project_root ?? ""}:${trigger.id}`,
        id: trigger.id,
        ...(trigger.project_root ? { project_root: trigger.project_root } : {}),
        tone: !trigger.enabled ? "idle" : trigger.adapter_status?.last_error != null ? "fail" : "ok",
        detail: `${via} → ${trigger.pipeline}`,
        when: !trigger.enabled
          ? "off"
          : trigger.next_run_at
            ? untilLabel(trigger.next_run_at, now)
            : trigger.last_fired_at
              ? `fired ${ageShort(trigger.last_fired_at, now)} ago`
              : "armed",
      };
    });
}

export function triggerSummary(triggers: readonly TriggerListItem[]): { armed: number; total: number } {
  const real = triggers.filter((trigger) => trigger.kind !== "manual");
  return { armed: real.filter((trigger) => trigger.enabled).length, total: real.length };
}

// ── System health ───────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

export function runStoreLine(health: CapacityHealth | null): string | null {
  const disk = health?.disk;
  if (!disk) return null;
  const used = disk.runs_bytes + disk.state_db_bytes + disk.worktrees_bytes + disk.repos_bytes + disk.a2a_artifacts_bytes;
  return `${formatBytes(used)} · ${formatBytes(disk.free_bytes)} free`;
}
