import { useCallback, useEffect, useMemo, useState } from "react";
import { LuCheck, LuCopy, LuDownload, LuTriangleAlert, LuUserCheck } from "react-icons/lu";
import { agentsApi, type AgentSessionDetail, type AgentSpan } from "../../../api/agents";
import { agentPath, agentSessionPath, agentsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { AgentLoadError } from "../AgentLoadState";
import { MONO, NOWRAP, PAGE_BG } from "../agentsTokens";
import { clockTime, formatCost, formatDuration, formatTokens, shortSessionId } from "../model/format";
import { runViews, spanColor, SPAN_COLOR, type RunView } from "../model/sessionView";
import { Breadcrumb, Button, PageFooter } from "../ui";

type Tab = "waterfall" | "spans" | "messages";

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{label}</span>
      <span className={`${MONO} text-xl leading-[1.4] text-[var(--sf-text-1)]`}>{value}</span>
      <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{detail}</span>
    </div>
  );
}

function StatusChip({ run }: { run: RunView }) {
  const { status } = run.turn;
  if (status === "waiting")
    return (
      <span className="flex h-7 items-center gap-1.5 rounded-md bg-[#f5b5441f] px-2">
        <LuUserCheck aria-hidden className="size-3.5 text-[var(--sf-needs)]" />
        <span className={`text-xs font-medium text-[var(--sf-needs)] ${NOWRAP}`}>Waiting on you</span>
      </span>
    );
  if (status === "succeeded")
    return (
      <span className="flex h-7 items-center gap-1.5 rounded-md bg-[#4cc38a1a] px-2">
        <LuCheck aria-hidden className="size-3.5 text-[var(--sf-ok)]" />
        <span className={`text-xs font-medium text-[var(--sf-ok)] ${NOWRAP}`}>Succeeded</span>
      </span>
    );
  if (status === "running")
    return <span className={`flex h-7 items-center rounded-md bg-[var(--sf-running-bg)] px-2 text-xs font-medium text-[var(--sf-running)] ${NOWRAP}`}>Running</span>;
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--sf-fail-bg)] px-2">
      <LuTriangleAlert aria-hidden className="size-3.5 text-[var(--sf-fail)]" />
      <span className={`text-xs font-medium text-[var(--sf-fail)] ${NOWRAP}`}>
        {status === "cancelled" ? "Stopped" : (run.turn.errorCode ?? "Failed")}
      </span>
    </span>
  );
}

