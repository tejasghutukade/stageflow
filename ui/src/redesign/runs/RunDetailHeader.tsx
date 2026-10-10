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
import {
  LuChevronRight,
  LuCircleX,
  LuCopy,
  LuOctagonX,
  LuRotateCcw,
  LuTrash2,
} from "react-icons/lu";
import { RunDetailViewToggle } from "./RunDetailViewToggle";
import { runsPipelineDisplayId } from "./runsRowHelpers";
import { runGoalFromTaskYaml } from "./runTaskGoal";
import { runUsageSummary } from "./runUsageSummary";

const ghostActionClass =
  "flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 py-0 gap-1.5 text-[#a7aab2] font-sans text-[13px] font-medium disabled:opacity-60";

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
    run.finished_at ? run.updated_at : undefined,
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
      <div className="flex shrink-0 flex-nowrap items-center gap-2">
        {showAbandon && onAbandonStage ? (
          <button
            type="button"
            className={ghostActionClass}
            disabled={abandoning}
            onClick={onAbandonStage}
          >
            <LuCircleX className="size-3.5 shrink-0" aria-hidden="true" />
            {abandoning ? "Abandoning…" : "Abandon"}
          </button>
        ) : null}
        {canCancelRun(run.status) ? (
          <button
            type="button"
            className={ghostActionClass}
            disabled={cancelling || deleting || rerunning}
            onClick={onCancel}
          >
            <LuOctagonX className="size-3.5 shrink-0" aria-hidden="true" />
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
        {canDeleteRun(run.status) ? (
          <button
            type="button"
            className={ghostActionClass}
            disabled={cancelling || deleting || rerunning}
            onClick={onDelete}
          >
            <LuTrash2 className="size-3.5 shrink-0" aria-hidden="true" />
            {deleting ? "Deleting…" : "Delete"}
          </button>
        ) : null}
        <button
          type="button"
          className="flex h-8 shrink-0 items-center whitespace-nowrap bg-[#1a1c21] border border-[#ffffff1a] rounded-lg px-3 py-0 gap-1.5 disabled:opacity-60"
          disabled={rerunning || cancelling || deleting}
          onClick={onRerun}
        >
          <LuRotateCcw className="size-3.5 shrink-0 text-[#ecedee]" aria-hidden="true" />
          <span className="text-[#ecedee] font-sans text-[13px] font-medium">
            {rerunning ? "Starting fresh…" : "Start fresh"}
          </span>
          <span className="bg-[#131418] border border-[#ffffff1a] text-[#8b8f98] font-['Geist_Mono',monospace] text-[11px] rounded-sm px-[5px]">
            F
          </span>
        </button>
        <span className="block w-px h-5 bg-[#ffffff12] mx-1 shrink-0" aria-hidden="true" />
        <RunDetailViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />
      </div>
    </header>
  );
}
