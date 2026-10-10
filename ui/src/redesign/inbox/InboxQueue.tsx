import type { RunSummary } from "../../api";
import { runLocatorSubtitle, runTaskLabel } from "../../catalog/displayCatalogPath";
import { relativeTime } from "../../catalogJoin";
import { DataTableRow } from "../shell/DataTable";
import { FilterTabs } from "../shell/FilterTabs";
import { Keycap } from "../Keycap";
import { formatRunElapsed } from "./inboxViews";
import type { FailedSortOrder } from "./failedViews";
import { partitionFailedRuns, sortFailedRuns } from "./failedViews";
import type { InboxTabId } from "./inboxTab";
import { LuCircleHelp, LuLoader, LuX } from "react-icons/lu";

export type InboxTab = InboxTabId;

export type InboxQueueProps = {
  tab: InboxTab;
  onTabChange: (tab: InboxTab) => void;
  waiting: RunSummary[];
  broken: RunSummary[];
  finished: RunSummary[];
  alsoRunning: RunSummary[];
  alsoFailed: RunSummary[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  onAlsoHappeningOpen: (runId: string) => void;
  failedSortOrder: FailedSortOrder;
  onFailedSortToggle: () => void;
  loading?: boolean;
};

function kindLabel(kind: RunSummary["waiting_kind"]): string {
  if (!kind) return "gate";
  return kind.replace(/_/g, " ");
}

function GateRowIcon({ selected }: { selected: boolean }) {
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-full${
        selected ? " bg-[#f5b54429]" : " bg-[#f5b5441a]"
      }`}
      aria-hidden="true"
    >
      <LuCircleHelp className="size-3.5 text-[var(--sf-needs)]" />
    </span>
  );
}

function FailedRowIcon() {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#ff4d4d1a]"
      aria-hidden="true"
    >
      <LuX className="size-3.5 text-[var(--sf-fail)]" />
    </span>
  );
}

function FailedRunRow({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: (runId: string) => void;
}) {
  return (
    <DataTableRow
      variant="gate"
      selected={selected}
      needs={false}
      onClick={() => onSelect(run.run_id)}
    >
      <FailedRowIcon />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">
          {runTaskLabel(run)}
        </div>
        <div className="truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
          {run.failed_stage_id ?? "—"}
        </div>
        {run.failed_reason ? (
          <p className="truncate text-xs leading-snug text-[var(--sf-text-2)]">
            {run.failed_reason}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--sf-text-3)]">
          <span className="min-w-0 truncate">{runLocatorSubtitle(run)}</span>
          <span className="shrink-0 font-['Geist_Mono',monospace]">
            {relativeTime(run.updated_at ?? run.created_at)}
          </span>
        </div>
      </div>
    </DataTableRow>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div className="px-3 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
      {children}
    </div>
  );
}

export function InboxQueue({
  tab,
  onTabChange,
  waiting,
  broken,
  finished,
  alsoRunning,
  alsoFailed,
  selectedId,
  onSelect,
  onAlsoHappeningOpen,
  failedSortOrder,
  onFailedSortToggle,
  loading,
}: InboxQueueProps) {
  const sortedBroken = sortFailedRuns(broken, failedSortOrder);
  const failedPartition = partitionFailedRuns(sortedBroken);

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-r border-r-[#ffffff0f]">
      <div className="flex shrink-0 flex-col gap-3.5 border-b border-b-[#ffffff0f] px-5 pb-0 pt-[18px]">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
            Inbox
          </h1>
          {tab === "failed" ? (
            <button
              type="button"
              className="shrink-0 rounded-md border border-[#ffffff1a] px-2 py-1 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]"
              onClick={onFailedSortToggle}
            >
              {failedSortOrder === "newest" ? "Newest" : "Oldest"}
            </button>
          ) : null}
        </div>
        <FilterTabs
          variant="queue"
          activeId={tab}
          onChange={(id) => onTabChange(id as InboxTab)}
          tabs={[
            { id: "needs", label: "Needs you", count: waiting.length },
            { id: "failed", label: "Failed", count: broken.length },
            { id: "done_today", label: "Done today", count: finished.length },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {loading ? (
          <p className="px-3 py-2 text-xs text-[var(--sf-text-3)]">Loading…</p>
        ) : null}

        {tab === "needs"
          ? waiting.map((run) => {
              const selected = selectedId === run.run_id;
              return (
                <DataTableRow
                  key={run.run_id}
                  variant="gate"
                  selected={selected}
                  needs
                  onClick={() => onSelect(run.run_id)}
                >
                  <GateRowIcon selected={selected} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">
                      {runTaskLabel(run)}
                    </div>
                    <div className="truncate font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-3)]">
                      {run.waiting_stage_id ?? run.failed_stage_id} ·{" "}
                      {kindLabel(run.waiting_kind)}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--sf-text-3)]">
                      <span className="min-w-0 truncate">{runLocatorSubtitle(run)}</span>
                      <span className="shrink-0 font-['Geist_Mono',monospace]">
                        {relativeTime(run.updated_at ?? run.created_at)}
                      </span>
                    </div>
                    {run.waiting_summary ? (
                      <p className="line-clamp-2 text-xs leading-snug text-[var(--sf-text-2)]">
                        {run.waiting_summary}
                      </p>
                    ) : null}
                  </div>
                </DataTableRow>
              );
            })
          : null}

        {tab === "failed" && !loading && broken.length === 0 ? (
          <p className="px-3 py-4 text-sm text-[var(--sf-text-3)]">
            No failed runs right now.
          </p>
        ) : null}

        {tab === "done_today" && !loading && finished.length === 0 ? (
          <p className="px-3 py-4 text-sm text-[var(--sf-text-3)]">
            No finished runs in the catalog yet.
          </p>
        ) : null}

        {tab === "failed" ? (
          <>
            {failedPartition.interrupted.length > 0 ? (
              <>
                <GroupLabel>INTERRUPTED</GroupLabel>
                {failedPartition.interrupted.map((run) => (
                  <FailedRunRow
                    key={run.run_id}
                    run={run}
                    selected={selectedId === run.run_id}
                    onSelect={onSelect}
                  />
                ))}
              </>
            ) : null}
            {failedPartition.other.map((run) => (
              <FailedRunRow
                key={run.run_id}
                run={run}
                selected={selectedId === run.run_id}
                onSelect={onSelect}
              />
            ))}
          </>
        ) : null}

        {tab === "done_today"
          ? finished.map((run) => {
              const selected = selectedId === run.run_id;
              return (
                <DataTableRow
                  key={run.run_id}
                  variant="gate"
                  selected={selected}
                  needs={false}
                  onClick={() => onSelect(run.run_id)}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="truncate text-[13px] font-medium text-[var(--sf-text-1)]">
                      {runTaskLabel(run)}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--sf-text-3)]">
                      <span className="min-w-0 truncate">{runLocatorSubtitle(run)}</span>
                      <span className="shrink-0 font-['Geist_Mono',monospace]">
                        {relativeTime(run.updated_at ?? run.created_at)}
                      </span>
                    </div>
                  </div>
                </DataTableRow>
              );
            })
          : null}

        {tab === "needs" && (alsoFailed.length > 0 || alsoRunning.length > 0) ? (
          <>
            <div className="px-3 pb-1.5 pt-5 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
              Also happening
            </div>
            {alsoFailed.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-left"
                onClick={() => onAlsoHappeningOpen(run.run_id)}
              >
                <LuX className="size-3.5 shrink-0 text-[var(--sf-fail)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-2)]">
                  {runTaskLabel(run)}
                </span>
              </button>
            ))}
            {alsoRunning.map((run) => (
              <button
                key={run.run_id}
                type="button"
                className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-left"
                onClick={() => onAlsoHappeningOpen(run.run_id)}
              >
                <LuLoader className="size-3.5 shrink-0 text-[var(--sf-running)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-2)]">
                  {runTaskLabel(run)}
                </span>
                <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-running)]">
                  {formatRunElapsed(run)}
                </span>
              </button>
            ))}
          </>
        ) : null}

        <footer className="mt-auto flex items-center gap-3 px-3 pb-2 pt-4 text-xs text-[var(--sf-text-3)]">
          {tab === "needs" ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Keycap>J</Keycap>
                <Keycap>K</Keycap>
                move
              </span>
              <span className="inline-flex items-center gap-1">
                <Keycap>O</Keycap>
                open
              </span>
            </>
          ) : null}
          {tab === "failed" ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Keycap>J</Keycap>
                <Keycap>K</Keycap>
                move
              </span>
              <span className="inline-flex items-center gap-1">
                <Keycap>O</Keycap>
                open
              </span>
              <span className="inline-flex items-center gap-1">
                <Keycap>R</Keycap>
                retry
              </span>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
