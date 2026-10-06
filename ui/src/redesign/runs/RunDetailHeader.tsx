import type { RunDetail, RunSummary } from "../../api";
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
} from "../../runLifecycle/runActions";
import { canAbandon } from "../../stageAction";
import { LuChevronRight, LuCircleX, LuCopy, LuRotateCcw } from "react-icons/lu";
import { RunDetailViewToggle } from "./RunDetailViewToggle";
import { runsPipelineDisplayId } from "./runsRowHelpers";
import { runGoalFromTaskYaml } from "./runTaskGoal";

export type RunDetailViewMode = "timeline" | "graph" | "list";

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
  selectedStageStatus,
  onCancel,
  onDelete,
  onRerun,
  onAbandonStage,
  cancelling,
  deleting,
  rerunning,
  abandoning,
  now,
}: {
  run: RunDetail;
  onBack: () => void;
  viewMode: RunDetailViewMode;
  onViewModeChange: (mode: RunDetailViewMode) => void;
  selectedStageStatus?: string;
  onCancel: () => void;
  onDelete: () => void;
  onRerun: () => void;
  onAbandonStage?: () => void;
  cancelling?: boolean;
  deleting?: boolean;
  rerunning?: boolean;
  abandoning?: boolean;
  now?: number;
}) {
  const duration = formatRunDuration(
    run.created_at,
    run.finished_at,
    run.updated_at,
    now ?? Date.now(),
  );
  const started = formatStartedLabel(run.created_at);
  const cost = formatRunCost(run.total_cost_usd);
  const showAbandon =
    selectedStageStatus && canAbandon(selectedStageStatus as never);

  const pipelineLabel = runsPipelineDisplayId(run as unknown as RunSummary);
  const showPipeline =
    pipelineLabel && pipelineLabel !== "—" ? pipelineLabel : null;
  const goalSummary = runGoalFromTaskYaml(run.task_yaml);

  const copyRunId = () => {
    void navigator.clipboard?.writeText(run.run_id);
  };

  return (
    <header className="flex w-full shrink-0 items-end justify-between gap-6 border-b border-b-[#ffffff12] px-6 py-4">
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
          <h1 className="shrink-0 font-sans text-[21px] font-semibold leading-[1.2] tracking-[-0.42px] text-[var(--sf-text-1)]">
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
        {showPipeline || started || (duration && duration !== "—") || (cost && cost !== "—") ? (
          <div className="flex flex-wrap items-center gap-2 font-['Geist_Mono',monospace] text-xs">
            {showPipeline ? (
              <span className="whitespace-nowrap text-[var(--sf-text-1)]">{showPipeline}</span>
            ) : null}
            {showPipeline && started ? (
              <span className="text-[var(--sf-text-3)]">·</span>
            ) : null}
            {started ? (
              <span className="whitespace-nowrap text-[var(--sf-text-2)]">{started}</span>
            ) : null}
            {(showPipeline || started) && duration && duration !== "—" ? (
              <span className="text-[var(--sf-text-3)]">·</span>
            ) : null}
            {duration && duration !== "—" ? (
              <span className="whitespace-nowrap text-[var(--sf-text-2)]">{duration}</span>
            ) : null}
            {(showPipeline || started || (duration && duration !== "—")) &&
            cost &&
            cost !== "—" ? (
              <span className="text-[var(--sf-text-3)]">·</span>
            ) : null}
            {cost && cost !== "—" ? (
              <span className="whitespace-nowrap text-[var(--sf-text-2)]">{cost}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {showAbandon && onAbandonStage ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost flex h-8 items-center gap-1.5 px-3 text-[13px] font-medium"
            disabled={abandoning}
            onClick={onAbandonStage}
          >
            <LuCircleX className="size-3.5 shrink-0" aria-hidden="true" />
            {abandoning ? "Abandoning…" : "Abandon"}
          </button>
        ) : null}
        <button
          type="button"
          className="sf-btn sf-btn--secondary flex h-8 items-center gap-1.5 px-3 text-[13px] font-medium"
          disabled={rerunning || cancelling || deleting}
          onClick={onRerun}
        >
          <LuRotateCcw className="size-3.5 shrink-0" aria-hidden="true" />
          {rerunning ? "Starting fresh…" : "Start fresh"}
          {!rerunning ? (
            <span className="font-['Geist_Mono',monospace] text-[11px] font-normal text-[var(--sf-text-3)]">
              F
            </span>
          ) : null}
        </button>
        {canCancelRun(run.status) ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost flex h-8 items-center px-3 text-[13px]"
            disabled={cancelling || deleting || rerunning}
            onClick={onCancel}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
        {canDeleteRun(run.status) ? (
          <button
            type="button"
            className="sf-btn sf-btn--ghost flex h-8 items-center px-3 text-[13px]"
            disabled={cancelling || deleting || rerunning}
            onClick={onDelete}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        ) : null}
        <span className="mx-1 block h-5 w-px shrink-0 bg-[#ffffff12]" aria-hidden="true" />
        <RunDetailViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      </div>
    </header>
  );
}
