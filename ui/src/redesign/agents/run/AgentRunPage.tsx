import { useCallback, useEffect, useMemo, useState } from "react";
import { LuCheck, LuCopy, LuDownload, LuTriangleAlert, LuUserCheck } from "react-icons/lu";
import { agentsApi, type AgentSessionDetail } from "../../../api/agents";
import { deliveryNotice } from "../model/deliveryNotice";
import { sourceLabel } from "../model/format";
import { agentPath, agentSessionPath, agentsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { AgentLoadError } from "../AgentLoadState";
import { MONO, NOWRAP, PAGE_BG } from "../agentsTokens";
import { clockTime, formatCost, formatDuration, formatTokens, shortSessionId } from "../model/format";
import { runViews, SPAN_COLOR, type RunView } from "../model/sessionView";
import { Breadcrumb, Button, PageFooter } from "../ui";
import { ApprovalPane, Configuration, Logs, Messages, Steps } from "./otherTabs";
import { defaultSpanId, filterCounts, KIND_LABEL, kindGroup, type FilterId } from "./runModel";
import { SpanPanel } from "./SpanPanel";
import { FlameGraph, SpanList, Waterfall } from "./traceViews";

type Tab = "steps" | "waterfall" | "flame" | "spans" | "messages" | "logs" | "config";

const TRACE_TABS: Tab[] = ["waterfall", "flame", "spans"];
const KINDS = ["agent", "model", "tool", "gate", "guardrail", "internal"] as const;

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{label}</span>
      <span className={`${MONO} text-xl leading-[1.4] text-[var(--sf-text-1)]`}>{value}</span>
      <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{detail}</span>
    </div>
  );
}

