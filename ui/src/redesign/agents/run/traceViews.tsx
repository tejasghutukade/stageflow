import { LuBot, LuBrain, LuCircleAlert, LuCog, LuShield, LuUserCheck, LuWrench } from "react-icons/lu";
import type { ComponentType } from "react";
import type { AgentSpan } from "../../../api/agents";
import { MONO } from "../agentsTokens";
import { formatDuration } from "../model/format";
import type { RunView } from "../model/sessionView";
import { spanColor } from "../model/sessionView";
import { criticalPath, kindGroup, matchesFilter, orderSpans, spanDetail, timeBreakdown, type FilterId, type KindGroup } from "./runModel";

const ICON: Record<KindGroup, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  agent: LuBot,
  model: LuBrain,
  tool: LuWrench,
  gate: LuUserCheck,
  guardrail: LuShield,
  internal: LuCog,
};

const ICON_COLOR: Record<KindGroup, string> = {
  agent: "text-[#a78bfa]",
  model: "text-[var(--sf-running)]",
  tool: "text-[#2dd4bf]",
  gate: "text-[var(--sf-needs)]",
  guardrail: "text-[#f472b6]",
  internal: "text-[var(--sf-text-3)]",
};

type ViewProps = { run: RunView; now: number; filter: FilterId; selectedId: string | null; onSelect: (id: string) => void };

function runWindow(run: RunView, now: number) {
  const start = Date.parse(run.turn.startedAt);
  return { start, total: Math.max(1, (run.turn.endedAt ? Date.parse(run.turn.endedAt) : now) - start) };
}

function Empty({ text }: { text: string }) {
  return <p className="p-10 text-center text-xs text-[var(--sf-text-3)]">{text}</p>;
}

function SpanName({ span, depth }: { span: AgentSpan; depth: number }) {
  const group = kindGroup(span);
  const Icon = span.status === "error" ? LuCircleAlert : ICON[group];
  const detail = spanDetail(span);
  return (
    <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 18 }}>
      <Icon aria-hidden className={`size-3.5 shrink-0 ${span.status === "error" ? "text-[var(--sf-fail)]" : ICON_COLOR[group]}`} />
      <span className={`${MONO} shrink-0 text-xs ${span.status === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-1)]"}`}>{span.name}</span>
      {detail ? <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>{detail}</span> : null}
    </span>
  );
}

export function Waterfall({ run, now, filter, selectedId, onSelect }: ViewProps) {
  const { start, total } = runWindow(run, now);
  const rows = orderSpans(run.spans).filter((r) => matchesFilter(r.span, filter));
  if (rows.length === 0) return <Empty text={run.spans.length === 0 ? "No spans were recorded for this run." : "No spans match this filter."} />;
  return (
    <div className="flex flex-col" data-testid="run-waterfall">
      <div className="flex h-9 shrink-0 items-center border-b border-b-[var(--sf-hairline)] px-6 text-[10px] uppercase tracking-[0.5px] text-[var(--sf-text-3)]">
        <span className="w-[340px] shrink-0">Span</span>
        <div className="flex flex-1 justify-between">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} className={MONO}>{formatDuration(Math.round(total * f))}</span>
          ))}
        </div>
        <span className="w-[64px] shrink-0 text-right">Dur</span>
      </div>
      {rows.map(({ span, depth }) => {
        const from = Math.min(99, Math.max(0, ((Date.parse(span.startedAt) - start) / total) * 100));
        const width = Math.max(0.6, ((span.durationMs ?? total - (Date.parse(span.startedAt) - start)) / total) * 100);
        const selected = selectedId === span.id;
        return (
          <button
            key={span.id}
            type="button"
            onClick={() => onSelect(span.id)}
            aria-pressed={selected}
            className={`flex h-9 w-full shrink-0 items-center border-b border-b-[var(--sf-hairline)] px-6 text-left hover:bg-[var(--sf-panel)] ${selected ? "bg-[var(--sf-running-bg)] shadow-[inset_2px_0_0_var(--sf-running)]" : span.status === "error" ? "bg-[var(--sf-fail-bg)]" : ""}`}
          >
            <span className="w-[340px] shrink-0 overflow-hidden"><SpanName span={span} depth={depth} /></span>
            <span className="relative h-full flex-1">
              <span className={`absolute top-[13px] h-2.5 rounded-sm ${spanColor(span)}`} style={{ left: `${from}%`, width: `${Math.min(width, 100 - from)}%` }} />
            </span>
            <span className={`${MONO} w-[64px] shrink-0 text-right text-[11px] ${span.status === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`}>{formatDuration(span.durationMs)}</span>
          </button>
        );
      })}
      <TimeBreakdown run={run} />
    </div>
  );
}

