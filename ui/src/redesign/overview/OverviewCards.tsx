import type { ReactNode } from "react";
import { LuBot, LuHand, LuRotateCcw, LuX } from "react-icons/lu";
import { RunsMiniTrackBar } from "../runs/RunsMiniTrackBar";
import { StatusPill } from "../StatusPill";
import { capacitySlotClass, capacitySlotKinds, capacityHintLine } from "../shell/capacitySlots";
import type { CapacityHealth } from "../../api";
import {
  ageShort,
  elapsedLabel,
  formatWait,
  type ActivityRow,
  type FailedRow,
  type Kpi,
  type LiveRow,
  type NeedsRow,
  type SessionRow,
} from "./overviewModel";
import { agentSessionPath, runStreamPath } from "../../routes";

const MONO = "font-['Geist_Mono',monospace]";

export function Card({ children, accent, className = "" }: { children: ReactNode; accent?: "needs"; className?: string }) {
  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border bg-[var(--sf-panel)] ${
        accent === "needs" ? "border-[#f5b5444d]" : "border-[#ffffff12]"
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  count,
  lamp,
  link,
  children,
}: {
  title: string;
  count?: string | number;
  lamp?: "needs" | "running";
  link?: { label: string; href: string };
  children?: ReactNode;
}) {
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-b-[#ffffff12] px-4">
      {lamp ? (
        <span
          className={`block size-1.5 rounded-full ${
            lamp === "needs" ? "bg-[var(--sf-needs)] shadow-[0px_0px_8px_rgba(245,181,68,0.8)]" : "bg-[var(--sf-running)]"
          }`}
          aria-hidden="true"
        />
      ) : null}
      <h2 className="text-[13px] font-semibold text-[var(--sf-text-1)]">{title}</h2>
      {count !== undefined ? <span className={`text-xs text-[var(--sf-text-3)] ${MONO}`}>{count}</span> : null}
      <div className="flex-1" />
      {children}
      {link ? (
        <a href={link.href} className="text-xs text-[var(--sf-text-2)] no-underline hover:text-[var(--sf-text-1)]">
          {link.label} →
        </a>
      ) : null}
    </div>
  );
}

