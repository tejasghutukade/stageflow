import type { TaskListing } from "../../api";
import type { CatalogSnapshot } from "../../catalog/source";
import { relativeTime } from "../../catalogJoin";
import { runDisplayStatus } from "../../status/runStatus";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import {
  runsForTaskListing,
  taskRootLabel,
  taskRootTitle,
  taskTotalCostUsd,
} from "./taskViews";
import { NeverRunPill } from "../NeverRunPill";

const COL_LAST = "w-[108px] shrink-0";
const COL_PIPE = "w-[92px] min-w-0 shrink-0";
const COL_RUNS = "w-9 shrink-0";
const COL_WHEN = "w-[60px] shrink-0";
const COL_COST = "w-[52px] shrink-0";

export function TasksColumnHeader() {
  return (
    <div className="flex h-8 w-full shrink-0 items-center gap-3 border-b border-b-[#ffffff12] px-5 py-0">
      <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
        Task
      </div>
      <div className={`${COL_LAST} text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]`}>
        Last run
      </div>
      <div className={`${COL_PIPE} text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]`}>
        Pipeline
      </div>
      <div className={`${COL_RUNS} text-right text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]`}>
        Runs
      </div>
      <div className={`${COL_WHEN} text-right text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]`}>
        When
      </div>
      <div className={`${COL_COST} text-right text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]`}>
        Cost
      </div>
    </div>
  );
}

export function TasksTableRow({
  task,
  snapshot,
  selected,
  showRootLabel,
  onSelect,
}: {
  task: TaskListing;
  snapshot: CatalogSnapshot;
  selected: boolean;
  showRootLabel: boolean;
  onSelect: () => void;
}) {
  const runs = runsForTaskListing(snapshot, task);
  const last = runs[0];
  const cost = taskTotalCostUsd(snapshot, task);
  const rootLabel = taskRootLabel(task);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex h-12 w-full shrink-0 items-center gap-3 border-b border-b-[#ffffff12] px-5 py-0 text-left${
        selected ? " bg-[var(--sf-panel)]" : " bg-transparent hover:bg-[var(--sf-raised)]"
      }`}
    >
      {selected ? (
        <span className="absolute left-0 top-0 block h-12 w-0.5 bg-[var(--sf-text-1)]" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span
            className="truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]"
            title={task.id}
          >
            {task.id}
          </span>
          {showRootLabel ? (
            <span
              className="shrink-0 truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]"
              title={taskRootTitle(task)}
            >
              {rootLabel}
            </span>
          ) : null}
        </div>
        <span className="truncate text-xs text-[var(--sf-text-2)]" title={task.goal}>
          {task.goal}
        </span>
      </div>
      <div className={`flex ${COL_LAST}`}>
        {last ? (
          <StatusPill
            signal={statusSignalFromRun(last)}
            label={runStatusPillLabel(runDisplayStatus(last))}
          />
        ) : (
          <NeverRunPill />
        )}
      </div>
      <span
        className={`truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)] ${COL_PIPE}`}
        title={last?.pipeline_id}
      >
        {last?.pipeline_id ?? "—"}
      </span>
      <span className={`text-right font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)] ${COL_RUNS}`}>
        {runs.length}
      </span>
      <span
        className={`text-right font-['Geist_Mono',monospace] text-xs ${COL_WHEN}${
          last ? " text-[var(--sf-text-2)]" : " text-[#8b8f98]"
        }`}
      >
        {last ? relativeTime(last.created_at) : "—"}
      </span>
      <span
        className={`text-right font-['Geist_Mono',monospace] text-xs ${COL_COST}${
          last && cost !== undefined ? " text-[var(--sf-text-1)]" : " text-[#8b8f98]"
        }`}
      >
        {cost !== undefined ? `$${cost.toFixed(2)}` : "—"}
      </span>
    </button>
  );
}
