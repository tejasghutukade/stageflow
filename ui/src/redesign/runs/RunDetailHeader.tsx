import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RunDetail, RunSummary, StageSnapshot } from "../../api";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import { runShortId } from "../../catalogJoin";
import { formatRunCost, formatRunDuration } from "../../runs/formatRunMetrics";
import { StatusPill } from "../StatusPill";
import {
  runStatusPillLabel,
  statusSignalFromRun,
} from "../statusSignal";
import { runDisplayStatus } from "../../status/runStatus";
import {
  canCancelRun,
  canDeleteRun,
  isActiveRunStatus,
} from "../../runLifecycle/runActions";
import {
  stageActionVisibility,
  type StageActionVisibility,
} from "./stageActionVisibility";
import {
  LuChevronRight,
  LuCopy,
  LuEllipsis,
  LuOctagonX,
  LuPlay,
  LuRefreshCw,
  LuRotateCcw,
  LuSquare,
  LuTrash2,
} from "react-icons/lu";
import { useHotkeys } from "../keys";
import { RunDetailViewToggle } from "./RunDetailViewToggle";
import { runsPipelineDisplayId } from "./runsRowHelpers";
import { runGoalFromTaskYaml } from "./runTaskGoal";
import { runUsageSummary } from "./runUsageSummary";

const KBD =
  "rounded-sm border border-[#ffffff1a] bg-[#131418] px-[5px] font-['Geist_Mono',monospace] text-[11px] leading-[16px] text-[#8b8f98]";

const STAGE_ACTION =
  "flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 font-sans text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export type RunDetailViewMode = "timeline" | "graph" | "list";

function stageDotClass(status: string): string {
  if (status === "failed") return "bg-[#f2645a]";
  if (status === "running") return "bg-[var(--sf-running)]";
  if (status === "interrupted" || status === "waiting_for_input") return "bg-[#f5b544]";
  if (status === "succeeded") return "bg-[#4cc38a]";
  return "bg-[#8b8f98]";
}

function StageActionGroup({
  stage,
  stageLabel,
  visibility,
  onRetry,
  onResume,
  onAbandon,
  retrying,
  resuming,
  abandoning,
  disabled,
}: {
  stage: StageSnapshot;
  stageLabel: string;
  visibility: StageActionVisibility;
  onRetry?: () => void;
  onResume?: () => void;
  onAbandon?: () => void;
  retrying?: boolean;
  resuming?: boolean;
  abandoning?: boolean;
  disabled?: boolean;
}) {
  const { showRetry, showResume, showAbandon, retryDisabled } = visibility;
  if (!showRetry && !showResume && !showAbandon) return null;
  const busy = disabled || retrying || resuming || abandoning;

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[#ffffff1a] bg-[#131418] pl-2.5 pr-1"
      role="group"
      aria-label={`Actions for stage ${stageLabel}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${stageDotClass(stage.status)}`} aria-hidden />
      <span
        className="max-w-[160px] truncate font-['Geist_Mono',monospace] text-[12px] text-[#ecedee]"
        title={stageLabel}
      >
        {stageLabel}
      </span>
      <span className="mx-1 h-4 w-px shrink-0 bg-[#ffffff14]" aria-hidden />
      {showRetry ? (
        <button
          type="button"
          className={`${STAGE_ACTION} bg-[#ffffff14] text-[#ecedee] hover:bg-[#ffffff1f]`}
          disabled={busy || retryDisabled}
          onClick={onRetry}
          title={
            retryDisabled
              ? "Answer the open gate before retrying"
              : "Start a new attempt of this stage; downstream stages continue from it"
          }
        >
          <LuRefreshCw className={`size-3 shrink-0${retrying ? " animate-spin" : ""}`} aria-hidden />
          {retrying ? "Retrying…" : "Retry stage"}
          <kbd className={KBD}>R</kbd>
        </button>
      ) : null}
      {showResume ? (
        <button
          type="button"
          className={`${STAGE_ACTION} text-[#ecedee] hover:bg-[#ffffff0f]`}
          disabled={busy || retryDisabled}
          onClick={onResume}
          title="Continue the interrupted attempt on the same agent session"
        >
          <LuPlay className="size-3 shrink-0" aria-hidden />
          {resuming ? "Resuming…" : "Resume"}
        </button>
      ) : null}
      {showAbandon ? (
        <button
          type="button"
          className={`${STAGE_ACTION} text-[#f5b544] hover:bg-[#f5b5441a]`}
          disabled={Boolean(disabled) || Boolean(abandoning)}
          onClick={onAbandon}
          title="Stop this stage and mark it failed; the rest of the run is left alone"
        >
          <LuSquare className="size-3 shrink-0" aria-hidden />
          {abandoning ? "Abandoning…" : "Abandon"}
        </button>
      ) : null}
    </div>
  );
}