export function Dot({ tone }: { tone: "ok" | "needs" | "fail" | "running" | "idle" }) {
  const color =
    tone === "ok"
      ? "bg-[var(--sf-ok)]"
      : tone === "needs"
        ? "bg-[var(--sf-needs)]"
        : tone === "fail"
          ? "bg-[var(--sf-fail)]"
          : tone === "running"
            ? "bg-[var(--sf-running)]"
            : "bg-[#3a3d44]";
  return <span className={`block size-1.5 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

const BTN = "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium no-underline disabled:opacity-50";
const BTN_GHOST = `${BTN} border border-[#ffffff1a] bg-transparent text-[var(--sf-text-1)] hover:bg-[var(--sf-raised)]`;

// ── Needs you ───────────────────────────────────────────────────────────────

export type NeedsYouCardProps = {
  rows: NeedsRow[];
  failed: FailedRow[];
  busyKey: string | null;
  error: string | null;
  onDecide: (row: Extract<NeedsRow, { kind: "agent" }>, decision: "approve" | "deny") => void;
  onRetry: (row: FailedRow) => void;
};

export function NeedsYouCard({ rows, failed, busyKey, error, onDecide, onRetry }: NeedsYouCardProps) {
  const clear = rows.length === 0 && failed.length === 0;
  return (
    <Card accent={rows.length > 0 ? "needs" : undefined} className="min-h-[200px] flex-1">
      <CardHeader title="Needs you" count={rows.length} lamp={rows.length > 0 ? "needs" : undefined} link={{ label: "Open Inbox", href: "#/inbox" }} />
      {clear ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
          <span className="text-sm font-medium text-[var(--sf-ok)]">You're clear.</span>
          <span className="text-[13px] text-[var(--sf-text-2)]">No gates, approvals or failed runs are waiting.</span>
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-3 border-b border-b-[#ffffff12] px-4 py-3">
          {row.kind === "gate" ? (
            <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-[#f5b5444d] bg-[#f5b5441f] px-2 text-xs font-medium text-[var(--sf-needs)]">
              <LuHand className="size-3" aria-hidden="true" />
              Gate
            </span>
          ) : (
            <span className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-[#6ca6ff1f] px-2 text-xs font-medium text-[var(--sf-running)]">
              <LuBot className="size-3" aria-hidden="true" />
              Agent
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]" title={row.title}>
              {row.title}
            </span>
            <span className={`truncate text-xs text-[var(--sf-text-3)] ${MONO}`} title={row.meta}>
              {row.meta}
            </span>
          </div>
          {row.kind === "gate" ? (
            <a href={`#${runStreamPath(row.runId)}`} className={`${BTN} bg-[var(--sf-needs)] font-semibold text-[#1a1306]`}>
              Review
            </a>
          ) : (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className={`${BTN} bg-[#4cc38a1f] font-semibold text-[var(--sf-ok)]`}
                disabled={busyKey === row.key}
                onClick={() => onDecide(row, "approve")}
              >
                Accept
              </button>
              <button type="button" className={BTN_GHOST} disabled={busyKey === row.key} onClick={() => onDecide(row, "deny")}>
                Reject
              </button>
              <a href={`#${agentSessionPath(row.agentId, row.sessionId)}`} className={BTN_GHOST}>
                Open
              </a>
            </div>
          )}
        </div>
      ))}
      {failed.map((row, index) => (
        <div
          key={row.key}
          className={`flex items-center gap-3 bg-[var(--sf-active)] px-4 py-3 ${index === failed.length - 1 ? "mt-auto" : "border-b border-b-[#ffffff12]"}`}
        >
          <LuX className="size-3.5 shrink-0 text-[var(--sf-fail)]" aria-hidden="true" />
          <span className={`min-w-0 flex-1 truncate text-xs text-[var(--sf-text-2)] ${MONO}`} title={row.reason ? `${row.label} · ${row.reason}` : row.label}>
            {row.label}
            {row.reason ? ` · ${row.reason}` : ""}
          </span>
          <a href={`#${runStreamPath(row.runId)}`} className={BTN_GHOST}>
            Open
          </a>
          {row.stageId ? (
            <button
              type="button"
              className={`${BTN} bg-[#f2645a1f] font-semibold text-[var(--sf-fail)]`}
              disabled={busyKey === row.key}
              onClick={() => onRetry(row)}
            >
              <LuRotateCcw className="size-3" aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </div>
      ))}
      {error ? <div className="border-t border-t-[#ffffff12] px-4 py-2 text-xs text-[var(--sf-fail)]">{error}</div> : null}
    </Card>
  );
}

// ── System health ───────────────────────────────────────────────────────────

export type HealthRow = { key: string; label: string; value: string; tone: "ok" | "needs" | "fail" | "idle"; href?: string };

export function HealthCard({
  health,
  heldCount,
  rows,
}: {
  health: CapacityHealth | null;
  heldCount: number;
  rows: HealthRow[];
}) {
  const attention = rows.filter((row) => row.tone === "needs" || row.tone === "fail").length;
  const slotKinds = health ? capacitySlotKinds(health, heldCount) : [];
  const hint = capacityHintLine(heldCount);
  return (
    <Card className="w-full shrink-0 xl:w-[340px]">
      <CardHeader title="System health">
        <span className="flex items-center gap-1.5 text-xs text-[var(--sf-text-3)]">
          <Dot tone={attention > 0 ? "needs" : "ok"} />
          {attention > 0 ? `${attention} need${attention === 1 ? "s" : ""} a look` : "All reachable"}
        </span>
      </CardHeader>
      <div className="flex flex-col gap-2.5 border-b border-b-[#ffffff12] px-4 py-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-[var(--sf-text-2)]">Agent slots</span>
          <span className={`text-xl font-medium text-[var(--sf-text-1)] ${MONO}`}>
            {health ? health.activeCount : "—"}
            <span className="text-sm text-[var(--sf-text-3)]"> / {health ? health.maxConcurrent : "—"}</span>
          </span>
        </div>
        <div className="flex gap-[3px]" aria-hidden="true">
          {slotKinds.map((kind, index) => (
            <span key={index} className={`block h-2 flex-1 rounded-sm ${capacitySlotClass(kind)}`} />
          ))}
        </div>
        {hint ? <span className="text-xs text-[var(--sf-text-3)]">{hint}</span> : null}
      </div>
      {rows.map((row) => {
        const content = (
          <>
            <Dot tone={row.tone} />
            <span className="flex-1 text-[13px] text-[var(--sf-text-1)]">{row.label}</span>
            <span className={`text-xs ${MONO} ${row.tone === "needs" ? "text-[var(--sf-needs)]" : row.tone === "fail" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-2)]"}`}>
              {row.value}
            </span>
          </>
        );
        return row.href ? (
          <a key={row.key} href={row.href} className="flex h-10 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 no-underline last:border-b-0 hover:bg-[var(--sf-active)]">
            {content}
          </a>
        ) : (
          <div key={row.key} className="flex h-10 items-center gap-2.5 border-b border-b-[#ffffff12] px-4 last:border-b-0">
            {content}
          </div>
        );
      })}
    </Card>
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────

function Sparkline({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) return <div className="mt-2 h-8" />;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const points = series.map((value, index) => [(index / (series.length - 1)) * 100, 28 - ((value - min) / span) * 24] as const);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <div className="mt-2 block h-8 w-full overflow-hidden" style={{ color }} aria-hidden="true">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" width="100%" height="100%" fill="none">
        <path d={`${line} L100 32 L0 32 Z`} fill="currentColor" fillOpacity="0.12" />
        <path d={line} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

const KPI_COLOR: Record<Kpi["id"], string> = {
  runs: "var(--sf-running)",
  success: "var(--sf-ok)",
  spend: "var(--sf-running)",
};

export function KpiRow({
  kpis,
  longestWaiting,
  loading,
}: {
  kpis: Kpi[];
  longestWaiting: { ms: number; label: string; href: string } | null;
  loading: boolean;
}) {
  const [runs, success, spend] = kpis;
  const ordered = [runs, success].filter((kpi): kpi is Kpi => kpi !== undefined);
  return (
    <div className={`grid grid-cols-2 gap-4 xl:grid-cols-4 ${loading ? "opacity-60" : ""}`}>
      {ordered.map((kpi) => (
        <KpiCard key={kpi.id} kpi={kpi} />
      ))}
      <Card accent={longestWaiting ? "needs" : undefined} className="gap-1 p-4">
        <span className="text-xs text-[var(--sf-text-2)]">Longest waiting on you</span>
        <span className={`text-[28px] font-medium leading-[1.2] tracking-tight ${MONO} ${longestWaiting ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-1)]"}`}>
          {longestWaiting ? formatWait(longestWaiting.ms) : "—"}
        </span>
        <span className={`truncate text-xs text-[var(--sf-text-3)] ${MONO}`} title={longestWaiting?.label}>
          {longestWaiting ? longestWaiting.label : "nothing is waiting"}
        </span>
        {longestWaiting ? (
          <a href={longestWaiting.href} className={`${BTN_GHOST} mt-auto w-fit`}>
            Open it
          </a>
        ) : null}
      </Card>
      {spend ? <KpiCard kpi={spend} /> : null}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const deltaColor = kpi.delta?.good === true ? "text-[var(--sf-ok)]" : kpi.delta?.good === false ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-2)]";
  return (
    <Card className="gap-1 p-4">
      <span className="text-xs text-[var(--sf-text-2)]">{kpi.label}</span>
      <span className={`text-[28px] font-medium leading-[1.2] tracking-tight text-[var(--sf-text-1)] ${MONO}`}>{kpi.value}</span>
      <span className="text-xs text-[var(--sf-text-3)]">
        {kpi.delta ? <span className={deltaColor}>{kpi.delta.text}</span> : null}
        {kpi.delta ? " " : ""}
        {kpi.note}
      </span>
      <Sparkline series={kpi.series} color={KPI_COLOR[kpi.id]} />
    </Card>
  );
}

// ── Live now ────────────────────────────────────────────────────────────────

export function LiveNowCard({
  rows,
  sessions,
  statsLine,
  now,
}: {
  rows: LiveRow[];
  sessions: SessionRow[];
  statsLine: string | null;
  now: number;
}) {
  return (
    <Card className="min-w-0 flex-1">
      <CardHeader title="Live now" count={rows.length} lamp="running" link={{ label: "All runs", href: "#/runs" }} />
      {rows.length === 0 ? <div className="px-4 py-6 text-[13px] text-[var(--sf-text-2)]">No runs in flight.</div> : null}
      {rows.map((row) => (
        <a
          key={row.key}
          href={`#${runStreamPath(row.runId)}`}
          className="flex h-[52px] items-center gap-3 border-b border-b-[#ffffff12] px-4 no-underline hover:bg-[var(--sf-active)]"
        >
          <span className="flex w-[96px] shrink-0">
            <StatusPill signal={row.waiting ? "needs" : "running"} label={row.waiting ? "Needs you" : "Running"} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate text-[13px] font-medium text-[var(--sf-text-1)] ${MONO}`}>{row.name}</span>
            <span className={`truncate text-xs text-[var(--sf-text-3)] ${MONO}`}>{row.pipeline}</span>
          </span>
          <span className="hidden w-[120px] shrink-0 md:flex">
            <RunsMiniTrackBar stages={row.stages.map((stage) => ({ id: stage.id, status: stage.status }))} />
          </span>
          <span className={`hidden w-[150px] shrink-0 truncate text-right text-xs text-[var(--sf-text-2)] lg:block ${MONO}`}>{row.stage}</span>
          <span className={`w-[64px] shrink-0 text-right text-xs ${MONO} ${row.waiting ? "text-[var(--sf-text-3)]" : "text-[var(--sf-running)]"}`}>
            {elapsedLabel(row.startedAt, now)}
          </span>
        </a>
      ))}
      <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-b-[#ffffff12] bg-[var(--sf-active)] px-4">
        <Dot tone="running" />
        <h2 className="text-[13px] font-semibold text-[var(--sf-text-1)]">Agent sessions</h2>
        <span className={`text-xs text-[var(--sf-text-3)] ${MONO}`}>{sessions.length}</span>
        <div className="flex-1" />
        <a href="#/agent-sessions" className="text-xs text-[var(--sf-text-2)] no-underline hover:text-[var(--sf-text-1)]">
          All sessions →
        </a>
      </div>
      {sessions.length === 0 ? <div className="px-4 py-4 text-[13px] text-[var(--sf-text-2)]">No agent sessions running.</div> : null}
      {sessions.map((session) => (
        <a
          key={session.key}
          href={`#${agentSessionPath(session.agentId, session.sessionId)}`}
          className="flex h-12 items-center gap-3 border-b border-b-[#ffffff12] px-4 no-underline hover:bg-[var(--sf-active)]"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-[#ffffff12] bg-[var(--sf-raised)] text-[11px] font-semibold text-[var(--sf-text-2)]">
            {session.name.charAt(0).toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">{session.name}</span>
            <span className="truncate text-xs text-[var(--sf-text-3)]">{session.detail}</span>
          </span>
          <span className={`text-xs text-[var(--sf-running)] ${MONO}`}>{elapsedLabel(session.startedAt, now)}</span>
        </a>
      ))}
      {statsLine ? <div className={`mt-auto px-4 py-3 text-xs text-[var(--sf-text-3)] ${MONO}`}>{statsLine}</div> : null}
    </Card>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

export function ActivityCard({ rows, now }: { rows: ActivityRow[]; now: number }) {
  return (
    <Card className="w-full shrink-0 xl:w-[340px]">
      <CardHeader title="Activity" link={{ label: "Run history", href: "#/runs" }} />
      {rows.length === 0 ? <div className="px-4 py-6 text-[13px] text-[var(--sf-text-2)]">Nothing has finished yet.</div> : null}
      {rows.map((row) => {
        const body = (
          <>
            <Dot tone={row.tone} />
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--sf-text-2)]">
              <span className="font-medium text-[var(--sf-text-1)]">{row.subject}</span> {row.text}
            </span>
            <span className={`shrink-0 text-xs text-[var(--sf-text-3)] ${MONO}`}>{ageShort(row.at, now)}</span>
          </>
        );
        const cls = "flex h-[42px] items-center gap-2.5 border-b border-b-[#ffffff12] px-4 no-underline last:border-b-0";
        return row.runId ? (
          <a key={row.key} href={`#${runStreamPath(row.runId)}`} className={`${cls} hover:bg-[var(--sf-active)]`}>
            {body}
          </a>
        ) : (
          <div key={row.key} className={cls}>
            {body}
          </div>
        );
      })}
    </Card>
  );
}
