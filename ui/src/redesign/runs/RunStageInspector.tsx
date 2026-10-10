import type { ReactNode } from "react";
import {
  LuArrowRight,
  LuCheck,
  LuCopy,
  LuFileText,
  LuHand,
  LuPlay,
  LuRotateCcw,
  LuSquare,
  LuX,
} from "react-icons/lu";
import type { CapacityHealth, RunDetail, StageSnapshot } from "../../api";
import { formatDurationMs, formatRunCost } from "../../runs/formatRunMetrics";
import { stageRowDurationMs } from "../../runs/stageTimeline";
import {
  canAbandon,
  canRetry,
  canResumeTimedOut,
  isStageActionBusy,
} from "../../stageAction";
import { useHotkeys } from "../keys";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import { retryBlockedByAnswerGate } from "./runInspectorFields";
import {
  formatTokenCount,
  formatWaitDuration,
  runSlotLabel,
  stagePrimaryModel,
  stageStartedClock,
  stageTokenTotals,
  stageWaitingMs,
} from "./stageUsage";

const MONO = "font-['Geist_Mono',monospace]";
const SECTION_LABEL = "text-[11px] font-medium uppercase tracking-[0.88px] text-[#8b8f98]";
const ACTION_ROW =
  "flex h-8 items-center gap-2 rounded-lg px-1 text-[13px] text-[#a7aab2] hover:bg-[#ffffff0a] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent";

function artifactName(path: string): string {
  return path.split("/").pop() ?? path;
}

function copyRunId(runId: string): void {
  void navigator.clipboard?.writeText(runId);
}

function PropRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3">
      <dt className="text-xs text-[#8b8f98]">{label}</dt>
      <dd className={`${MONO} flex items-center gap-2 whitespace-nowrap text-xs text-[#ecedee]`}>
        {children}
      </dd>
    </div>
  );
}

function InspectorColumn({ children }: { children: ReactNode }) {
  return (
    <aside className="flex min-h-0 w-[360px] shrink-0 flex-col overflow-y-auto bg-[#0c0d0f]">
      {children}
    </aside>
  );
}

function InspectorHeader({ name, waiting }: { name?: string; waiting?: boolean }) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-b-[#ffffff12] px-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className={SECTION_LABEL}>Stage</span>
        {name ? (
          <span className={`${MONO} truncate text-[13px] text-[#ecedee]`}>{name}</span>
        ) : null}
      </div>
      {waiting ? (
        <span className="flex h-6 shrink-0 items-center gap-[5px] rounded-full border border-[#f5b5444d] bg-[#f5b5441a] px-2">
          <LuHand className="size-3 text-[#f5b544]" aria-hidden />
          <span className="text-xs font-medium text-[#f5b544]">Waiting for input</span>
        </span>
      ) : null}
    </div>
  );
}

function EnvelopeStatusPill({ status }: { status: string }) {
  const ok = status === "success";
  return (
    <span
      className={`flex h-5 w-fit items-center gap-1 rounded-full px-1.5 text-[11px] font-medium ${
        ok ? "bg-[#4cc38a1a] text-[#4cc38a]" : "bg-[#f2645a1a] text-[#f2645a]"
      }`}
    >
      {ok ? <LuCheck className="size-3" aria-hidden /> : <LuX className="size-3" aria-hidden />}
      {status}
    </span>
  );
}