function RunMenuItem({
  icon,
  title,
  description,
  tone,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  tone: "warn" | "danger";
  disabled?: boolean;
  onSelect: () => void;
}) {
  const toneClass =
    tone === "danger"
      ? "text-[#f2645a] group-hover:bg-[#f2645a1f]"
      : "text-[#f5b544] group-hover:bg-[#f5b5441a]";
  return (
    <button
      type="button"
      role="menuitem"
      className="group flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[#ffffff0a] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onSelect}
    >
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-[#ffffff12] bg-[#131418] ${toneClass}`}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`font-sans text-[13px] font-medium ${
            tone === "danger" ? "text-[#f2645a]" : "text-[#ecedee]"
          }`}
        >
          {title}
        </span>
        <span className="font-sans text-xs leading-snug text-[#8b8f98]">{description}</span>
      </span>
    </button>
  );
}

function RunActionsMenu({
  canCancel,
  canDelete,
  activeRun,
  cancelling,
  deleting,
  disabled,
  onCancel,
  onDelete,
}: {
  canCancel: boolean;
  canDelete: boolean;
  activeRun: boolean;
  cancelling?: boolean;
  deleting?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!canCancel && !canDelete) return null;
  const busyLabel = cancelling ? "Cancelling…" : deleting ? "Deleting…" : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 font-sans text-[13px] font-medium text-[#a7aab2] hover:bg-[#ffffff0a] hover:text-[#ecedee] disabled:opacity-60 ${
          open ? "border-[#ffffff28] bg-[#ffffff0a] text-[#ecedee]" : "border-transparent"
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More run actions"
        title="More run actions"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {busyLabel ?? <LuEllipsis className="size-4" aria-hidden />}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-50 flex w-[300px] flex-col rounded-xl border border-[#ffffff1a] bg-[#16181c] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        >
          <span className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.88px] text-[#8b8f98]">
            Run actions
          </span>
          {canCancel ? (
            <RunMenuItem
              icon={<LuOctagonX className="size-3.5" aria-hidden />}
              title="Cancel run"
              description="Stop every active stage and mark the run cancelled. History is kept."
              tone="warn"
              disabled={cancelling || deleting}
              onSelect={() => {
                setOpen(false);
                onCancel();
              }}
            />
          ) : null}
          {canCancel && canDelete ? (
            <span className="mx-2.5 my-1 h-px bg-[#ffffff12]" aria-hidden />
          ) : null}
          {canDelete ? (
            <RunMenuItem
              icon={<LuTrash2 className="size-3.5" aria-hidden />}
              title="Delete run"
              description={
                activeRun
                  ? "Cancel, then permanently remove the run, workspace, and artifacts."
                  : "Permanently remove the run, workspace, and artifacts. Cannot be undone."
              }
              tone="danger"
              disabled={cancelling || deleting}
              onSelect={() => {
                setOpen(false);
                onDelete();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatStartedLabel(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `started ${hh}:${mm}`;
}

export function RunDetailHeader({
  run,
  onBack,
  viewMode,
  onViewModeChange,
  selectedStage,
  selectedStageLabel,
  retryBlocked,
  onCancel,
  onDelete,
  onRerun,
  onRetryStage,
  onResumeStage,
  onAbandonStage,
  cancelling,
  deleting,
  rerunning,
  retrying,
  resuming,
  abandoning,
  actionError,
  now,
}: {
  run: RunDetail;
  onBack: () => void;
  viewMode: RunDetailViewMode;
  onViewModeChange: (mode: RunDetailViewMode) => void;
  selectedStage?: StageSnapshot | null;
  selectedStageLabel?: string;
  retryBlocked?: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onRerun: () => void;
  onRetryStage?: () => void;
  onResumeStage?: () => void;
  onAbandonStage?: () => void;
  cancelling?: boolean;
  deleting?: boolean;
  rerunning?: boolean;
  retrying?: boolean;
  resuming?: boolean;
  abandoning?: boolean;
  actionError?: string | null;
  now?: number;
}) {
  const runBusy = Boolean(rerunning || cancelling || deleting);
  const stageActions = selectedStage
    ? stageActionVisibility({
        status: selectedStage.status,
        events: selectedStage.events,
        retryBlocked: Boolean(retryBlocked),
        hasRetry: Boolean(onRetryStage),
        hasResume: Boolean(onResumeStage),
        hasAbandon: Boolean(onAbandonStage),
      })
    : null;
  const retryAvailable = Boolean(
    stageActions?.showRetry &&
      !stageActions.retryDisabled &&
      !retrying &&
      !runBusy,
  );

  useHotkeys(
    [
      {
        key: "f",
        scope: "run-detail",
        when: () => !runBusy,
        handler: (e) => {
          e.preventDefault();
          onRerun();
        },
      },
      {
        key: "r",
        scope: "run-detail",
        when: () => retryAvailable,
        handler: (e) => {
          e.preventDefault();
          onRetryStage?.();
        },
      },
    ],
    "run-detail",
  );

  const duration = formatRunDuration(
    run.created_at,
    run.finished_at,
    run.finished_at ? run.updated_at : undefined,
    now ?? Date.now(),
  );
  const started = formatStartedLabel(run.created_at);
  const cost = formatRunCost(run.total_cost_usd);

  const pipelineLabel = runsPipelineDisplayId(run as unknown as RunSummary);
  const showPipeline =
    pipelineLabel && pipelineLabel !== "—" ? pipelineLabel : null;
  const goalSummary = runGoalFromTaskYaml(run.task_yaml);
  const usage = runUsageSummary(run.stages);
  const elapsed = duration && duration !== "—" ? duration : null;
  const costLabel = cost && cost !== "—" ? cost : null;
  const meta: Array<{ text: string; tone: "lead" | "rest" }> = [];
  if (showPipeline) meta.push({ text: showPipeline, tone: "lead" });
  if (started) meta.push({ text: started, tone: "rest" });
  if (elapsed) meta.push({ text: elapsed, tone: "rest" });
  if (usage) meta.push({ text: `${usage.tokensLabel} tok`, tone: "rest" });
  if (costLabel) meta.push({ text: costLabel, tone: "rest" });
  if (usage) meta.push({ text: usage.modelLabel, tone: "rest" });

  const copyRunId = () => {
    void navigator.clipboard?.writeText(run.run_id);
  };

  return (
    <header className="flex w-full shrink-0 items-end justify-between gap-6 border-b border-b-[#ffffff12] px-5 py-4">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="font-sans text-xs leading-normal text-[var(--sf-text-2)] hover:text-[var(--sf-text-1)]"
            onClick={onBack}
          >
            Runs
          </button>
          <LuChevronRight
            className="size-3 shrink-0 text-[var(--sf-text-3)]"
            aria-hidden="true"
          />
          <span className="whitespace-nowrap font-['Geist_Mono',monospace] text-xs leading-normal text-[var(--sf-text-1)]">
            {runShortId(run.run_id)}
          </span>
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-[#ffffff0a]"
            onClick={copyRunId}
            aria-label="Copy run id"
          >
            <LuCopy className="size-3 text-[var(--sf-text-3)]" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="shrink-0 font-sans text-xl font-semibold leading-[1.2] tracking-[-0.4px] text-[var(--sf-text-1)]">
            {runTaskLabel(run)}
          </h1>
          <StatusPill
            signal={statusSignalFromRun(run as unknown as RunSummary)}
            label={runStatusPillLabel(runDisplayStatus(run as unknown as RunSummary))}
          />
          {goalSummary ? (
            <span
              className="min-w-0 truncate font-sans text-[13px] leading-normal text-[var(--sf-text-3)]"
              title={goalSummary}
            >
              {goalSummary}
            </span>
          ) : null}
        </div>
        {meta.length > 0 ? (
          <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden font-['Geist_Mono',monospace] text-xs">
            {meta.flatMap((part, index) => {
              const item = (
                <span
                  key={`${part.text}-${index}`}
                  className={
                    part.tone === "lead"
                      ? "shrink-0 whitespace-nowrap text-[#ecedee]"
                      : "shrink-0 whitespace-nowrap text-[#a7aab2]"
                  }
                >
                  {part.text}
                </span>
              );
              if (index === 0) return [item];
              return [
                <span key={`sep-${index}`} className="shrink-0 text-[#8b8f98]">
                  ·
                </span>,
                item,
              ];
            })}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
      <div className="flex flex-nowrap items-center gap-2">
        {selectedStage && stageActions ? (
          <StageActionGroup
            stage={selectedStage}
            stageLabel={selectedStageLabel ?? selectedStage.stage_id}
            visibility={stageActions}
            onRetry={onRetryStage}
            onResume={onResumeStage}
            onAbandon={onAbandonStage}
            retrying={retrying}
            resuming={resuming}
            abandoning={abandoning}
            disabled={runBusy}
          />
        ) : null}
        <button
          type="button"
          className="flex h-8 shrink-0 items-center whitespace-nowrap bg-[#1a1c21] border border-[#ffffff1a] rounded-lg px-3 py-0 gap-1.5 hover:border-[#ffffff28] hover:bg-[#202228] disabled:opacity-60"
          disabled={runBusy}
          onClick={onRerun}
          title="Start a new run with the same pipeline and task"
        >
          <LuRotateCcw className="size-3.5 shrink-0 text-[#ecedee]" aria-hidden="true" />
          <span className="text-[#ecedee] font-sans text-[13px] font-medium">
            {rerunning ? "Starting fresh…" : "Start fresh"}
          </span>
          <kbd className={KBD}>F</kbd>
        </button>
        <RunActionsMenu
          canCancel={canCancelRun(run.status, run.stages)}
          canDelete={canDeleteRun(run.status)}
          activeRun={isActiveRunStatus(run.status)}
          cancelling={cancelling}
          deleting={deleting}
          disabled={Boolean(rerunning)}
          onCancel={onCancel}
          onDelete={onDelete}
        />
        <span className="block w-px h-5 bg-[#ffffff12] mx-1 shrink-0" aria-hidden="true" />
        <RunDetailViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      </div>
      {actionError ? (
        <p
          role="alert"
          className="max-w-[420px] text-right font-sans text-[12px] leading-snug text-[var(--sf-fail)]"
        >
          {actionError}
        </p>
      ) : null}
      </div>
    </header>
  );
}
