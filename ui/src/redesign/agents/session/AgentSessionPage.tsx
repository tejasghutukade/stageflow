import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuArrowUp,
  LuArrowUpRight,
  LuCheck,
  LuCornerDownRight,
  LuDownload,
  LuGlobe,
  LuMessageSquare,
  LuRotateCw,
  LuSquare,
  LuTriangleAlert,
  LuUserCheck,
  LuX,
  LuZap,
} from "react-icons/lu";
import { AgentApiError, agentsApi, streamAgentChat, type AgentApproval, type AgentDetail, type AgentSessionDetail } from "../../../api/agents";
import { agentPath, agentRunPath, agentSessionPath, agentsPath, navigate } from "../../../routes";
import { showToast } from "../../../toast";
import { AgentLoadError } from "../AgentLoadState";
import { MONO, NOWRAP, PAGE_BG } from "../agentsTokens";
import { clockTime, formatCost, formatDuration, formatTokens, shortSessionId, sourceLabel } from "../model/format";
import { useAgentDetail, useResource } from "../model/hooks";
import { composerMode, runViews, sessionRollups, sessionTimeline, spanColor, type RunView } from "../model/sessionView";
import { Breadcrumb, Button, PageFooter } from "../ui";
import { AgentSessionEvalBanner } from "../../evals/AgentSessionEvalBanner";
import { AddSessionCaseDialog } from "./AddSessionCaseDialog";
import { addAsCaseDisabledReason, canOfferAddAsCase } from "./sessionCaseModel";

const POLL_MS = 3000;

function OpenLink({ label, onClick, small = false }: { label: string; onClick: () => void; small?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-[var(--sf-text-1)] hover:underline">
      <span className={small ? "text-[11px] leading-normal" : "text-xs leading-[1.33333]"}>{label}</span>
      <LuArrowUpRight aria-hidden className="size-3" />
    </button>
  );
}

function RunStrip({ run, height = "h-2", gap = "gap-[3px]" }: { run: RunView; height?: string; gap?: string }) {
  if (run.spans.length === 0) {
    return <div className={`${height} w-full rounded-xs border border-dashed border-[var(--sf-hairline-strong)]`} aria-label="No spans recorded" />;
  }
  return (
    <div className={`flex ${height} w-full ${gap}`}>
      {run.spans.map((span) => (
        <span
          key={span.id}
          title={`${span.name} · ${formatDuration(span.durationMs)}`}
          style={{ flex: `${Math.max(1, span.durationMs ?? 1)} 1 0%` }}
          className={`block rounded-xs ${spanColor(span)}`}
        />
      ))}
      {run.turn.status === "waiting" ? (
        <span style={{ flex: `${Math.max(1, run.waitingMs)} 1 0%` }} className="block rounded-xs bg-[var(--sf-needs)] shadow-[0px_0px_6px_rgb(245,181,68)]" />
      ) : null}
    </div>
  );
}

function runStatus(run: RunView): { label: string; tone: "ok" | "needs" | "fail" | "running" | "muted" } {
  switch (run.turn.status) {
    case "succeeded":
      return { label: "Answered", tone: "ok" };
    case "waiting":
      return { label: `Waiting on you · ${formatDuration(run.waitingMs)}`, tone: "needs" };
    case "running":
      return { label: "Running", tone: "running" };
    case "cancelled":
      return { label: "Stopped", tone: "muted" };
    default:
      return { label: run.turn.errorCode === "agent.guardrail_blocked" ? "Blocked by guardrail" : "Failed", tone: "fail" };
  }
}

const TONE_TEXT = {
  ok: "text-[var(--sf-ok)]",
  needs: "text-[var(--sf-needs)]",
  fail: "text-[var(--sf-fail)]",
  running: "text-[var(--sf-running)]",
  muted: "text-[var(--sf-text-3)]",
};

