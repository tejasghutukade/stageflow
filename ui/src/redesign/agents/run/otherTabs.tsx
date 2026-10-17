import { useEffect, useState } from "react";
import { LuCheck, LuFlag, LuMessageSquare, LuPencil, LuShield, LuUserCheck, LuX } from "react-icons/lu";
import { agentsApi, type AgentRevision } from "../../../api/agents";
import { agentPath, navigate } from "../../../routes";
import { MONO, NOWRAP } from "../agentsTokens";
import { clockTime, formatCost, formatDuration, formatTokens } from "../model/format";
import type { RunView } from "../model/sessionView";
import { Button } from "../ui";
import { runLogs, runSteps, type LogLevel, type Step, type StepKind } from "./runModel";
import { LuBrain, LuBot, LuWrench } from "react-icons/lu";
import type { ComponentType } from "react";

const LEVEL_COLOR: Record<LogLevel, string> = { INFO: "text-[var(--sf-text-3)]", WARN: "text-[var(--sf-needs)]", ERROR: "text-[var(--sf-fail)]" };

export function Logs({ run, onSelect }: { run: RunView; onSelect: (id: string) => void }) {
  const records = runLogs(run);
  return (
    <div className="flex flex-col" data-testid="run-logs">
      <p className="border-b border-b-[var(--sf-hairline)] px-6 py-3 text-[11px] text-[var(--sf-text-3)]">Built from the spans, approvals and errors recorded for this run, joined on trace_id {run.turn.traceId.slice(0, 8)}…</p>
      {records.map((record) => (
        <button
          key={record.id}
          type="button"
          disabled={!record.spanId}
          onClick={() => record.spanId && onSelect(record.spanId)}
          className="grid grid-cols-[72px_52px_130px_minmax(0,1fr)] items-baseline gap-4 border-b border-b-[var(--sf-hairline)] px-6 py-2.5 text-left enabled:hover:bg-[var(--sf-panel)]"
        >
          <span className={`${MONO} text-[11px] text-[var(--sf-text-3)]`}>+{(record.offsetMs / 1000).toFixed(2)} s</span>
          <span className={`${MONO} text-[11px] ${LEVEL_COLOR[record.level]}`}>{record.level}</span>
          <span className={`${MONO} truncate text-xs text-[#a78bfa]`}>{record.source}</span>
          <span className="text-[13px] leading-normal text-[var(--sf-text-1)]">{record.message}</span>
        </button>
      ))}
    </div>
  );
}

export function Messages({ run }: { run: RunView }) {
  const rows = [run.prompt && { who: "You", text: run.prompt.text, at: run.prompt.createdAt }, run.reply && { who: "Agent", text: run.reply.text, at: run.reply.createdAt }].filter(Boolean) as Array<{ who: string; text: string; at: string }>;
  return (
    <div className="flex max-w-[860px] flex-col gap-5 px-6 py-5" data-testid="run-messages">
      {rows.map((row) => (
        <div key={row.who} className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2 text-[11px] text-[var(--sf-text-3)]">{row.who}<span className={MONO}>{clockTime(row.at)}</span></span>
          <p className="whitespace-pre-wrap rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4 text-[13px] leading-[1.55] text-[var(--sf-text-1)]">{row.text}</p>
        </div>
      ))}
      {rows.length === 0 ? <p className="text-xs text-[var(--sf-text-3)]">No messages in this run.</p> : null}
    </div>
  );
}

export function Configuration({ agentId, run }: { agentId: string; run: RunView }) {
  const [revision, setRevision] = useState<AgentRevision | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    agentsApi.revision(agentId, run.turn.revision).then((r) => live && setRevision(r)).catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load this version"));
    return () => {
      live = false;
    };
  }, [agentId, run.turn.revision]);
  return (
    <div className="flex max-w-[900px] flex-col gap-4 px-6 py-5" data-testid="run-config">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-medium text-[var(--sf-text-1)]">Agent configuration v{run.turn.revision}</h3>
          <p className="text-[11px] text-[var(--sf-text-3)]">This run was pinned to this version when it started, so later edits do not change it.</p>
        </div>
        <Button icon={<LuPencil aria-hidden className="text-[var(--sf-text-2)]" />} onClick={() => navigate(agentPath(agentId, "edit"))}>Edit agent</Button>
      </div>
      {revision ? (
        <pre className={`${MONO} overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4 text-[11px] leading-[1.6] text-[var(--sf-text-1)]`}>{revision.yaml}</pre>
      ) : (
        <p className="text-xs text-[var(--sf-text-3)]">{error ?? "Loading…"}</p>
      )}
    </div>
  );
}

const STEP_ICON: Record<StepKind, ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  message: LuMessageSquare,
  model: LuBrain,
  tool: LuWrench,
  agent: LuBot,
  guardrail: LuShield,
  gate: LuUserCheck,
  final: LuFlag,
};
const STEP_COLOR: Record<StepKind, string> = {
  message: "text-[var(--sf-text-2)]",
  model: "text-[var(--sf-running)]",
  tool: "text-[#2dd4bf]",
  agent: "text-[#a78bfa]",
  guardrail: "text-[#f472b6]",
  gate: "text-[var(--sf-needs)]",
  final: "text-[var(--sf-text-2)]",
};

