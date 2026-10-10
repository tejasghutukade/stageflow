import type { RunSummary } from "../../api";
import type { RunDisplayGroupId } from "../../catalog/runsGrouping";
import { formatCostUsd } from "../../components/CostBadge";
import {
  formatRunCost,
  formatRunDuration,
} from "../../runs/formatRunMetrics";
import { runDisplayStatus } from "../../status/runStatus";
import { canRetry } from "../../stageAction";
import { Keycap } from "../Keycap";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import { DataTableRow } from "../shell/DataTable";
import { formatRunsListStarted } from "./runsFormat";
import { RunsMiniTrackBar } from "./RunsMiniTrackBar";
import {
  runsPipelinePathTitle,
  runsPipelineStageLine,
  runsTaskGoal,
  runsTaskId,
  runsTaskSecondLine,
} from "./runsRowHelpers";
import {
  RUNS_COL_ACTIONS,
  RUNS_COL_COST,
  RUNS_COL_DURATION,
  RUNS_COL_PIPE,
  RUNS_COL_STARTED,
  RUNS_COL_STATUS,
  RUNS_COL_TASK,
  RUNS_COL_TOKENS,
  RUNS_ROW,
} from "./runsTableLayout";

export function RunsTableRow({
  run,
  groupId,
  selected,
  now,
  onOpen,
  onAnswer,
  onRetry,
  retryBusy,
}: {
  run: RunSummary;
  groupId?: RunDisplayGroupId;
  selected?: boolean;
  now: number;
  onOpen: () => void;
  onAnswer: () => void;
  onRetry: () => void;
  retryBusy?: boolean;
}) {
  const displayStatus = runDisplayStatus(run);
  const signal = statusSignalFromRun(run);
  const secondLine = runsTaskSecondLine(run);
  const pipe = runsPipelineStageLine(run);
  const pathTitle = runsPipelinePathTitle(run);
  const failedStage = run.failed_stage_id
    ? run.stages?.find((s) => s.id === run.failed_stage_id)
    : undefined;
  const showRetry =
    Boolean(run.failed_stage_id) &&
    failedStage &&
    canRetry(failedStage.status);

  return (
    <DataTableRow
      selected={selected}
      needs={Boolean(run.waiting_stage_id)}
      onClick={onOpen}
      className="h-[44px] max-h-[44px] min-h-[44px] shrink-0 overflow-hidden px-0 py-0 hover:bg-[var(--sf-raised)]"
    >
      <div className={RUNS_ROW}>
        <div className={`${RUNS_COL_STATUS} flex`}>
          <StatusPill
            signal={signal}
            label={runStatusPillLabel(displayStatus)}
          />
        </div>
        <div className={RUNS_COL_TASK}>
          <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="shrink-0 font-['Geist_Mono',monospace] text-[13px] leading-[1.23077] text-[var(--sf-text-1)]">
              {runsTaskId(run)}
            </span>
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] leading-[1.23077] text-[var(--sf-text-2)]">
              {runsTaskGoal(run)}
            </span>
          </div>
          <p className={secondLine.className} title={secondLine.title}>
            {secondLine.text || "\u00a0"}
          </p>
        </div>
        <div className={RUNS_COL_PIPE}>
          <div className="flex items-center justify-between gap-2">
            <span
              className="truncate font-['Geist_Mono',monospace] text-xs leading-[1.33333] text-[var(--sf-text-2)]"
              title={pathTitle}
            >
              {pipe.pipelineId}
            </span>
            <span
              className={`shrink-0 font-['Geist_Mono',monospace] text-xs leading-[1.33333] ${pipe.stageClass}`}
            >
              {pipe.stageLabel}
            </span>
          </div>
          <RunsMiniTrackBar stages={run.stages ?? []} />
        </div>
        <div className={RUNS_COL_STARTED}>
          {formatRunsListStarted(run, groupId, now)}
        </div>
        <div className={RUNS_COL_DURATION}>
          {formatRunDuration(
            run.created_at,
            run.finished_at,
            run.updated_at,
            now,
          )}
        </div>
        <div className={RUNS_COL_TOKENS}>—</div>
        <div className={RUNS_COL_COST}>{formatRunCost(run.total_cost_usd)}</div>
        <div className={RUNS_COL_ACTIONS}>
          {run.waiting_stage_id ? (
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)]"
              onClick={(e) => {
                e.stopPropagation();
                onAnswer();
              }}
            >
              Answer
            </button>
          ) : null}
          {showRetry ? (
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 font-sans text-[13px] font-medium text-[var(--sf-text-1)] disabled:opacity-50"
              disabled={retryBusy}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              Retry
              <Keycap>R</Keycap>
            </button>
          ) : null}
        </div>
      </div>
    </DataTableRow>
  );
}

export function RunsFooter({
  visibleRuns,
  hints,
}: {
  visibleRuns: RunSummary[];
  hints?: React.ReactNode;
}) {
  const costSum = visibleRuns.reduce(
    (acc, r) => acc + (r.total_cost_usd ?? 0),
    0,
  );
  const hasCost = visibleRuns.some((r) => r.total_cost_usd !== undefined);
  return (
    <footer className="flex h-10 shrink-0 items-center justify-between border-t border-t-[#ffffff12] bg-[var(--sf-rail)] px-5">
      <span className="flex items-center gap-2 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]">
        {visibleRuns.length} run{visibleRuns.length === 1 ? "" : "s"}
        {hasCost ? (
          <>
            <span className="text-[var(--sf-text-3)]">·</span>
            <span className="text-[var(--sf-text-2)]">
              {formatCostUsd(costSum) ?? ""} total
            </span>
          </>
        ) : null}
      </span>
      {hints ? (
        <div className="flex items-center gap-3.5 text-xs text-[var(--sf-text-3)]">
          {hints}
        </div>
      ) : null}
    </footer>
  );
}

export function RunsFooterHints() {
  return (
    <>
      <span className="flex items-center gap-[5px]">
        <Keycap>J</Keycap>
        <Keycap>K</Keycap>
        move
      </span>
      <span className="flex items-center gap-[5px]">
        <Keycap>Enter</Keycap>
        open
      </span>
      <span className="flex items-center gap-[5px]">
        <Keycap>R</Keycap>
        retry
      </span>
      <span className="flex items-center gap-[5px]">
        <Keycap>A</Keycap>
        answer
      </span>
    </>
  );
}
