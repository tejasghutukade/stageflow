import { useCallback, useEffect, useMemo, useState } from "react";
import { retryStageWithDetails, type OverviewRange } from "../../api";
import { agentsApi } from "../../api/agents";
import { heldWaitingCount } from "../../catalog/views";
import { useRunCatalog, useRunCatalogHandle } from "../../catalog/useRunCatalog";
import { runStreamPath } from "../../routes";
import { channelRows } from "../connections/connectionsModel";
import { useChannelMeta } from "../connections/channelMeta";
import { useAgentApprovals } from "../agents/model/useAgentApprovals";
import { PageHeader } from "../shell/PageHeader";
import { useProviderSummary } from "../shell/useProviderSummary";
import { ActivityCard, HealthCard, KpiRow, LiveNowCard, NeedsYouCard, type HealthRow, type NeedsYouCardProps } from "./OverviewCards";
import { ConnectionsCard, OutcomeChart, PipelinesTable, TriggersCard } from "./OverviewPanels";
import {
  OVERVIEW_RANGES,
  activityRows,
  chartModel,
  failedRows,
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
import { useOverview } from "./useOverview";

const RANGE_KEY = "stageflow.overview.range";
const RANGE_SUBTITLE: Record<OverviewRange, string> = { "24h": "last 24 hours · 3h buckets", "7d": "last 7 days · daily", "30d": "last 30 days · 3-day buckets" };

function readRange(): OverviewRange {
  try {
    const stored = window.sessionStorage.getItem(RANGE_KEY);
    if (stored === "24h" || stored === "7d" || stored === "30d") return stored;
  } catch {
    // Session storage can be blocked; fall back to the default.
  }
  return "7d";
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function RangeControl({ range, onChange }: { range: OverviewRange; onChange: (range: OverviewRange) => void }) {
  return (
    <div className="flex items-center rounded-lg border border-[#ffffff12] bg-[var(--sf-panel)] p-0.5" role="group" aria-label="Time range">
      {OVERVIEW_RANGES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === range}
          onClick={() => onChange(option)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            option === range ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "bg-transparent text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function OverviewRedesign() {
  const [range, setRange] = useState<OverviewRange>(readRange);
  const now = useNow();
  const { snapshot } = useRunCatalog();
  const catalog = useRunCatalogHandle();
  const { approvals, refresh: refreshApprovals } = useAgentApprovals();
  const data = useOverview(range);
  const providers = useProviderSummary();
  const { meta } = useChannelMeta();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const changeRange = useCallback((next: OverviewRange) => {
    setRange(next);
    try {
      window.sessionStorage.setItem(RANGE_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  }, []);

  const needs = useMemo(() => needsRows(snapshot.runs, approvals, now), [snapshot.runs, approvals, now]);
  const failed = useMemo(() => failedRows(snapshot.runs), [snapshot.runs]);
  const live = useMemo(() => liveRows(snapshot.runs), [snapshot.runs]);
  const activity = useMemo(() => activityRows(snapshot.runs, data.triggers), [snapshot.runs, data.triggers]);
  const sessions = useMemo(() => sessionRows(data.sessions, data.agentNames), [data.sessions, data.agentNames]);
  const connections = useMemo(() => channelRows(data.channels, data.email, meta), [data.channels, data.email, meta]);
  const triggers = useMemo(() => triggerRows(data.triggers, now), [data.triggers, now]);
  const triggerCounts = useMemo(() => triggerSummary(data.triggers), [data.triggers]);
  const overview = data.overview;
  const stale = overview != null && overview.range !== range;

  const oldest = oldestWaiting(needs, now);
  const top = headline(needs.length);
  const counts = subline(snapshot.runs, now);
  const heading = needs.length === 0 && failed.length > 0 ? { ...top, accent: "Nothing waits on you.", rest: " Some runs failed." } : top;

  const onDecide: NeedsYouCardProps["onDecide"] = (row, decision) => {
    setBusyKey(row.key);
    setActionError(null);
    agentsApi
      .decide(row.agentId, row.sessionId, decision)
      .then(() => refreshApprovals())
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyKey(null));
  };

  const onRetry: NeedsYouCardProps["onRetry"] = (row) => {
    if (!row.stageId) return;
    setBusyKey(row.key);
    setActionError(null);
    void retryStageWithDetails(row.runId, row.stageId)
      .then((result) => {
        if (!result.ok) setActionError(result.error);
        return catalog.refresh();
      })
      .finally(() => setBusyKey(null));
  };

  const channelAttention = connections.filter((row) => row.status.tone === "needs");
  const healthRows: HealthRow[] = [
    {
      key: "providers",
      label: "Providers",
      value: providers.loading ? "checking…" : providers.failed ? "unreachable" : providers.label,
      tone: providers.failed ? "fail" : providers.loading || providers.connectedCount === 0 ? "idle" : "ok",
      href: "#/settings",
    },
    {
      key: "connections",
      label: "Connections",
      value:
        connections.length === 0
          ? "none yet"
          : channelAttention.length > 0
            ? `${channelAttention.length} need${channelAttention.length === 1 ? "s" : ""} attention`
            : `${connections.length} connected`,
      tone: connections.length === 0 ? "idle" : channelAttention.length > 0 ? "needs" : "ok",
      href: "#/connections",
    },
    {
      key: "triggers",
      label: "Triggers armed",
      value: triggerCounts.total === 0 ? "none yet" : `${triggerCounts.armed} / ${triggerCounts.total}`,
      tone: triggerCounts.total === 0 ? "idle" : "ok",
      href: "#/triggers",
    },
  ];
  const store = runStoreLine(snapshot.health);
  if (store) healthRows.push({ key: "store", label: "Run store", value: store, tone: "idle" });

  const kpiList = overview ? kpis(overview) : [];

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title="Overview" subtitle="all projects" actions={<RangeControl range={range} onChange={changeRange} />} />
      <div className="mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-6 pb-10 pt-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[22px] font-semibold tracking-[-0.44px] text-[var(--sf-text-1)]">
            <span className={heading.tone === "ok" ? "text-[var(--sf-ok)]" : "text-[var(--sf-needs)]"}>{heading.accent}</span>
            {heading.rest}
          </h2>
          <p className="text-[13px] text-[var(--sf-text-2)]">
            <span className="text-[var(--sf-running)]">
              {counts.inFlight} {counts.inFlight === 1 ? "run" : "runs"}
            </span>{" "}
            in flight
            {counts.failedLastHour > 0 ? (
              <>
                {" · "}
                <span className="text-[var(--sf-fail)]">{counts.failedLastHour} failed</span> in the last hour
              </>
            ) : null}
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-4 xl:flex-row">
          <NeedsYouCard rows={needs} failed={failed} busyKey={busyKey} error={actionError} onDecide={onDecide} onRetry={onRetry} />
          <HealthCard health={snapshot.health} heldCount={heldWaitingCount(snapshot, snapshot.health)} rows={healthRows} />
        </div>

        {overview ? (
          <KpiRow
            kpis={kpiList}
            loading={stale}
            longestWaiting={oldest ? { ...oldest, href: needs[0]?.kind === "gate" ? `#${runStreamPath(needs[0].runId)}` : "#/inbox" } : null}
          />
        ) : data.overviewFailed ? (
          <div className="rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)] px-4 py-3 text-[13px] text-[var(--sf-text-2)]">
            Run statistics are unavailable right now. The rest of the page is live.
          </div>
        ) : (
          <div className="h-[128px] rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]" aria-busy="true" />
        )}

        <div className="flex flex-col items-stretch gap-4 xl:flex-row">
          <LiveNowCard rows={live} sessions={sessions} statsLine={sessionStatsLine(data.sessionStats)} now={now} />
          <ActivityCard rows={activity} now={now} />
        </div>

        {overview ? <OutcomeChart chart={chartModel(overview)} subtitle={RANGE_SUBTITLE[overview.range]} loading={stale} /> : null}
        {overview ? <PipelinesTable rows={pipelineRows(overview)} now={now} loading={stale} /> : null}

        <div className="flex flex-col items-stretch gap-4 xl:flex-row">
          <TriggersCard rows={triggers} armed={triggerCounts.armed} total={triggerCounts.total} />
          <ConnectionsCard rows={connections} now={now} />
        </div>
      </div>
    </div>
  );
}