function StepRow({ step, selected, onClick }: { step: Step; selected: boolean; onClick: () => void }) {
  const Icon = step.state === "failed" ? LuX : STEP_ICON[step.kind];
  const waiting = step.state === "waiting";
  const faded = step.state === "queued" || step.state === "pending";
  const meta = [step.durationMs !== null ? formatDuration(step.durationMs) : null, step.tokens > 0 ? `${formatTokens(step.tokens)} tok` : null, step.cost !== null ? formatCost(step.cost) : null].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex w-full items-start gap-3.5 px-6 py-3.5 text-left hover:bg-[var(--sf-panel)] ${waiting ? "bg-[#f5b5440d] shadow-[inset_2px_0_0_var(--sf-needs)]" : selected ? "bg-[var(--sf-panel)]" : ""}`}
    >
      <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border ${faded ? "border-dashed border-[var(--sf-hairline-strong)]" : "border-[var(--sf-hairline)]"} bg-[var(--sf-raised)]`}>
        <Icon aria-hidden className={`size-4 ${step.state === "failed" ? "text-[var(--sf-fail)]" : STEP_COLOR[step.kind]}`} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={`truncate text-[13px] font-medium ${faded ? "text-[var(--sf-text-2)]" : step.state === "failed" ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-1)]"}`}>{step.title}</span>
            {step.tag ? <span className={`${MONO} shrink-0 text-[11px] text-[var(--sf-running)]`}>{step.tag}</span> : null}
          </span>
          <span className={`${MONO} shrink-0 text-[11px] ${waiting ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-3)]"}`}>{waiting ? "waiting" : step.state === "queued" ? "queued" : step.state === "pending" ? "pending" : meta || (step.at ? clockTime(step.at) : "")}</span>
        </span>
        {step.detail ? <span className="line-clamp-2 text-xs leading-normal text-[var(--sf-text-2)]">{step.detail}</span> : null}
      </span>
    </button>
  );
}

export function Steps({
  run,
  selectedStepId,
  onSelectStep,
  renderDetail,
}: {
  run: RunView;
  selectedStepId: string | null;
  onSelectStep: (id: string) => void;
  renderDetail: (step: Step | null) => React.ReactNode;
}) {
  const steps = runSteps(run);
  const selected = steps.find((s) => s.id === selectedStepId) ?? steps.find((s) => s.state === "waiting") ?? steps.find((s) => s.state === "failed") ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row" data-testid="run-steps">
      <div className="flex min-w-0 flex-1 flex-col divide-y divide-[var(--sf-hairline)] border-b border-b-[var(--sf-hairline)] xl:border-b-0">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} selected={selected?.id === step.id} onClick={() => onSelectStep(step.id)} />
        ))}
        {steps.length === 0 ? <p className="p-10 text-center text-xs text-[var(--sf-text-3)]">Nothing recorded for this run yet.</p> : null}
      </div>
      {renderDetail(selected)}
    </div>
  );
}

export function ApprovalPane({ step, deciding, onDecide }: { step: Step; deciding: boolean; onDecide: (d: "approve" | "deny") => void }) {
  const approval = step.approval!;
  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-t-[var(--sf-hairline)] p-5 xl:w-[440px] xl:border-l xl:border-t-0 xl:border-l-[var(--sf-hairline)]" data-testid="approval-pane">
      <div className="flex items-center justify-between">
        <span className={`${MONO} rounded-md bg-[#f5b5441f] px-1.5 py-0.5 text-[11px] text-[var(--sf-needs)]`}>Human gate · approval</span>
        <span className={`${MONO} text-[11px] text-[var(--sf-needs)]`}>asked {clockTime(approval.createdAt)}</span>
      </div>
      <h2 className="text-[17px] font-semibold leading-snug text-[var(--sf-text-1)]">Run {approval.tool}?</h2>
      <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-3.5 text-xs leading-normal text-[var(--sf-text-2)]">
        <span className="font-medium text-[var(--sf-text-1)]">Why this needs you.</span> {approval.tool} is marked ask-first in this agent’s configuration, so the run is paused until someone decides.
      </div>
      <div className="flex flex-col gap-1.5">
        <span className={`${MONO} text-[10px] uppercase tracking-[0.5px] text-[var(--sf-text-3)]`}>What will run</span>
        <pre className={`${MONO} max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-ground)] p-3 text-[11px] leading-[1.5] text-[var(--sf-text-1)]`}>{JSON.stringify(approval.payload, null, 2)}</pre>
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={deciding} onClick={() => onDecide("approve")} className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--sf-text-1)] text-xs font-medium text-[var(--sf-ground)] disabled:opacity-60 ${NOWRAP}`}>
          <LuCheck aria-hidden className="size-3.5" />Approve and run
        </button>
        <button type="button" disabled={deciding} onClick={() => onDecide("deny")} className={`flex h-9 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] px-3 text-xs text-[var(--sf-text-1)] disabled:opacity-60 ${NOWRAP}`}>
          <LuX aria-hidden className="size-3.5 text-[var(--sf-fail)]" />Deny
        </button>
      </div>
    </aside>
  );
}