function TraceSummary({ run, onOpen }: { run: RunView; onOpen: () => void }) {
  const status = runStatus(run);
  const models = run.spans.filter((span) => span.kind === "model");
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--sf-hairline)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {status.tone === "ok" ? <LuCheck aria-hidden className="size-3.5 shrink-0 text-[var(--sf-ok)]" /> : null}
          {status.tone === "fail" ? <LuTriangleAlert aria-hidden className="size-3.5 shrink-0 text-[var(--sf-fail)]" /> : null}
          <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-text-1)]">Run #{run.turn.seq}</span>
          <span className={`${MONO} truncate text-[11px] leading-normal text-[var(--sf-text-3)]`}>
            trace …{run.turn.traceId.slice(-4)} · {run.spans.length} span{run.spans.length === 1 ? "" : "s"} · {formatDuration(run.elapsedMs)}
          </span>
        </div>
        <OpenLink label="Open trace" onClick={onOpen} />
      </div>
      <RunStrip run={run} height="h-1.5" gap="gap-px" />
      <div className="flex flex-wrap items-center gap-1.5">
        {models.length > 0 ? (
          <span className="flex items-center gap-1 rounded-md bg-[var(--sf-running-bg)] px-1.5 py-0.5">
            <LuZap aria-hidden className="size-3 text-[var(--sf-running)]" />
            <span className={`${MONO} text-[10px] leading-normal text-[var(--sf-text-1)]`}>
              {String(models[0]!.attributes["gen_ai.request.model"] ?? models[0]!.attributes["gen_ai.system"] ?? "chat")}
              {models.length > 1 ? ` ×${models.length}` : ""}
            </span>
          </span>
        ) : null}
        {run.tokens > 0 ? (
          <span className={`${MONO} rounded-md bg-[var(--sf-raised)] px-1.5 py-0.5 text-[10px] leading-normal text-[var(--sf-text-2)]`}>
            {run.tokens.toLocaleString()} tok{run.turn.costUsd !== null ? ` · ${formatCost(run.turn.costUsd)}` : ""}
          </span>
        ) : null}
        {run.turn.errorCode ? (
          <span className={`${MONO} rounded-md bg-[var(--sf-fail-bg)] px-1.5 py-0.5 text-[10px] leading-normal text-[var(--sf-fail)]`}>{run.turn.errorCode}</span>
        ) : null}
      </div>
    </div>
  );
}

