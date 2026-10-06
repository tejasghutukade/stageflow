import type { CapacityHealth, RunDetail, StageSnapshot } from "../../api";
import { formatRunCost, formatRunDuration } from "../../runs/formatRunMetrics";
import { relativeTime } from "../../catalogJoin";
import {
  canAbandon,
  canRetry,
  canResumeTimedOut,
  isStageActionBusy,
} from "../../stageAction";
import { statusCopy } from "../../status/runStatus";
import { Inspector } from "../shell/Inspector";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import {
  pendingGateLabel,
  retryBlockedByAnswerGate,
  stageReadinessLabel,
} from "./runInspectorFields";

function waitingSince(stage: StageSnapshot): string | null {
  for (let i = stage.events.length - 1; i >= 0; i--) {
    const ev = stage.events[i];
    if (ev.event === "waiting_for_input" && ev.at) {
      return relativeTime(ev.at);
    }
  }
  return null;
}

function startedAtLabel(stage: StageSnapshot): string | null {
  for (const ev of stage.events) {
    if (ev.event === "started" && ev.at) {
      return relativeTime(ev.at);
    }
  }
  return null;
}

function artifactName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function RunStageInspector({
  run,
  stage,
  health,
  modelLabel,
  inboundSummary,
  actionBusy,
  onRetry,
  onResume,
  onAbandon,
  onOpenArtifact,
  onOpenEnvelope,
  artifactPath,
}: {
  run: RunDetail;
  stage: StageSnapshot | null;
  health: CapacityHealth | null;
  modelLabel?: string | null;
  inboundSummary?: string | null;
  actionBusy: {
    retryingStageIds: ReadonlySet<string>;
    abandoningStageId: string | null;
    resumingStageIds: ReadonlySet<string>;
  };
  onRetry: (stageId: string) => void;
  onResume: (stageId: string) => void;
  onAbandon: (stageId: string) => void;
  onOpenArtifact?: (path: string) => void;
  onOpenEnvelope?: (stageId: string) => void;
  artifactPath?: string | null;
}) {
  if (!stage) {
    return (
      <Inspector title="Stage" className="!w-[360px]">
        <p className="text-[13px] text-[var(--sf-text-3)]">Select a stage to inspect.</p>
      </Inspector>
    );
  }

  const stageId = stage.stage_id;
  const holdingSlot = health?.activeRunIds?.includes(run.run_id) ?? false;
  const failedReason = stage.events
    .slice()
    .reverse()
    .find((e) => e.event === "failed")?.reason;
  const readiness = stageReadinessLabel(run, stage);
  const pendingGate = pendingGateLabel(stage.pending_prompt);
  const outbound = stage.envelope;
  const retryBlocked = retryBlockedByAnswerGate(run);
  const retryBusy = isStageActionBusy(actionBusy, stageId);

  return (
    <Inspector title={stageCloneLabel(run, stageId)} className="!w-[360px]">
      <dl className="flex flex-col gap-2.5 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--sf-text-3)]">Status</dt>
          <dd className="text-[var(--sf-text-1)]">{statusCopy(stage.status)}</dd>
        </div>
        {readiness ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--sf-text-3)]">Readiness</dt>
            <dd className="text-right text-[var(--sf-text-1)]">{readiness}</dd>
          </div>
        ) : null}
        {pendingGate ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--sf-text-3)]">Pending gate</dt>
            <dd className="text-[var(--sf-needs)]">{pendingGate}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--sf-text-3)]">Attempt</dt>
          <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
            {stage.attempt_count}
          </dd>
        </div>
        {modelLabel ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--sf-text-3)]">Model</dt>
            <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
              {modelLabel}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--sf-text-3)]">Started</dt>
          <dd className="text-[var(--sf-text-1)]">{startedAtLabel(stage) ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--sf-text-3)]">Elapsed</dt>
          <dd className="whitespace-nowrap font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
            {formatRunDuration(run.created_at, run.finished_at, run.updated_at)}
          </dd>
        </div>
        {stage.status === "waiting_for_input" ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--sf-text-3)]">Waiting on you</dt>
            <dd className="text-[var(--sf-text-1)]">{waitingSince(stage) ?? "now"}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--sf-text-3)]">Cost</dt>
          <dd className="font-['Geist_Mono',monospace] text-[var(--sf-text-1)]">
            {formatRunCost(stage.cost_usd)}
          </dd>
        </div>
        {holdingSlot ? (
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--sf-text-3)]">Session</dt>
            <dd className="text-[var(--sf-text-1)]">Holding a session slot</dd>
          </div>
        ) : null}
        {inboundSummary ? (
          <div className="flex flex-col gap-1">
            <dt className="text-[var(--sf-text-3)]">Inbound</dt>
            <dd className="text-[13px] leading-snug text-[var(--sf-text-2)]">
              {inboundSummary}
            </dd>
          </div>
        ) : null}
      </dl>
      {outbound ? (
        <section className="mt-4 rounded-lg border border-[#ffffff12] bg-[var(--sf-raised)] p-3">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--sf-text-3)]">
            Handoff envelope
          </div>
          <p className="text-[13px] leading-snug text-[var(--sf-text-1)]">
            {outbound.summary}
          </p>
          {outbound.artifacts.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {outbound.artifacts.map((path) => {
                const name = artifactName(path);
                if (onOpenArtifact) {
                  return (
                    <button
                      key={path}
                      type="button"
                      className="rounded-md border border-[#ffffff1a] bg-[var(--sf-panel)] px-2 py-0.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)] hover:border-[#ffffff28]"
                      onClick={() => onOpenArtifact(path)}
                    >
                      {name}
                    </button>
                  );
                }
                return (
                  <span
                    key={path}
                    className="rounded-md border border-[#ffffff1a] bg-[var(--sf-panel)] px-2 py-0.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
                  >
                    {name}
                  </span>
                );
              })}
            </div>
          ) : null}
          {onOpenEnvelope ? (
            <button
              type="button"
              className="sf-btn sf-btn--ghost sf-btn--sm mt-3"
              onClick={() => onOpenEnvelope(stageId)}
            >
              Open full record
            </button>
          ) : null}
        </section>
      ) : null}
      {failedReason ? (
        <p className="mt-3 rounded-lg border border-[#f2645a33] bg-[#f2645a14] px-3 py-2 text-[13px] text-[var(--sf-fail)]">
          {failedReason}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {canRetry(stage.status) ? (
          <button
            type="button"
            className="sf-btn sf-btn--secondary sf-btn--sm"
            disabled={retryBusy || retryBlocked}
            title={
              retryBlocked
                ? "Answer the pending gate on this run before retrying a stage."
                : undefined
            }
            onClick={() => onRetry(stageId)}
          >
            Retry
          </button>
        ) : null}
        {canResumeTimedOut(stage) ? (
          <button
            type="button"
            className="sf-btn sf-btn--secondary sf-btn--sm"
            disabled={retryBusy || retryBlocked}
            title={
              retryBlocked
                ? "Answer the pending gate on this run before resuming."
                : undefined
            }
            onClick={() => onResume(stageId)}
          >
            Resume
          </button>
        ) : null}
        {canAbandon(stage.status) ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost sf-btn--sm"
            disabled={retryBusy}
            onClick={() => onAbandon(stageId)}
          >
            Abandon
          </button>
        ) : null}
        {artifactPath && onOpenArtifact ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost sf-btn--sm"
            onClick={() => onOpenArtifact(artifactPath)}
          >
            Open artifact
          </button>
        ) : null}
      </div>
    </Inspector>
  );
}
