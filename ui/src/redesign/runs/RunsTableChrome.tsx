import type { ReactNode } from "react";
import type { RunSummary } from "../../api";
import type { RunDisplayGroupId } from "../../catalog/runsGrouping";
import { relativeTime } from "../../catalogJoin";
import { LuHand, LuLoaderCircle } from "react-icons/lu";
import {
  RUNS_COL_ACTIONS,
  RUNS_COL_COST,
  RUNS_COL_DURATION,
  RUNS_COL_HEADER,
  RUNS_COL_PIPE,
  RUNS_COL_STARTED,
  RUNS_COL_STATUS,
  RUNS_COL_TASK,
  RUNS_COL_TOKENS,
  RUNS_HEAD_CELL,
} from "./runsTableLayout";

export function RunsColumnHeader() {
  return (
    <div className={RUNS_COL_HEADER} role="row">
      <span className={`${RUNS_COL_STATUS} ${RUNS_HEAD_CELL} text-left`}>
        Status
      </span>
      <span className={`${RUNS_COL_TASK} min-w-0 flex-1 ${RUNS_HEAD_CELL} text-left`}>
        Task
      </span>
      <span className={`${RUNS_COL_PIPE} ${RUNS_HEAD_CELL} text-left`}>
        Pipeline & stages
      </span>
      <span className={`${RUNS_COL_STARTED} ${RUNS_HEAD_CELL} text-left`}>
        Started
      </span>
      <span className={`${RUNS_COL_DURATION} ${RUNS_HEAD_CELL} text-right`}>
        Duration
      </span>
      <span className={`${RUNS_COL_TOKENS} ${RUNS_HEAD_CELL} text-right`}>
        Tokens
      </span>
      <span className={`${RUNS_COL_COST} ${RUNS_HEAD_CELL} text-right`}>
        Cost
      </span>
      <span className={`${RUNS_COL_ACTIONS} block`} />
    </div>
  );
}

function groupHeadingMeta(
  groupId: RunDisplayGroupId,
  runs: RunSummary[],
  now: number,
): { Icon?: typeof LuHand; hint?: string; band?: boolean } {
  if (groupId === "needs_you") {
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const run of runs) {
      const t = Date.parse(run.updated_at ?? run.created_at);
      if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
    }
    const oldest =
      Number.isFinite(oldestMs)
        ? relativeTime(new Date(oldestMs).toISOString(), now)
        : null;
    const hint =
      runs.length > 0
        ? `${runs.length} run${runs.length === 1 ? "" : "s"} holding agent slots${oldest ? ` · oldest waiting ${oldest}` : ""}`
        : undefined;
    return { Icon: LuHand, hint, band: true };
  }
  if (groupId === "running") {
    return { Icon: LuLoaderCircle };
  }
  return {};
}

function groupTitle(groupId: RunDisplayGroupId, label: string): string {
  if (groupId === "earlier_today") return "Earlier today";
  if (groupId === "earlier") return "Earlier";
  return label;
}

export function RunGroup({
  groupId,
  label,
  runs,
  now,
  children,
}: {
  groupId: RunDisplayGroupId;
  label: string;
  runs: RunSummary[];
  now: number;
  children: ReactNode;
}) {
  const meta = groupHeadingMeta(groupId, runs, now);
  const title = groupTitle(groupId, label);
  return (
    <section data-group={groupId}>
      <h2
        className={`flex h-8 w-full items-center gap-2 border-b border-b-[#ffffff12] px-5 py-0${
          meta.band ? " bg-[#f5b5440a]" : ""
        }`}
      >
        {meta.Icon ? (
          <meta.Icon
            className={`size-[13px] shrink-0${groupId === "needs_you" ? " text-[var(--sf-needs)]" : groupId === "running" ? " text-[var(--sf-running)]" : " text-[var(--sf-text-3)]"}`}
            aria-hidden="true"
          />
        ) : null}
        <span className="font-sans text-[13px] font-semibold leading-normal text-[var(--sf-text-1)]">
          {title}
        </span>
        <span className="font-['Geist_Mono',monospace] text-xs leading-normal text-[var(--sf-text-3)]">
          {runs.length}
        </span>
        <span className="block flex-1" />
        {meta.hint ? (
          <span className="font-sans text-xs leading-normal text-[var(--sf-text-3)]">
            {meta.hint}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}
