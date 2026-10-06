import type { RunSummary } from "../../api";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import {
  formatRunShortTimestamp,
  runAnsweredGateLabel,
  runShortId,
} from "../../catalogJoin";
import { Keycap } from "../Keycap";
import { readNotifyPreference } from "../../useWaitingNotifications";
import { FilterTabs } from "../shell/FilterTabs";
import { PageHeader } from "../shell/PageHeader";
import { runDisplayStatus } from "../../status/runStatus";
import { LuCheck, LuChevronRight, LuPlus } from "react-icons/lu";
import type { InboxTab } from "./InboxQueue";

export type InboxZeroProps = {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  waitingCount: number;
  brokenCount: number;
  doneCount: number;
  inFlight: RunSummary[];
  recentlyAnswered: RunSummary[];
  onStartRun: () => void;
  onOpenRuns: () => void;
  onOpenRun: (runId: string) => void;
};

function inFlightBodyCopy(count: number): string {
  if (count === 0) {
    return "No runs are in flight. We’ll put a gate here the moment an agent asks you something.";
  }
  if (count === 1) {
    return "One run is working. We’ll put a gate here the moment an agent asks you something.";
  }
  return `${count} runs are working. We’ll put a gate here the moment an agent asks you something.`;
}

export function InboxZero({
  tab,
  onTabChange,
  waitingCount,
  brokenCount,
  doneCount,
  inFlight,
  recentlyAnswered,
  onStartRun,
  onOpenRuns,
  onOpenRun,
}: InboxZeroProps) {
  const notify = readNotifyPreference();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex w-full shrink-0 flex-col">
        <PageHeader
          variant="inbox"
          title="Inbox"
          titleAddon={
            <span className="flex h-6 items-center gap-[5px] rounded-full bg-[#4cc38a1a] px-2">
              <LuCheck className="size-3 text-[var(--sf-ok)]" aria-hidden="true" />
              <span className="text-xs font-medium text-[var(--sf-ok)]">All clear</span>
            </span>
          }
        />
        <FilterTabs
          variant="underline"
          activeId={tab}
          onChange={(id) => onTabChange(id as InboxTab)}
          tabs={[
            { id: "needs", label: "Needs you", count: waitingCount },
            { id: "broken", label: "Broken", count: brokenCount },
            { id: "done", label: "Done today", count: doneCount },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-8 overflow-y-auto pb-10 pt-14">
        <div className="flex w-[720px] max-w-full flex-col items-center gap-3.5 px-4 py-2">
          <div className="flex size-[72px] items-center justify-center rounded-full bg-[#4cc38a0d]">
            <div className="flex size-[52px] items-center justify-center rounded-full border border-[#4cc38a40] bg-[#4cc38a1a]">
              <LuCheck className="size-6 text-[var(--sf-ok)]" aria-hidden="true" />
            </div>
          </div>
          <div className="flex flex-col items-center gap-1.5 pt-1">
            <h2 className="text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
              Nothing needs you
            </h2>
            <p className="max-w-md text-center text-sm text-[var(--sf-text-2)]">
              {inFlightBodyCopy(inFlight.length)}
            </p>
          </div>
          <div className="flex items-center gap-2 pt-1.5">
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] font-medium text-[var(--sf-ground)]"
              onClick={onStartRun}
            >
              <LuPlus className="size-3.5" aria-hidden="true" />
              Start a run
            </button>
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-[#ffffff1a] px-3 text-[13px] text-[var(--sf-text-1)]"
              onClick={onOpenRuns}
            >
              Open Runs
              <Keycap>G</Keycap>
            </button>
          </div>
          <p className="pt-0.5 text-xs text-[var(--sf-text-3)]">
            Desktop alerts {notify === "system" ? "on" : "off"}
          </p>
        </div>

        {inFlight.length > 0 ? (
          <div className="flex w-[720px] max-w-full flex-col gap-2.5 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                In flight
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-[var(--sf-text-2)]"
                onClick={onOpenRuns}
              >
                View runs
                <LuChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="flex flex-col overflow-hidden rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
              {inFlight.slice(0, 4).map((run, index) => (
                <button
                  key={run.run_id}
                  type="button"
                  className={`grid grid-cols-[92px_1fr_72px] items-center gap-3.5 px-3.5 py-2.5 text-left${
                    index < inFlight.length - 1 ? " border-b border-b-[#ffffff12]" : ""
                  }`}
                  onClick={() => onOpenRun(run.run_id)}
                >
                  <span className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                    {runShortId(run.run_id)}
                  </span>
                  <span className="truncate text-[13px] text-[var(--sf-text-1)]">
                    {runTaskLabel(run)}
                  </span>
                  <span className="text-right font-['Geist_Mono',monospace] text-xs text-[var(--sf-running)]">
                    {runDisplayStatus(run) === "running" ? "running" : run.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {recentlyAnswered.length > 0 ? (
          <div className="flex w-[720px] max-w-full flex-col gap-2.5 px-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                Recently answered
              </span>
            </div>
            <div className="flex flex-col overflow-hidden rounded-xl border border-[#ffffff12] bg-[var(--sf-panel)]">
              {recentlyAnswered.slice(0, 3).map((run, index) => (
                <button
                  key={run.run_id}
                  type="button"
                  className={`grid h-[52px] grid-cols-[100px_1fr_64px] items-center gap-3.5 px-3.5 text-left${
                    index < Math.min(recentlyAnswered.length, 3) - 1
                      ? " border-b border-b-[#ffffff12]"
                      : ""
                  }`}
                  onClick={() => onOpenRun(run.run_id)}
                >
                  <span className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                    {runAnsweredGateLabel(run)}
                  </span>
                  <span className="truncate text-[13px] text-[var(--sf-text-1)]">
                    {runTaskLabel(run)}
                  </span>
                  <span className="text-right font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                    {run.updated_at ? formatRunShortTimestamp(run.updated_at) : "—"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