function Waterfall({ run, now }: { run: RunView; now: number }) {
  const start = Date.parse(run.turn.startedAt);
  const total = Math.max(1, (run.turn.endedAt ? Date.parse(run.turn.endedAt) : now) - start);
  const [open, setOpen] = useState<string | null>(null);
  const spans = [...run.spans].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const depth = (span: AgentSpan): number => {
    let level = 0;
    let parent = span.parentSpanId;
    while (parent && level < 8) {
      level += 1;
      parent = spans.find((s) => s.id === parent)?.parentSpanId ?? null;
    }
    return level;
  };
  if (spans.length === 0) return <p className="p-10 text-center text-xs text-[var(--sf-text-3)]">No spans were recorded for this run.</p>;
  return (
    <div className="flex flex-col" data-testid="run-waterfall">
      <div className="flex h-9 shrink-0 items-center border-b border-b-[var(--sf-hairline)] px-7 text-[11px] text-[var(--sf-text-3)]">
        <span className="w-[320px] shrink-0">Span</span>
        <div className="flex flex-1 justify-between">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} className={MONO}>{formatDuration(Math.round(total * f))}</span>
          ))}
        </div>
      </div>
      {spans.map((span) => {
        const from = ((Date.parse(span.startedAt) - start) / total) * 100;
        const width = Math.max(0.5, ((span.durationMs ?? total - (Date.parse(span.startedAt) - start)) / total) * 100);
        const selected = open === span.id;
        return (
          <div key={span.id} className="border-b border-b-[var(--sf-hairline)]">
            <button
              type="button"
              onClick={() => setOpen(selected ? null : span.id)}
              className="flex h-9 w-full items-center px-7 text-left hover:bg-[var(--sf-panel)]"
            >
              <span className="flex w-[320px] shrink-0 items-center gap-2 truncate" style={{ paddingLeft: depth(span) * 14 }}>
                <span className={`block size-2 shrink-0 rounded-sm ${spanColor(span)}`} />
                <span className={`${MONO} truncate text-xs ${span.status === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-1)]"}`}>{span.name}</span>
              </span>
              <span className="relative h-4 flex-1">
                <span className={`absolute top-1 h-2 rounded-sm ${spanColor(span)}`} style={{ left: `${from}%`, width: `${Math.min(width, 100 - from)}%` }} />
              </span>
              <span className={`${MONO} w-[70px] shrink-0 text-right text-[11px] text-[var(--sf-text-3)]`}>{formatDuration(span.durationMs)}</span>
            </button>
            {selected ? <SpanDetail span={span} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function SpanDetail({ span }: { span: AgentSpan }) {
  const attributes: Array<[string, string]> = [
    ["kind", span.kind],
    ["status", span.status],
    ["started", clockTime(span.startedAt)],
    ...(span.inputTokens !== null ? ([["tokens in", String(span.inputTokens)]] as Array<[string, string]>) : []),
    ...(span.outputTokens !== null ? ([["tokens out", String(span.outputTokens)]] as Array<[string, string]>) : []),
    ...Object.entries(span.attributes).map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  ];
  return (
    <div className="flex flex-col gap-3 bg-[var(--sf-panel)] px-7 py-4">
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1">
        {attributes.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>{name}</dt>
            <dd className={`${MONO} break-all text-[11px] text-[var(--sf-text-1)]`}>{value}</dd>
          </div>
        ))}
      </dl>
      {span.inputText !== null ? <Payload label="Input" text={span.inputText} /> : null}
      {span.outputText !== null ? <Payload label="Output" text={span.outputText} /> : null}
      {span.inputText === null && span.outputText === null ? (
        <p className="text-[11px] text-[var(--sf-text-3)]">Content capture is off for this agent, so only metadata was recorded.</p>
      ) : null}
    </div>
  );
}

function Payload({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-[var(--sf-text-3)]">{label}</span>
      <pre className={`${MONO} max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-bg,transparent)] p-3 text-[11px] leading-[1.5] text-[var(--sf-text-1)]`}>{text}</pre>
    </div>
  );
}

function SpanList({ run }: { run: RunView }) {
  return (
    <div className="flex flex-col">
      {run.spans.map((span) => (
        <div key={span.id} className="grid grid-cols-[minmax(0,1fr)_100px_90px_90px] items-center gap-4 border-b border-b-[var(--sf-hairline)] px-7 py-2.5">
          <span className={`${MONO} truncate text-xs text-[var(--sf-text-1)]`}>{span.name}</span>
          <span className="text-xs text-[var(--sf-text-2)]">{span.kind}</span>
          <span className={`text-xs ${span.status === "error" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-2)]"}`}>{span.status}</span>
          <span className={`${MONO} text-right text-[11px] text-[var(--sf-text-3)]`}>{formatDuration(span.durationMs)}</span>
        </div>
      ))}
      {run.spans.length === 0 ? <p className="p-10 text-center text-xs text-[var(--sf-text-3)]">No spans were recorded for this run.</p> : null}
    </div>
  );
}

function Messages({ run }: { run: RunView }) {
  const rows = [run.prompt && { who: "You", text: run.prompt.text }, run.reply && { who: "Agent", text: run.reply.text }].filter(Boolean) as Array<{ who: string; text: string }>;
  return (
    <div className="flex flex-col gap-4 px-7 py-5">
      {rows.map((row) => (
        <div key={row.who} className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--sf-text-3)]">{row.who}</span>
          <p className="whitespace-pre-wrap text-[13px] leading-[1.5] text-[var(--sf-text-1)]">{row.text}</p>
        </div>
      ))}
      {rows.length === 0 ? <p className="text-xs text-[var(--sf-text-3)]">No messages in this run.</p> : null}
    </div>
  );
}

export function AgentRunPage({ agentId, sessionId, runId }: { agentId: string; sessionId: string; runId: string }) {
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [name, setName] = useState(agentId);
  const [tab, setTab] = useState<Tab>("waterfall");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setDetail(await agentsApi.session(agentId, sessionId));
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [agentId, sessionId]);

  useEffect(() => {
    void load();
    void agentsApi.get(agentId).then((d) => setName(d.agent.name)).catch(() => undefined);
  }, [load, agentId]);

  const run = useMemo(() => (detail ? runViews(detail, now).find((r) => String(r.turn.seq) === runId) ?? null : null), [detail, now, runId]);
  const live = run?.turn.status === "running";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [live, load]);

  if (!detail || !run) {
    return <AgentLoadError loading={!error && !detail} error={error ?? (detail ? new Error(`Run #${runId} not found in this session.`) : null)} />;
  }

  const errors = run.spans.filter((span) => span.status === "error").length;
  const tools = run.spans.filter((span) => span.kind === "tool").length;
  const sessionShort = shortSessionId(sessionId);

  async function exportOtlp() {
    try {
      const blob = await agentsApi.exportOtlp(agentId, sessionId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${sessionId}.otlp.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Export failed");
    }
  }

  return (
    <div className={PAGE_BG}>
      <header className="flex shrink-0 flex-col gap-4 border-b border-b-[var(--sf-hairline)] px-7 py-5">
        <Breadcrumb
          items={[
            { label: "Agents", onClick: () => navigate(agentsPath()) },
            { label: name, onClick: () => navigate(agentPath(agentId)) },
            { label: sessionShort, onClick: () => navigate(agentSessionPath(agentId, sessionId)) },
            { label: `Run #${run.turn.seq}` },
          ]}
        />
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold leading-[1.33333] tracking-[-0.5px] text-[var(--sf-text-1)]">Run #{run.turn.seq}</h1>
              <StatusChip run={run} />
            </div>
            {run.prompt ? <p className="truncate text-[15px] leading-normal text-[var(--sf-text-1)]">{run.prompt.text}</p> : null}
            <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>trace_id {run.turn.traceId} · revision v{run.turn.revision}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button icon={<LuCopy aria-hidden className="text-[var(--sf-text-2)]" />} onClick={() => void navigator.clipboard.writeText(run.turn.traceId).then(() => showToast("Trace ID copied"))}>
              Copy trace ID
            </Button>
            <Button icon={<LuDownload aria-hidden className="text-[var(--sf-text-2)]" />} onClick={() => void exportOtlp()}>
              Export OTLP
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="grid shrink-0 grid-cols-2 gap-5 border-b border-b-[var(--sf-hairline)] px-7 py-4 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Duration" value={formatDuration(run.elapsedMs)} detail={run.waitingMs > 0 ? `${formatDuration(run.workingMs)} working` : "no human wait"} />
          <Metric label="Tokens" value={formatTokens(run.tokens)} detail={`${formatTokens(run.turn.inputTokens ?? 0)} in · ${formatTokens(run.turn.outputTokens ?? 0)} out`} />
          <Metric label="Cost" value={formatCost(run.turn.costUsd)} detail="this run" />
          <Metric label="Spans" value={String(run.spans.length)} detail={errors > 0 ? `${errors} error` : "no errors"} />
          <Metric label="Tool calls" value={String(tools)} detail={`${run.approvals.length} approval${run.approvals.length === 1 ? "" : "s"}`} />
          <Metric label="Started" value={clockTime(run.turn.startedAt)} detail={run.turn.endedAt ? `ended ${clockTime(run.turn.endedAt)}` : "in progress"} />
        </div>
        <div className="flex h-[46px] shrink-0 items-center justify-between gap-4 border-b border-b-[var(--sf-hairline)] px-7">
          <div className="flex h-full items-center gap-6" role="tablist">
            {(["waterfall", "spans", "messages"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex h-full items-center border-b-2 text-[13px] capitalize ${tab === id ? "border-b-[var(--sf-text-1)] font-medium text-[var(--sf-text-1)]" : "border-b-transparent text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"}`}
              >
                {id === "spans" ? "Span list" : id}
              </button>
            ))}
          </div>
          <div className="hidden items-center gap-3.5 xl:flex">
            {Object.entries({ agent: "Agent", model: "Model", tool: "Tool", gate: "Human gate", guardrail: "Guardrail", internal: "Internal" }).map(([kind, label]) => (
              <span key={kind} className="flex items-center gap-1.5">
                <span className={`block size-2 rounded-sm ${SPAN_COLOR[kind]}`} />
                <span className={`text-[11px] text-[var(--sf-text-3)] ${NOWRAP}`}>{label}</span>
              </span>
            ))}
          </div>
        </div>
        {tab === "waterfall" ? <Waterfall run={run} now={now} /> : tab === "spans" ? <SpanList run={run} /> : <Messages run={run} />}
      </div>

      <PageFooter left={`${run.spans.length} spans · trace ${run.turn.status}`} right={`session ${sessionShort}`} />
    </div>
  );
}