function MessageBlock({ author, time, text, event, children }: { author: string; time: string; text: string; event?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold leading-normal text-[var(--sf-text-1)]">{author}</span>
        <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>{time}</span>
      </div>
      <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-[var(--sf-text-1)]">{text}</p>
      </div>
      {event ? (
        <div className="flex items-center gap-2">
          <LuCornerDownRight aria-hidden className="size-3 text-[var(--sf-text-3)]" />
          <span className={`${MONO} rounded-sm border border-[var(--sf-hairline-strong)] px-1.5 text-[10px] leading-normal text-[var(--sf-text-2)]`}>gen_ai.user.message</span>
          <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{event}</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function GateCard({
  approval,
  run,
  busy,
  onDecide,
  onOpen,
}: {
  approval: AgentApproval;
  run: RunView | undefined;
  busy: boolean;
  onDecide: (decision: "approve" | "deny") => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-col overflow-clip rounded-lg border border-[#f5b54459] bg-[#f5b5440a]">
      <div className="flex items-center justify-between border-b border-b-[#f5b54426] px-4 py-3">
        <div className="flex items-center gap-2">
          <LuUserCheck aria-hidden className="size-3.5 text-[var(--sf-needs)]" />
          <span className="text-xs font-medium leading-[1.33333] text-[var(--sf-needs)]">
            {run ? `Run #${run.turn.seq} is waiting on you` : "Waiting on you"}
          </span>
          {run ? (
            <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>
              {formatDuration(run.workingMs)} working · {formatDuration(run.waitingMs)} waiting
            </span>
          ) : null}
        </div>
        {run ? <OpenLink label="Open run" onClick={onOpen} small /> : null}
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3">
        <p className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">
          Allow <span className={MONO}>{approval.tool}</span>?
        </p>
        <pre className={`${MONO} max-h-40 overflow-auto rounded-md bg-[var(--sf-rail)] p-2.5 text-[11px] leading-[1.6] text-[var(--sf-text-2)]`}>
          {JSON.stringify(approval.payload, null, 2)}
        </pre>
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide("approve")}
          className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--sf-text-1)] px-3 disabled:opacity-50"
        >
          <LuCheck aria-hidden className="size-3.5 text-[var(--sf-ground)]" />
          <span className={`text-xs font-medium leading-[1.33333] text-[var(--sf-ground)] ${NOWRAP}`}>Approve</span>
        </button>
        <Button size="sm" disabled={busy} icon={<LuX aria-hidden className="text-[var(--sf-fail)]" />} onClick={() => onDecide("deny")}>
          Deny
        </Button>
        <span className="ml-auto text-[11px] leading-normal text-[var(--sf-text-3)]">Expires {clockTime(approval.expiresAt)}</span>
      </div>
    </div>
  );
}

function TraceCard({ run, onOpen }: { run: RunView; onOpen: () => void }) {
  const status = runStatus(run);
  const waiting = status.tone === "needs";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex flex-col gap-2.5 border-b border-b-[var(--sf-hairline)] px-6 py-4 text-left hover:bg-[var(--sf-panel)] ${
        waiting ? "border-l-2 border-l-[var(--sf-needs)] bg-[#f5b5440a]" : ""
      }`}
    >
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-normal text-[var(--sf-text-1)]">Run #{run.turn.seq}</span>
          <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)]`}>{clockTime(run.turn.startedAt)}</span>
        </div>
        <span className={`flex items-center gap-1 text-[11px] font-medium leading-normal ${TONE_TEXT[status.tone]}`}>
          {status.tone === "ok" ? <LuCheck aria-hidden className="size-3" /> : waiting ? <LuUserCheck aria-hidden className="size-3" /> : null}
          {status.label}
        </span>
      </div>
      {run.prompt ? <p className="line-clamp-2 text-xs leading-normal text-[var(--sf-text-2)]">“{run.prompt.text}”</p> : null}
      <RunStrip run={run} />
      <div className="flex w-full items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-2)]`}>
            {[formatDuration(run.elapsedMs), run.tokens > 0 ? `${formatTokens(run.tokens)} tok` : null, run.turn.costUsd !== null ? formatCost(run.turn.costUsd) : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {run.turn.errorCode ? (
            <span className="flex items-center gap-1 rounded-md bg-[var(--sf-fail-bg)] px-1.5 py-0.5">
              <LuRotateCw aria-hidden className="size-3 text-[var(--sf-fail)]" />
              <span className="text-[11px] leading-normal text-[var(--sf-fail)]">{run.turn.errorCode}</span>
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function Timeline({ detail, now }: { detail: AgentSessionDetail; now: number }) {
  const timeline = sessionTimeline(detail, now);
  if (!timeline) return null;
  const lane = "w-[88px] shrink-0 text-[11px] leading-normal text-[var(--sf-text-3)]";
  return (
    <div className="flex flex-col gap-1.5" aria-label="Session timeline">
      <div className="flex items-center gap-3">
        <span className={lane}>Messages</span>
        <div className="relative h-3 flex-1">
          {timeline.messages.map((marker, index) => (
            <span
              key={index}
              style={{ left: `min(${marker.at}%, calc(100% - 8px))` }}
              className={`absolute top-0.5 block size-2 rounded-full ${marker.user ? "border border-[var(--sf-text-2)] bg-[var(--sf-ground)]" : "bg-[var(--sf-text-2)]"}`}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={lane}>Agent working</span>
        <div className="relative h-4 flex-1 rounded-sm bg-[var(--sf-panel)]">
          {timeline.agent.map((bar, index) => (
            <span
              key={index}
              style={{ left: `${bar.at}%`, width: `${bar.width}%` }}
              className={`absolute bottom-0.5 top-0.5 block rounded-xs ${bar.failed ? "bg-[var(--sf-fail)]" : bar.live ? "bg-[var(--sf-running)]" : "bg-[var(--sf-ok)]"}`}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`${lane} ${NOWRAP}`}>Human gates</span>
        <div className="relative h-4 flex-1 rounded-sm bg-[var(--sf-panel)]">
          {timeline.gates.map((bar, index) => (
            <span
              key={index}
              style={{ left: `${bar.at}%`, width: `${bar.width}%` }}
              className={`absolute bottom-0.5 top-0.5 block rounded-xs bg-[var(--sf-needs)] ${bar.open ? "shadow-[0px_0px_8px_rgb(245,181,68)]" : "opacity-60"}`}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="block w-[88px] shrink-0" />
        <div className="flex flex-1 justify-between">
          {timeline.ticks.map((tick, index) => (
            <span key={index} className={`${MONO} text-[10px] leading-normal text-[var(--sf-text-3)]`}>
              {tick}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionView({ agent, sessionId }: { agent: AgentDetail; sessionId: string | null }) {
  const agentId = agent.agent.id;
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<{ prompt: string; reply: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(false);
  // A first message opens its session before the reply ends; an approval can park the turn meanwhile.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "errors" | "waiting">("all");
  const [addCase, setAddCase] = useState(false);
  const [now, setNow] = useState(Date.now());
  const abort = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Live updates while something can still change: a running turn or a pending approval.
  const sessionRes = useResource(
    sessionId ? `${agentId}/${sessionId}` : null,
    () => agentsApi.session(agentId, sessionId!),
    {
      kind: "session",
      pollMs: streaming ? undefined : POLL_MS,
      active: (d) => d.session.status === "running" || d.session.status === "waiting",
    },
  );
  const { data: detail, error: loadError, reload: refresh, setData: setDetail } = sessionRes;
  const live = detail?.session.status === "running" || detail?.session.status === "waiting";
  // A first message opens its session before the reply ends; follow it until the URL catches up.
  const opened = useResource(
    streaming && !sessionId && openedId ? `${agentId}/${openedId}` : null,
    () => agentsApi.session(agentId, openedId!),
    { kind: "session", pollMs: POLL_MS, active: () => true },
  );
  const liveDetail = opened.data;
  const setLiveDetail = opened.setData;

  useEffect(() => {
    setNow(Date.now());
  }, [sessionRes.updatedAt, opened.updatedAt]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, streaming?.reply]);

  const runs = useMemo(() => (detail ? runViews(detail, now) : []), [detail, now]);
  const rollups = useMemo(() => (detail ? sessionRollups(detail, now) : null), [detail, now]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setInput("");
    setStreaming({ prompt: message, reply: "" });
    const controller = new AbortController();
    abort.current = controller;
    let openedId: string | null = null;
    try {
      const next = await streamAgentChat(
        agentId,
        { message, ...(sessionId ? { sessionId } : {}) },
        {
          signal: controller.signal,
          onDelta: (text) => setStreaming((prev) => (prev ? { ...prev, reply: prev.reply + text } : prev)),
          onSession: (id) => {
            openedId = id;
            setOpenedId(id);
          },
        },
      );
      setDetail(next);
      setNow(Date.now());
      // A new session gets its own URL once the first reply is stored.
      if (!sessionId) navigate(agentSessionPath(agentId, next.session.id));
    } catch (error) {
      if (!sessionId && openedId) navigate(agentSessionPath(agentId, openedId));
      if (!controller.signal.aborted) showToast(error instanceof AgentApiError ? error.message : "The agent could not reply");
      void refresh();
    } finally {
      abort.current = null;
      setStreaming(null);
      setOpenedId(null);
      setBusy(false);
    }
  }

  /** Leaving the stream tells the Host to stop the turn; the partial reply is kept. */
  function stop() {
    abort.current?.abort();
  }

  async function decide(decision: "approve" | "deny") {
    const targetId = sessionId ?? openedId;
    if (!targetId) return;
    setDeciding(true);
    try {
      const result = await agentsApi.decide(agentId, targetId, decision);
      if (sessionId) setDetail(result.session);
      else setLiveDetail(result.session);
      showToast(decision === "approve" ? "Approved" : "Denied");
    } catch (error) {
      showToast(error instanceof AgentApiError ? error.message : "Could not record the decision");
      void refresh();
    } finally {
      setDeciding(false);
    }
  }

  async function exportTraces() {
    if (!sessionId) return;
    try {
      const blob = await agentsApi.exportOtlp(agentId, sessionId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${sessionId}.otlp.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast("Export failed");
    }
  }

  if (sessionId && !detail) {
    return (
      <AgentLoadError
        loading={!loadError}
        error={loadError}
        kind="session"
        missing={sessionRes.missing}
        onBack={() => navigate(agentPath(agentId))}
      />
    );
  }

  const session = detail?.session ?? null;
  const pending = detail?.pendingApproval ?? liveDetail?.pendingApproval ?? null;
  const pendingRun = pending ? runs.find((run) => run.turn.id === pending.turnId) : undefined;
  const runOf = (seq: number) => sessionId && navigate(agentRunPath(agentId, sessionId, String(seq)));
  const traces = runs
    .filter((run) => (filter === "errors" ? run.turn.status === "failed" : filter === "waiting" ? run.turn.status === "waiting" : true))
    .reverse();
  const canChat = agent.agent.enabled && !busy && session?.status !== "running" && session?.status !== "waiting";
  const title = session?.title ?? (streaming?.prompt || "New session");
  const addCaseReason = detail ? addAsCaseDisabledReason(detail) : null;

  return (
    <div className={PAGE_BG}>
      <header className="flex shrink-0 flex-col gap-4 border-b border-b-[var(--sf-hairline)] px-7 py-5">
        <Breadcrumb
          items={[
            { label: "Agents", onClick: () => navigate(agentsPath()) },
            { label: agent.agent.name, onClick: () => navigate(agentPath(agentId)) },
            { label: "Sessions", onClick: () => navigate(agentPath(agentId)) },
            { label: session ? shortSessionId(session.id) : "New" },
          ]}
        />
        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <h1 className="truncate text-2xl font-semibold leading-[1.33333] tracking-[-0.5px] text-[var(--sf-text-1)]">{title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="flex items-center gap-1.5">
                {session?.source === "web" ? (
                  <LuGlobe aria-hidden className="size-3.5 text-[var(--sf-text-2)]" />
                ) : (
                  <LuMessageSquare aria-hidden className="size-3.5 text-[var(--sf-text-2)]" />
                )}
                <span className={`text-[13px] leading-normal text-[var(--sf-text-2)] ${NOWRAP}`}>
                  {[session?.source === "web" && session.sourceRef ? `Visitor ${session.sourceRef.slice(0, 8)}` : session?.sourceRef, sourceLabel(session?.source ?? "console")].filter(Boolean).join(" · ")}
                </span>
              </span>
              {session ? (
                <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)] ${NOWRAP}`}>gen_ai.conversation.id {session.id}</span>
              ) : null}
              <span className={`${MONO} text-[11px] leading-normal text-[var(--sf-text-3)] ${NOWRAP}`}>
                gen_ai.agent.name {agentId} · config v{session?.revision ?? agent.agent.revision}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {pendingRun ? (
              <span className="flex h-7 items-center gap-1.5 rounded-md bg-[#f5b5441f] px-2">
                <span className="block size-1.5 rounded-full bg-[var(--sf-needs)] shadow-[0px_0px_6px_rgb(245,181,68)]" />
                <span className={`text-xs font-medium leading-[1.33333] text-[var(--sf-needs)] ${NOWRAP}`}>Run #{pendingRun.turn.seq} waiting on you</span>
              </span>
            ) : null}
            {session && canOfferAddAsCase(detail) && detail ? (
              <span className="ml-2">
                <Button onClick={() => setAddCase(true)} disabled={addCaseReason !== null} title={addCaseReason ?? undefined}>
                  Add as eval case
                </Button>
              </span>
            ) : null}
            {session ? (
              <span className="ml-2">
                <Button icon={<LuDownload aria-hidden className="text-[var(--sf-text-2)]" />} onClick={() => void exportTraces()} disabled={detail?.spans.length === 0}>
                  Export session traces
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      </header>
      {session ? <AgentSessionEvalBanner sessionId={session.id} source={session.source} /> : null}
      {addCase && detail ? <AddSessionCaseDialog agentId={agentId} detail={detail} onClose={() => setAddCase(false)} /> : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {rollups && rollups.runs > 0 ? (
          <div className="flex shrink-0 flex-col gap-4 border-b border-b-[var(--sf-hairline)] px-7 py-4">
            <div className="grid grid-cols-2 gap-5 md:grid-cols-4 xl:grid-cols-7">
              {[
                { label: "Runs", value: String(rollups.runs), detail: `${rollups.runsDone} done${rollups.runsWaiting ? ` · ${rollups.runsWaiting} waiting on you` : ""}${rollups.runsFailed ? ` · ${rollups.runsFailed} failed` : ""}` },
                { label: "Eval average", value: rollups.evalAverage === null ? "—" : rollups.evalAverage.toFixed(2), detail: rollups.evalAverage === null ? "no evals recorded" : "across scored runs" },
                { label: "Tool calls", value: String(rollups.toolCalls), detail: rollups.toolErrors ? `${rollups.toolErrors} error${rollups.toolErrors === 1 ? "" : "s"}` : "no errors" },
                { label: "Tokens", value: (rollups.inputTokens + rollups.outputTokens).toLocaleString(), detail: `${rollups.inputTokens.toLocaleString()} in · ${rollups.outputTokens.toLocaleString()} out` },
                { label: "Cost", value: formatCost(rollups.cost), detail: rollups.cost === null ? "provider didn't report" : "reported by the provider" },
                { label: "Agent working", value: formatDuration(rollups.workingMs), detail: `of ${formatDuration(rollups.sessionMs)} session` },
                { label: "Waiting on people", value: formatDuration(rollups.waitingMs), detail: pending ? "1 open gate" : "no open gates" },
              ].map((rollup) => (
                <div key={rollup.label} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">{rollup.label}</span>
                  <span className={`${MONO} text-lg leading-[1.55556] text-[var(--sf-text-1)]`}>{rollup.value}</span>
                  <span className="text-[11px] leading-normal text-[var(--sf-text-3)]">{rollup.detail}</span>
                </div>
              ))}
            </div>
            {detail ? <Timeline detail={detail} now={now} /> : null}
          </div>
        ) : null}

        <div className="flex flex-1 flex-col lg:flex-row">
          <div className="flex w-full shrink-0 flex-col border-r border-r-[var(--sf-hairline)] lg:w-[55%]">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-b-[var(--sf-hairline)] px-7">
              <span className="text-sm font-medium leading-[1.42857] text-[var(--sf-text-1)]">Conversation</span>
              <span className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">
                {detail ? `${detail.messages.length} message${detail.messages.length === 1 ? "" : "s"} · ${runs.length} run${runs.length === 1 ? "" : "s"}` : "No messages yet"}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-6 px-7 py-5">
              {runs.map((run) => (
                <div key={run.turn.id} className="flex flex-col gap-6">
                  {run.prompt ? (
                    <MessageBlock
                      author={run.prompt.author ?? "You"}
                      time={clockTime(run.prompt.createdAt)}
                      text={run.prompt.text}
                      event={`started Run #${run.turn.seq} · trace …${run.turn.traceId.slice(-4)}`}
                    />
                  ) : null}
                  {run.reply ? (
                    <MessageBlock author={agent.agent.name} time={clockTime(run.reply.createdAt)} text={run.reply.text}>
                      <TraceSummary run={run} onOpen={() => runOf(run.turn.seq)} />
                    </MessageBlock>
                  ) : run.turn.status !== "running" && run.turn.status !== "waiting" ? (
                    <TraceSummary run={run} onOpen={() => runOf(run.turn.seq)} />
                  ) : null}
                </div>
              ))}
              {streaming ? (
                <>
                  <MessageBlock author="You" time="now" text={streaming.prompt} />
                  <MessageBlock author={agent.agent.name} time="…" text={streaming.reply || "…"} />
                </>
              ) : null}
              {pending ? <GateCard approval={pending} run={pendingRun} busy={deciding} onDecide={(d) => void decide(d)} onOpen={() => pendingRun && runOf(pendingRun.turn.seq)} /> : null}
              {!detail && !streaming ? (
                <p className="text-[13px] leading-[1.6] text-[var(--sf-text-2)]">
                  {agent.definition?.greeting ?? `Start a conversation with ${agent.agent.name}.`}
                </p>
              ) : null}
              <div ref={bottomRef} />
            </div>
            <div className="shrink-0 border-t border-t-[var(--sf-hairline)] px-7 py-4">
              {composerMode(session?.source, agent.agent.enabled) === "eval_readonly" ? (
                <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">Eval session: read only.</p>
              ) : agent.agent.enabled ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                  className="flex items-end gap-2 rounded-xl border border-[var(--sf-hairline-strong)] bg-[var(--sf-panel)] px-3 py-2.5"
                >
                  <textarea
                    value={input}
                    rows={1}
                    disabled={!canChat && !busy}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      session?.status === "waiting" ? "Answer the approval above to continue" : `Message ${agent.agent.name}…`
                    }
                    aria-label="Message this agent"
                    className="min-h-6 flex-1 resize-none border-0 bg-transparent p-0 text-[13px] leading-normal text-[var(--sf-text-1)] outline-none placeholder:text-[var(--sf-text-3)] disabled:opacity-60"
                  />
                  {busy && streaming ? (
                    <button type="button" aria-label="Stop" onClick={stop} className="flex size-6 items-center justify-center rounded-md bg-[var(--sf-raised)] text-[var(--sf-text-2)]">
                      <LuSquare aria-hidden className="size-3" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      aria-label="Send"
                      disabled={!input.trim() || !canChat}
                      className="flex size-6 items-center justify-center rounded-md bg-[var(--sf-text-1)] text-[var(--sf-ground)] disabled:bg-[var(--sf-raised)] disabled:text-[var(--sf-text-2)]"
                    >
                      <LuArrowUp aria-hidden className="size-3.5" />
                    </button>
                  )}
                </form>
              ) : (
                <p className="text-xs leading-[1.33333] text-[var(--sf-text-3)]">This agent is disabled. Enable it to continue the conversation.</p>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-b-[var(--sf-hairline)] px-6">
              <span className="text-sm font-medium leading-[1.42857] text-[var(--sf-text-1)]">Traces in this session</span>
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: "all", label: `All ${runs.length}` },
                    { id: "errors", label: `With errors ${runs.filter((run) => run.turn.status === "failed").length}` },
                    { id: "waiting", label: `Waiting on you ${runs.filter((run) => run.turn.status === "waiting").length}` },
                  ] as const
                ).map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setFilter(chip.id)}
                    className={`rounded-md border px-2 py-0.5 text-[11px] leading-normal ${NOWRAP} ${
                      filter === chip.id
                        ? "border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] text-[var(--sf-text-1)]"
                        : `border-transparent ${chip.id === "waiting" ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-2)]"}`
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col">
              {traces.map((run) => (
                <TraceCard key={run.turn.id} run={run} onOpen={() => runOf(run.turn.seq)} />
              ))}
              {runs.length === 0 ? <p className="px-6 py-4 text-xs text-[var(--sf-text-3)]">Runs appear here as the agent replies.</p> : null}
              {runs.length > 0 ? (
                <p className="px-6 py-3 text-[11px] leading-normal text-[var(--sf-text-3)]">
                  Each block is one step, sized by duration. Blue model · teal tool · violet sub-agent · pink guardrail · amber human gate · red error.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <PageFooter
        left={live ? `Live · updates every ${POLL_MS / 1000} s` : session ? `Last activity ${clockTime(session.updatedAt)}` : "New session"}
        right={`Capture: ${agent.definition?.observability.capture === "full" ? "full content" : agent.definition?.observability.capture === "off" ? "off" : "timing only"}`}
      />
    </div>
  );
}

export function AgentSessionPage({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const { detail, loading, error, missing } = useAgentDetail(agentId);
  if (!detail) return <AgentLoadError loading={loading} error={error} missing={missing} />;
  return <SessionView key={sessionId} agent={detail} sessionId={sessionId === "new" ? null : sessionId} />;
}
