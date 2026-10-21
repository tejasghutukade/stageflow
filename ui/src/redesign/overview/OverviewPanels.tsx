import { useState } from "react";
import { ageLabel } from "../../pages/channelStatus";
import type { ConnectionRow } from "../connections/connectionsModel";
import { connectionPath, pipelinePath, triggerPath } from "../../routes";
import { Card, CardHeader, Dot } from "./OverviewCards";
import {
  agoPhrase,
  formatDuration,
  formatPercent,
  formatUsd,
  type ChartModel,
  type PipelineRow,
  type TriggerRow,
} from "./overviewModel";

const MONO = "font-['Geist_Mono',monospace]";
const PLOT_HEIGHT = 144;

// ── Runs by outcome ─────────────────────────────────────────────────────────

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--sf-text-2)]">
      <span className="block size-2 rounded-sm" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export function OutcomeChart({ chart, subtitle, loading }: { chart: ChartModel; subtitle: string; loading: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const hovered = hover != null ? chart.bars[hover] : null;
  const empty = chart.bars.every((bar) => bar.total === 0);
  return (
    <Card className={loading ? "opacity-60" : ""}>
      <div className="flex h-[46px] items-center gap-2.5 border-b border-b-[#ffffff12] px-4">
        <h2 className="text-[13px] font-semibold text-[var(--sf-text-1)]">Runs by outcome</h2>
        <span className={`text-xs text-[var(--sf-text-3)] ${MONO}`}>{subtitle}</span>
        <div className="flex-1" />
        <LegendItem color="var(--sf-ok)" label="Succeeded" />
        <LegendItem color="var(--sf-fail)" label="Failed" />
        <LegendItem color="var(--sf-text-3)" label="Cancelled" />
      </div>
      <div className="flex gap-3 px-4 pb-3 pt-5">
        <div className="flex w-5 shrink-0 flex-col items-end justify-between" style={{ height: PLOT_HEIGHT }} aria-hidden="true">
          {chart.ticks.map((tick) => (
            <span key={tick} className={`text-[11px] leading-none text-[var(--sf-text-3)] ${MONO}`}>
              {tick}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="relative" style={{ height: PLOT_HEIGHT }} role="img" aria-label={`Runs by outcome, ${subtitle}`}>
            {[0, 1, 2].map((line) => (
              <span key={line} className="absolute inset-x-0 h-px bg-[#ffffff12]" style={{ top: (PLOT_HEIGHT / 3) * line }} aria-hidden="true" />
            ))}
            <span className="absolute inset-x-0 bottom-0 h-px bg-[#ffffff1a]" aria-hidden="true" />
            <div className="relative flex h-full items-end justify-around">
              {chart.bars.map((bar, index) => {
                const unit = PLOT_HEIGHT / chart.max;
                return (
                  <div
                    key={bar.key}
                    className="relative flex h-full max-w-[56px] flex-1 flex-col justify-end gap-px px-1"
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                  >
                    {bar.failed > 0 ? <span className="block w-full rounded-sm bg-[var(--sf-fail)]" style={{ height: bar.failed * unit }} /> : null}
                    {bar.cancelled > 0 ? <span className="block w-full rounded-sm bg-[var(--sf-text-3)]" style={{ height: bar.cancelled * unit }} /> : null}
                    {bar.succeeded > 0 ? <span className="block w-full rounded-sm bg-[var(--sf-ok)]" style={{ height: bar.succeeded * unit }} /> : null}
                    {hover === index && hovered ? (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 min-w-[132px] -translate-x-1/2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-2.5 py-2 text-xs shadow-lg">
                        <div className="mb-1 font-medium text-[var(--sf-text-1)]">{hovered.label}</div>
                        <div className="flex justify-between gap-3 text-[var(--sf-text-2)]">
                          <span>Succeeded</span>
                          <span className={MONO}>{hovered.succeeded}</span>
                        </div>
                        <div className="flex justify-between gap-3 text-[var(--sf-text-2)]">
                          <span>Failed</span>
                          <span className={MONO}>{hovered.failed}</span>
                        </div>
                        <div className="flex justify-between gap-3 text-[var(--sf-text-2)]">
                          <span>Cancelled</span>
                          <span className={MONO}>{hovered.cancelled}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {empty ? (
              <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--sf-text-3)]">No runs in this window.</div>
            ) : null}
          </div>
          <div className="flex justify-around">
            {chart.bars.map((bar) => (
              <span
                key={bar.key}
                className={`max-w-[56px] flex-1 text-center text-[11px] ${MONO} ${bar.current ? "text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)]"}`}
              >
                {bar.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Pipelines ───────────────────────────────────────────────────────────────

const PIPELINE_GRID = "grid grid-cols-[minmax(0,1fr)_64px_150px_100px_80px_96px] items-center gap-4";
const EYEBROW = "text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]";

const RATE_BAR: Record<PipelineRow["tone"], string> = {
  ok: "bg-[var(--sf-ok)]",
  needs: "bg-[var(--sf-needs)]",
  fail: "bg-[var(--sf-fail)]",
  none: "bg-[var(--sf-track-empty)]",
};

export function PipelinesTable({ rows, now, loading }: { rows: PipelineRow[]; now: number; loading: boolean }) {
  return (
    <Card className={loading ? "opacity-60" : ""}>
      <CardHeader title="Pipelines" count={rows.length === 0 ? undefined : `${rows.length} ran in this window`} link={{ label: "Browse all", href: "#/pipelines" }} />
      <div className={`${PIPELINE_GRID} h-9 border-b border-b-[#ffffff12] px-4`}>
        <span className={EYEBROW}>Pipeline</span>
        <span className={`${EYEBROW} text-right`}>Runs</span>
        <span className={`${EYEBROW} text-right`}>Success</span>
        <span className={`${EYEBROW} text-right`}>Median time</span>
        <span className={`${EYEBROW} text-right`}>Cost</span>
        <span className={`${EYEBROW} text-right`}>Last run</span>
      </div>
      {rows.length === 0 ? <div className="px-4 py-6 text-[13px] text-[var(--sf-text-2)]">No pipeline has run in this window.</div> : null}
      {rows.map((row) => (
        <a
          key={row.pipeline_id}
          href={`#${pipelinePath(row.pipeline_id)}`}
          className={`${PIPELINE_GRID} h-11 border-b border-b-[#ffffff12] px-4 no-underline last:border-b-0 hover:bg-[var(--sf-active)]`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className={`truncate text-[13px] text-[var(--sf-text-1)] ${MONO}`}>{row.pipeline_id}</span>
            {row.flaky ? (
              <span className={`rounded bg-[#f2645a1f] px-1.5 text-[10px] font-semibold uppercase leading-[18px] tracking-wide text-[var(--sf-fail)] ${MONO}`}>flaky</span>
            ) : null}
          </span>
          <span className={`text-right text-xs text-[var(--sf-text-1)] ${MONO}`}>{row.runs}</span>
          <span className="flex items-center justify-end gap-2.5">
            <span className="flex h-1 w-11 overflow-hidden rounded-full bg-[var(--sf-track-empty)]" aria-hidden="true">
              <span className={`block h-1 rounded-full ${RATE_BAR[row.tone]}`} style={{ width: `${Math.round((row.success_rate ?? 0) * 100)}%` }} />
            </span>
            <span className={`w-9 text-right text-xs text-[var(--sf-text-1)] ${MONO}`}>{formatPercent(row.success_rate)}</span>
          </span>
          <span className={`text-right text-xs text-[var(--sf-text-2)] ${MONO}`}>{formatDuration(row.median_duration_ms)}</span>
          <span className={`text-right text-xs text-[var(--sf-text-2)] ${MONO}`}>{row.cost_usd > 0 ? formatUsd(row.cost_usd) : "—"}</span>
          <span className={`text-right text-xs text-[var(--sf-text-3)] ${MONO}`}>{agoPhrase(row.last_run_at, now)}</span>
        </a>
      ))}
    </Card>
  );
}

// ── Triggers + connections ──────────────────────────────────────────────────

export function TriggersCard({ rows, armed, total }: { rows: TriggerRow[]; armed: number; total: number }) {
  return (
    <Card className="min-w-0 flex-1">
      <CardHeader title="Triggers" count={total === 0 ? undefined : `${armed} armed`} link={{ label: "Manage", href: "#/triggers" }} />
      {rows.length === 0 ? <div className="px-4 py-6 text-[13px] text-[var(--sf-text-2)]">No schedule or event triggers yet.</div> : null}
      {rows.map((row) => (
        <a
          key={row.key}
          href={`#${triggerPath(row.id, row.project_root)}`}
          className="flex h-[50px] items-center gap-3 border-b border-b-[#ffffff12] px-4 no-underline last:border-b-0 hover:bg-[var(--sf-active)]"
        >
          <Dot tone={row.tone} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate text-[13px] ${MONO} ${row.tone === "idle" ? "text-[var(--sf-text-2)]" : "text-[var(--sf-text-1)]"}`}>{row.id}</span>
            <span className="truncate text-xs text-[var(--sf-text-3)]">{row.detail}</span>
          </span>
          <span className={`shrink-0 text-xs ${MONO} ${row.when === "off" ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-2)]"}`}>{row.when}</span>
        </a>
      ))}
    </Card>
  );
}

export function ConnectionsCard({ rows, now }: { rows: ConnectionRow[]; now: number }) {
  const attention = rows.filter((row) => row.status.tone === "needs").length;
  const shown = rows
    .slice()
    .sort((a, b) => Number(b.status.tone === "needs") - Number(a.status.tone === "needs"))
    .slice(0, 4);
  return (
    <Card className="min-w-0 flex-1">
      <CardHeader
        title="Connections"
        count={rows.length === 0 ? undefined : `${rows.length}${attention > 0 ? ` · ${attention} needs attention` : ""}`}
        link={{ label: "Manage", href: "#/connections" }}
      />
      {rows.length === 0 ? <div className="px-4 py-6 text-[13px] text-[var(--sf-text-2)]">No channels or email accounts connected.</div> : null}
      {shown.map((row) => (
        <a
          key={row.key}
          href={row.kind === "channel" ? `#${connectionPath(row.id)}` : "#/connections"}
          className="flex h-[50px] items-center gap-3 border-b border-b-[#ffffff12] px-4 no-underline last:border-b-0 hover:bg-[var(--sf-active)]"
        >
          <Dot tone={row.status.tone === "ok" ? "ok" : row.status.tone === "needs" ? "needs" : "idle"} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">{row.name}</span>
            <span className={`truncate text-xs text-[var(--sf-text-3)] ${MONO}`} title={row.secondary}>
              {row.status.tone === "needs" ? row.status.label : row.secondary}
            </span>
          </span>
          <span className={`shrink-0 text-xs text-[var(--sf-text-3)] ${MONO}`}>{row.checkedAt ? ageLabel(row.checkedAt, now) : ""}</span>
        </a>
      ))}
    </Card>
  );
}