function TimeBreakdown({ run }: { run: RunView }) {
  const slices = timeBreakdown(run);
  if (slices.length === 0) return null;
  const path = criticalPath(run.spans);
  return (
    <section className="flex flex-col gap-3 px-6 py-5" data-testid="time-breakdown">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-[13px] font-medium text-[var(--sf-text-1)]">Where the time went</h3>
        {path ? <span className={`${MONO} truncate text-[11px] text-[var(--sf-text-3)]`}>critical path {path}</span> : null}
      </div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
        {slices.map((slice) => (
          <span key={slice.id} title={`${slice.label} ${formatDuration(slice.ms)}`} style={{ flex: `${slice.ms} 1 0%`, background: slice.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {slices.map((slice) => (
          <span key={slice.id} className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>{slice.label} {formatDuration(slice.ms)} · {slice.percent}%</span>
        ))}
      </div>
    </section>
  );
}

export function FlameGraph({ run, now, filter, selectedId, onSelect }: ViewProps) {
  const { start, total } = runWindow(run, now);
  const rows = orderSpans(run.spans);
  if (rows.length === 0) return <Empty text="No spans were recorded for this run." />;
  const depths = Math.max(...rows.map((r) => r.depth)) + 1;
  return (
    <div className="flex flex-col gap-2 px-6 py-5" data-testid="run-flame">
      <div className="flex justify-between text-[10px] text-[var(--sf-text-3)]">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f} className={MONO}>{formatDuration(Math.round(total * f))}</span>
        ))}
      </div>
      {Array.from({ length: depths }, (_, level) => (
        <div key={level} className="relative h-7 w-full rounded-sm bg-[var(--sf-panel)]">
          {rows
            .filter((r) => r.depth === level)
            .map(({ span }) => {
              const from = Math.min(99.4, Math.max(0, ((Date.parse(span.startedAt) - start) / total) * 100));
              const width = Math.max(0.6, ((span.durationMs ?? total) / total) * 100);
              const dim = !matchesFilter(span, filter);
              return (
                <button
                  key={span.id}
                  type="button"
                  title={`${span.name} · ${formatDuration(span.durationMs)}`}
                  onClick={() => onSelect(span.id)}
                  aria-pressed={selectedId === span.id}
                  className={`absolute top-0 flex h-7 items-center overflow-hidden rounded-sm px-1.5 text-left text-[11px] text-[var(--sf-ground)] ${spanColor(span)} ${dim ? "opacity-25" : ""} ${selectedId === span.id ? "outline outline-2 outline-[var(--sf-text-1)]" : ""}`}
                  style={{ left: `${from}%`, width: `${Math.min(width, 100 - from)}%` }}
                >
                  <span className={`${MONO} truncate`}>{span.name}</span>
                </button>
              );
            })}
        </div>
      ))}
      <p className="pt-2 text-[11px] text-[var(--sf-text-3)]">Each row is one level of nesting; width is time. Click a span for details.</p>
    </div>
  );
}

export function SpanList({ run, filter, selectedId, onSelect }: Omit<ViewProps, "now">) {
  const rows = orderSpans(run.spans).filter((r) => matchesFilter(r.span, filter));
  if (rows.length === 0) return <Empty text={run.spans.length === 0 ? "No spans were recorded for this run." : "No spans match this filter."} />;
  return (
    <div className="flex flex-col" data-testid="run-span-list">
      <div className="grid grid-cols-[minmax(0,1fr)_90px_80px_70px_90px] items-center gap-4 border-b border-b-[var(--sf-hairline)] px-6 py-2 text-[10px] uppercase tracking-[0.5px] text-[var(--sf-text-3)]">
        <span>Span</span><span>Kind</span><span>Status</span><span className="text-right">Tokens</span><span className="text-right">Duration</span>
      </div>
      {rows.map(({ span, depth }) => (
        <button
          key={span.id}
          type="button"
          onClick={() => onSelect(span.id)}
          aria-pressed={selectedId === span.id}
          className={`grid grid-cols-[minmax(0,1fr)_90px_80px_70px_90px] items-center gap-4 border-b border-b-[var(--sf-hairline)] px-6 py-2.5 text-left hover:bg-[var(--sf-panel)] ${selectedId === span.id ? "bg-[var(--sf-running-bg)]" : ""}`}
        >
          <SpanName span={span} depth={depth} />
          <span className="text-xs text-[var(--sf-text-2)]">{span.kind}</span>
          <span className={`text-xs ${span.status === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-2)]"}`}>{span.status}</span>
          <span className={`${MONO} text-right text-[11px] text-[var(--sf-text-3)]`}>{(span.inputTokens ?? 0) + (span.outputTokens ?? 0) || "—"}</span>
          <span className={`${MONO} text-right text-[11px] text-[var(--sf-text-3)]`}>{formatDuration(span.durationMs)}</span>
        </button>
      ))}
    </div>
  );
}
