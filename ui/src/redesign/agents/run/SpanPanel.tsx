import { useState } from "react";
import { LuCircleAlert, LuCircleCheck } from "react-icons/lu";
import type { AgentSpan } from "../../../api/agents";
import { EYEBROW, MONO, NOWRAP } from "../agentsTokens";
import { clockTime, formatCost, formatDuration } from "../model/format";
import { kindGroup, KIND_LABEL, spanCost, spanTokens } from "./runModel";

type PanelTab = "attributes" | "io" | "links" | "raw";

function Row({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={`${MONO} shrink-0 text-[11px] leading-[1.6] text-[var(--sf-text-3)]`}>{name}</span>
      <span className={`${MONO} min-w-0 break-all text-right text-[11px] leading-[1.6] text-[var(--sf-text-1)]`}>{value}</span>
    </div>
  );
}

function Group({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <span className={`${MONO} text-[10px] uppercase tracking-[0.5px] text-[#4cc38a]`}>{title}</span>
      {rows.map(([name, value]) => (
        <Row key={name} name={name} value={value} />
      ))}
    </section>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={`${MONO} text-[10px] uppercase tracking-[0.5px] text-[var(--sf-text-3)]`}>{label}</span>
      <pre className={`${MONO} max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-[11px] leading-[1.5] text-[var(--sf-text-1)]`}>{text}</pre>
    </div>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Right-hand detail for the selected span, shared by Waterfall, Flame graph and Span list. */
export function SpanPanel({ span, spans, onSelect, traceId }: { span: AgentSpan | null; spans: AgentSpan[]; onSelect: (id: string) => void; traceId: string }) {
  const [tab, setTab] = useState<PanelTab>("attributes");
  if (!span) {
    return <aside className="hidden w-[400px] shrink-0 border-l border-l-[var(--sf-hairline)] p-6 text-xs text-[var(--sf-text-3)] xl:block">Select a span to see its attributes.</aside>;
  }
  const entries = Object.entries(span.attributes);
  const genAi = entries.filter(([k]) => k.startsWith("gen_ai.")).map(([k, v]): [string, string] => [k, asString(v)]);
  const stageflow = entries.filter(([k]) => k.startsWith("stageflow.")).map(([k, v]): [string, string] => [k, asString(v)]);
  const other = entries.filter(([k]) => !k.startsWith("gen_ai.") && !k.startsWith("stageflow.")).map(([k, v]): [string, string] => [k, asString(v)]);
  const parent = span.parentSpanId ? spans.find((s) => s.id === span.parentSpanId) ?? null : null;
  const children = spans.filter((s) => s.parentSpanId === span.id);
  const cost = spanCost(span);
  const failed = span.status === "error";
  const hasIo = span.inputText !== null || span.outputText !== null;
  const tabs: Array<[PanelTab, string]> = [
    ["attributes", `Attributes ${entries.length + 3}`],
    ["io", "Input & output"],
    ["links", `Links ${(parent ? 1 : 0) + children.length}`],
    ["raw", "Raw OTLP"],
  ];
  return (
    <aside className="flex w-full shrink-0 flex-col border-t border-t-[var(--sf-hairline)] xl:w-[400px] xl:border-l xl:border-t-0 xl:border-l-[var(--sf-hairline)]" data-testid="span-panel">
      <div className="flex flex-col gap-2 border-b border-b-[var(--sf-hairline)] px-5 py-4">
        <div className="flex items-center justify-between">
          <span className={`${MONO} rounded-md bg-[var(--sf-raised)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--sf-text-2)]`}>{KIND_LABEL[kindGroup(span)]} · SpanKind.{span.kind === "agent" || span.kind === "sub_agent" ? "INTERNAL" : span.kind === "model" ? "CLIENT" : "INTERNAL"}</span>
          <span className={`${MONO} flex items-center gap-1 text-[11px] ${failed ? "text-[var(--sf-fail)]" : "text-[var(--sf-ok)]"}`}>
            {failed ? <LuCircleAlert aria-hidden /> : <LuCircleCheck aria-hidden />}status {span.status}
          </span>
        </div>
        <h2 className={`${MONO} break-all text-[15px] font-medium text-[var(--sf-text-1)]`}>{span.name}</h2>
        <p className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>
          {formatDuration(span.durationMs)} · {clockTime(span.startedAt)}
          {spanTokens(span) > 0 ? ` · ${spanTokens(span)} tok` : ""}
          {cost !== null ? ` · ${formatCost(cost)}` : ""}
        </p>
      </div>
      <div className="flex h-10 shrink-0 items-center gap-5 border-b border-b-[var(--sf-hairline)] px-5" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`h-full border-b-2 text-xs ${NOWRAP} ${tab === id ? "border-b-[var(--sf-text-1)] font-medium text-[var(--sf-text-1)]" : "border-b-transparent text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
        {tab === "attributes" ? (
          <>
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-3">
              {[
                ["span_id", span.id],
                ["parent_span_id", span.parentSpanId ?? "—"],
                ["trace_id", traceId],
                ["parent", parent?.name ?? "root"],
              ].map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col gap-0.5">
                  <span className={`${MONO} text-[10px] text-[var(--sf-text-3)]`}>{k}</span>
                  <span className={`${MONO} break-all text-[11px] text-[var(--sf-text-1)]`}>{v}</span>
                </div>
              ))}
            </div>
            <Group title="gen_ai.* semantic conventions" rows={genAi} />
            <Group title="stageflow.*" rows={stageflow} />
            <Group title="other" rows={other} />
            {entries.length === 0 ? <p className="text-xs text-[var(--sf-text-3)]">No extra attributes were recorded.</p> : null}
          </>
        ) : null}
        {tab === "io" ? (
          <>
            {span.inputText !== null ? <Block label="Input" text={pretty(span.inputText)} /> : null}
            {span.outputText !== null ? <Block label="Output" text={pretty(span.outputText)} /> : null}
            {!hasIo ? <p className="text-xs leading-normal text-[var(--sf-text-3)]">Content capture is off for this agent, so only metadata was recorded. Turn on full trace capture in the agent’s Observability settings to keep prompts and results.</p> : null}
          </>
        ) : null}
        {tab === "links" ? (
          <div className="flex flex-col gap-2">
            {parent ? <LinkRow label="Parent" span={parent} onSelect={onSelect} /> : null}
            {children.map((child) => (
              <LinkRow key={child.id} label="Child" span={child} onSelect={onSelect} />
            ))}
            {!parent && children.length === 0 ? <p className="text-xs text-[var(--sf-text-3)]">This span has no parent or children.</p> : null}
          </div>
        ) : null}
        {tab === "raw" ? <Block label="OTLP span (as stored)" text={JSON.stringify({ traceId, spanId: span.id, parentSpanId: span.parentSpanId, name: span.name, kind: span.kind, status: span.status, startTime: span.startedAt, endTime: span.endedAt, attributes: span.attributes }, null, 2)} /> : null}
      </div>
    </aside>
  );
}

function LinkRow({ label, span, onSelect }: { label: string; span: AgentSpan; onSelect: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onSelect(span.id)} className="flex items-center justify-between gap-3 rounded-md border border-[var(--sf-hairline)] px-3 py-2 text-left hover:bg-[var(--sf-panel)]">
      <span className={EYEBROW}>{label}</span>
      <span className={`${MONO} min-w-0 truncate text-xs text-[var(--sf-text-1)]`}>{span.name}</span>
      <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>{formatDuration(span.durationMs)}</span>
    </button>
  );
}