function Chip({ tone, icon, children }: { tone: "ok" | "needs" | "fail" | "running"; icon?: React.ReactNode; children: React.ReactNode }) {
  const style = {
    ok: "bg-[#4cc38a1a] text-[var(--sf-ok)]",
    needs: "bg-[#f5b5441f] text-[var(--sf-needs)]",
    fail: "bg-[var(--sf-fail-bg)] text-[var(--sf-fail)]",
    running: "bg-[var(--sf-running-bg)] text-[var(--sf-running)]",
  }[tone];
  return (
    <span className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${style} ${NOWRAP}`}>
      {icon}
      {children}
    </span>
  );
}

function StatusChip({ run }: { run: RunView }) {
  const { status } = run.turn;
  if (run.turn.errorCode === "agent.reply_undelivered") {
    return (
      <Chip tone="fail" icon={<LuTriangleAlert aria-hidden className="size-3.5" />}>
        Reply not delivered
      </Chip>
    );
  }
  if (status === "waiting") return <Chip tone="needs" icon={<LuUserCheck aria-hidden className="size-3.5" />}>Waiting on you · {formatDuration(run.waitingMs)}</Chip>;
  if (status === "succeeded") return <Chip tone="ok" icon={<LuCheck aria-hidden className="size-3.5" />}>Status OK</Chip>;
  if (status === "running") return <Chip tone="running">Running</Chip>;
  return (
    <Chip tone="fail" icon={<LuTriangleAlert aria-hidden className="size-3.5" />}>
      {status === "cancelled" ? "Stopped" : (run.turn.errorCode ?? "Failed")}
    </Chip>
  );
}

export function AgentRunPage({ agentId, sessionId, runId }: { agentId: string; sessionId: string; runId: string }) {
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [name, setName] = useState(agentId);
  const [tab, setTab] = useState<Tab>("steps");
  const [filter, setFilter] = useState<FilterId>("all");
  const [spanId, setSpanId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [resending, setResending] = useState(false);
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
  const deliveryInFlight = detail?.deliveries?.some((d) => d.turnId === run?.turn.id && (d.state === "pending" || d.state === "sending" || (d.state === "failed" && d.retryable))) ?? false;
  const active = run?.turn.status === "running" || run?.turn.status === "waiting" || deliveryInFlight;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const spans = run?.spans ?? [];
  const firstSpan = useMemo(() => defaultSpanId(spans), [spans]);
  const selectedSpan = spans.find((s) => s.id === (spanId ?? firstSpan)) ?? null;
  const counts = useMemo(() => filterCounts(spans), [spans]);

  if (!detail || !run) {
    return <AgentLoadError loading={!error && !detail} error={error ?? (detail ? new Error(`Run #${runId} not found in this session.`) : null)} />;
  }

  const errors = counts.errors;
  const sessionShort = shortSessionId(sessionId);
  const evals = detail.evalScores.filter((s) => s.turnId === run.turn.id);
  const traceView = TRACE_TABS.includes(tab);
  const spanPanel = <SpanPanel span={selectedSpan} spans={spans} onSelect={setSpanId} traceId={run.turn.traceId} />;

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

  async function decide(decision: "approve" | "deny") {
    setDeciding(true);
    try {
      await agentsApi.decide(agentId, sessionId, decision);
      showToast(decision === "approve" ? "Approved" : "Denied");
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not record the decision");
    } finally {
      setDeciding(false);
    }
  }

  const delivery = detail.deliveries?.find((d) => d.turnId === run.turn.id);
  const notice = deliveryNotice(delivery, sourceLabel(detail.session.source));

  async function fixDelivery(action: "resend" | "delivered") {
    setResending(true);
    try {
      if (action === "resend") await agentsApi.resendReply(agentId, sessionId, run!.turn.id);
      else await agentsApi.markReplyDelivered(agentId, sessionId, run!.turn.id);
      showToast(action === "resend" ? "Reply sent again" : "Marked as delivered");
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update the reply");
    } finally {
      setResending(false);
    }
  }

  const tabs: Array<[Tab, string]> = [
    ["steps", "Steps"],
    ["waterfall", "Waterfall"],
    ["flame", "Flame graph"],
    ["spans", "Span list"],
    ["messages", "Messages"],
    ["logs", `Logs ${run.spans.length + run.approvals.length + 1}`],
    ["config", `Configuration v${run.turn.revision}`],
  ];
  const filters: Array<[FilterId, string]> = [["all", `All ${counts.all}`], ...KINDS.filter((k) => counts[k] > 0).map((k): [FilterId, string] => [k, `${KIND_LABEL[k]} ${counts[k]}`]), ...(errors > 0 ? ([["errors", `Errors ${errors}`]] as Array<[FilterId, string]>) : [])];
  const metric = {
    llm: spans.filter((s) => kindGroup(s) === "model").length,
    tools: spans.filter((s) => s.kind === "tool").length,
    toolErrors: spans.filter((s) => s.kind === "tool" && s.status === "error").length,
    models: [...new Set(spans.map((s) => s.attributes["gen_ai.request.model"]).filter((m): m is string => typeof m === "string").map((m) => m.replace(/^openrouter\//, "")))],
  };

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
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold leading-[1.33333] tracking-[-0.5px] text-[var(--sf-text-1)]">Run #{run.turn.seq}</h1>
              <span className={`${MONO} flex h-6 items-center gap-1.5 rounded-md bg-[var(--sf-raised)] px-2 text-[11px] text-[var(--sf-text-2)]`}>
                <span className="block size-1.5 rounded-full bg-[#a78bfa]" />invoke_agent {agentId}
              </span>
              <StatusChip run={run} />
              {errors > 0 ? (
                <Chip tone="fail" icon={<LuTriangleAlert aria-hidden className="size-3.5" />}>
                  {errors} error span{errors === 1 ? "" : "s"}
                  {run.turn.status === "succeeded" ? ", recovered" : ""}
                </Chip>
              ) : null}
            </div>
            {run.prompt ? <p className="truncate text-[15px] leading-normal text-[var(--sf-text-1)]">{run.prompt.text}</p> : null}
            <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>trace_id {run.turn.traceId} · service.name stageflow-agent-runtime</span>
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
        {notice ? (
          <div role="alert" data-testid="delivery-notice" className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-b-[var(--sf-hairline)] px-7 py-3 ${notice.tone === "bad" ? "bg-[var(--sf-fail-bg)]" : "bg-[#f5b5441f]"}`}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className={`text-[13px] font-medium ${notice.tone === "bad" ? "text-[var(--sf-fail)]" : "text-[var(--sf-needs)]"}`}>{notice.title}</span>
              <span className="text-xs leading-normal text-[var(--sf-text-2)]">{notice.detail}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button disabled={resending} onClick={() => void fixDelivery("resend")}>
                Resend
              </Button>
              <Button disabled={resending} onClick={() => void fixDelivery("delivered")}>
                Mark as delivered
              </Button>
            </div>
          </div>
        ) : null}
        <div className="grid shrink-0 grid-cols-2 gap-5 border-b border-b-[var(--sf-hairline)] px-7 py-4 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Duration" value={formatDuration(run.elapsedMs)} detail={run.waitingMs > 0 ? `${formatDuration(run.workingMs)} working · ${formatDuration(run.waitingMs)} waiting` : `from ${clockTime(run.turn.startedAt)}`} />
          <Metric label="Spans" value={String(spans.length)} detail={errors > 0 ? `${errors} with errors` : "no errors"} />
          <Metric label="LLM calls" value={String(metric.llm)} detail={metric.models.slice(0, 2).join(", ") || "none"} />
          <Metric label="Tool calls" value={String(metric.tools)} detail={metric.toolErrors > 0 ? `${metric.toolErrors} failed` : `${run.approvals.length} approval${run.approvals.length === 1 ? "" : "s"}`} />
          <Metric label="Tokens" value={formatTokens(run.tokens)} detail={`${formatTokens(run.turn.inputTokens ?? 0)} in · ${formatTokens(run.turn.outputTokens ?? 0)} out`} />
          <Metric label="Estimated cost" value={formatCost(run.turn.costUsd)} detail={evals.length > 0 ? `eval ${evals.map((s) => `${s.metric} ${s.score.toFixed(2)}`).join(" · ")}` : "from gen_ai usage"} />
        </div>

        <div className="flex h-[46px] shrink-0 items-center justify-between gap-4 overflow-x-auto border-b border-b-[var(--sf-hairline)] px-7">
          <div className="flex h-full items-center gap-6" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`flex h-full items-center border-b-2 text-[13px] ${NOWRAP} ${tab === id ? "border-b-[var(--sf-text-1)] font-medium text-[var(--sf-text-1)]" : "border-b-transparent text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {traceView ? (
            <div className="flex items-center gap-1.5" role="group" aria-label="Filter spans">
              {filters.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ${NOWRAP} ${filter === id ? "bg-[var(--sf-raised)] text-[var(--sf-text-1)]" : "text-[var(--sf-text-3)] hover:text-[var(--sf-text-2)]"} ${id === "errors" ? "!text-[var(--sf-fail)]" : ""}`}>
                  {id !== "all" && id !== "errors" ? <span className={`block size-2 rounded-full ${SPAN_COLOR[id]}`} /> : null}
                  {label}
                </button>
              ))}
            </div>
          ) : tab === "steps" ? (
            <div className="hidden items-center gap-3.5 xl:flex">
              {KINDS.map((kind) => (
                <span key={kind} className="flex items-center gap-1.5">
                  <span className={`block size-2 rounded-full ${SPAN_COLOR[kind]}`} />
                  <span className={`text-[11px] text-[var(--sf-text-3)] ${NOWRAP}`}>{KIND_LABEL[kind]}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {traceView ? (
          <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
            <div className="min-w-0 flex-1">
              {tab === "waterfall" ? (
                <Waterfall run={run} now={now} filter={filter} selectedId={selectedSpan?.id ?? null} onSelect={setSpanId} />
              ) : tab === "flame" ? (
                <FlameGraph run={run} now={now} filter={filter} selectedId={selectedSpan?.id ?? null} onSelect={setSpanId} />
              ) : (
                <SpanList run={run} filter={filter} selectedId={selectedSpan?.id ?? null} onSelect={setSpanId} />
              )}
            </div>
            {spans.length > 0 ? spanPanel : null}
          </div>
        ) : tab === "steps" ? (
          <Steps
            run={run}
            selectedStepId={stepId}
            onSelectStep={setStepId}
            renderDetail={(step) =>
              step?.approval ? (
                <ApprovalPane step={step} deciding={deciding} onDecide={(d) => void decide(d)} />
              ) : step?.spanId ? (
                <SpanPanel key={step.spanId} span={spans.find((s) => s.id === step.spanId) ?? null} spans={spans} onSelect={setSpanId} traceId={run.turn.traceId} />
              ) : null
            }
          />
        ) : tab === "messages" ? (
          <Messages run={run} />
        ) : tab === "logs" ? (
          <Logs
            run={run}
            onSelect={(id) => {
              setSpanId(id);
              setTab("waterfall");
            }}
          />
        ) : (
          <Configuration agentId={agentId} run={run} />
        )}
      </div>

      <PageFooter
        left={`${spans.length} span${spans.length === 1 ? "" : "s"} · trace ${run.turn.status}${active ? " · live" : ""}`}
        right={`session ${sessionShort} · times relative to run start`}
      />
    </div>
  );
}