export function RunStageInspector({
  run,
  stage,
  health,
  inboundSummary,
  inboundFromStageId,
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
  inboundFromStageId?: string | null;
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
  useHotkeys(
    [
      {
        key: "c",
        scope: "run-detail",
        handler: (e) => {
          e.preventDefault();
          copyRunId(run.run_id);
        },
      },
    ],
    "run-detail",
  );

  if (!stage) {
    return (
      <InspectorColumn>
        <InspectorHeader />
        <p className="px-4 py-3 text-[13px] text-[#8b8f98]">Select a stage to inspect.</p>
      </InspectorColumn>
    );
  }

  const now = Date.now();
  const stageId = stage.stage_id;
  const waiting = stage.status === "waiting_for_input";
  const failedReason =
    stage.status === "failed"
      ? stage.events
          .slice()
          .reverse()
          .find((e) => e.event === "failed")?.reason
      : undefined;
  const outbound = stage.envelope;
  const retryBlocked = retryBlockedByAnswerGate(run);
  const retryBusy = isStageActionBusy(actionBusy, stageId);
  const showRetry = canRetry(stage.status) || retryBlocked;

  const model = stagePrimaryModel(stage);
  const tokens = stageTokenTotals(stage);
  const startedClock = stageStartedClock(stage);
  const elapsed = startedClock ? formatDurationMs(stageRowDurationMs(stage, now)) : null;
  const waitingMs = waiting ? stageWaitingMs(stage, now) : null;
  const slot = runSlotLabel(run.run_id, health);

  return (
    <InspectorColumn>
      <InspectorHeader name={stageCloneLabel(run, stageId)} waiting={waiting} />
      <div className="flex flex-col border-b border-b-[#ffffff12] px-4 py-2">
        <dl className="flex flex-col">
          <PropRow label="Attempt">{stage.attempt_count}</PropRow>
          {model ? <PropRow label="Model">{model}</PropRow> : null}
          {startedClock ? (
            <PropRow label="Started · elapsed">
              <span>{startedClock}</span>
              <span>{elapsed}</span>
            </PropRow>
          ) : null}
          {waitingMs !== null ? (
            <PropRow label="Waiting on you">{formatWaitDuration(waitingMs)}</PropRow>
          ) : null}
          {tokens ? (
            <PropRow label="Tokens in / out">
              {formatTokenCount(tokens.input)} / {formatTokenCount(tokens.output)}
            </PropRow>
          ) : null}
          <PropRow label="Cost">{formatRunCost(stage.cost_usd)}</PropRow>
          {slot ? (
            <PropRow label="Slot held">
              <span className="size-1.5 rounded-full bg-[#f5b544]" aria-hidden />
              {slot}
            </PropRow>
          ) : null}
        </dl>
        {failedReason ? (
          <p className="my-2 rounded-lg border border-[#f2645a33] bg-[#f2645a14] px-3 py-2 text-[13px] text-[#f2645a]">
            {failedReason}
          </p>
        ) : null}
      </div>
      {inboundSummary || outbound ? (
        <div className="flex flex-col gap-2 border-b border-b-[#ffffff12] px-4 py-3">
          {inboundSummary ? (
            <>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={SECTION_LABEL}>{inboundFromStageId ? "Envelope from" : "Envelope in"}</span>
                {inboundFromStageId ? (
                  <>
                    <span className={`${MONO} truncate text-[13px] text-[#ecedee]`}>
                      {inboundFromStageId}
                    </span>
                    <LuArrowRight className="size-3 shrink-0 text-[#8b8f98]" aria-hidden />
                    <span className={`${MONO} truncate text-[13px] text-[#ecedee]`}>{stageId}</span>
                  </>
                ) : null}
              </div>
              <p className="text-[13px] leading-snug text-[#ecedee]">{inboundSummary}</p>
            </>
          ) : null}
          {outbound ? (
            <>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={SECTION_LABEL}>Envelope</span>
                <span className={`${MONO} truncate text-[13px] text-[#ecedee]`}>{stageId}</span>
              </div>
              <EnvelopeStatusPill status={outbound.status} />
              <p className="text-[13px] leading-snug text-[#ecedee]">{outbound.summary}</p>
              {outbound.artifacts.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {outbound.artifacts.map((path) => (
                    <button
                      key={path}
                      type="button"
                      disabled={!onOpenArtifact}
                      className={`${MONO} flex h-[26px] items-center gap-1.5 rounded-md border border-[#ffffff1a] bg-[#1a1c21] px-2 text-[11px] text-[#a7aab2] hover:border-[#ffffff28] disabled:hover:border-[#ffffff1a]`}
                      onClick={() => onOpenArtifact?.(path)}
                    >
                      <LuFileText className="size-3 text-[#8b8f98]" aria-hidden />
                      {artifactName(path)}
                    </button>
                  ))}
                </div>
              ) : null}
              {onOpenEnvelope ? (
                <button
                  type="button"
                  className="w-fit text-xs text-[#8b8f98] hover:text-[#ecedee]"
                  onClick={() => onOpenEnvelope(stageId)}
                >
                  Open full record
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1 px-4 py-3">
        <span className={`${SECTION_LABEL} mb-1`}>Actions</span>
        {showRetry ? (
          <button
            type="button"
            className={ACTION_ROW}
            disabled={retryBusy || retryBlocked}
            onClick={() => onRetry(stageId)}
          >
            <LuRotateCcw className="size-3.5 text-[#8b8f98]" aria-hidden />
            <span>Retry stage</span>
            {retryBlocked ? (
              <span className="ml-auto text-xs text-[#8b8f98]">answer gate first</span>
            ) : null}
          </button>
        ) : null}
        {canResumeTimedOut(stage) ? (
          <button
            type="button"
            className={ACTION_ROW}
            disabled={retryBusy || retryBlocked}
            onClick={() => onResume(stageId)}
          >
            <LuPlay className="size-3.5 text-[#8b8f98]" aria-hidden />
            <span>Resume stage</span>
            {retryBlocked ? (
              <span className="ml-auto text-xs text-[#8b8f98]">answer gate first</span>
            ) : null}
          </button>
        ) : null}
        <button type="button" className={ACTION_ROW} onClick={() => copyRunId(run.run_id)}>
          <LuCopy className="size-3.5 text-[#8b8f98]" aria-hidden />
          <span>Copy run id</span>
          <kbd className="ml-auto rounded-sm border border-[#ffffff1a] bg-[#131418] px-[5px] font-mono text-[11px] text-[#8b8f98]">
            C
          </kbd>
        </button>
        {artifactPath && onOpenArtifact ? (
          <button type="button" className={ACTION_ROW} onClick={() => onOpenArtifact(artifactPath)}>
            <LuFileText className="size-3.5 text-[#8b8f98]" aria-hidden />
            <span>Open artifact</span>
          </button>
        ) : null}
        {canAbandon(stage.status) ? (
          <button
            type="button"
            className={ACTION_ROW}
            disabled={retryBusy}
            onClick={() => onAbandon(stageId)}
          >
            <LuSquare className="size-3.5 text-[#8b8f98]" aria-hidden />
            <span>Abandon stage</span>
          </button>
        ) : null}
      </div>
    </InspectorColumn>
  );
}
