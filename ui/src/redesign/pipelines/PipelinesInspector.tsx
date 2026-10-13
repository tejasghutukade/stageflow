import type { ReactNode } from "react";
import { relativeTime } from "../../catalogJoin";
import { formatApproxCost } from "../../catalog/stats";
import { formatRunDuration } from "../../runs/formatRunMetrics";
import { runDisplayStatus } from "../../status/runStatus";
import { Keycap } from "../Keycap";
import { StatusPill } from "../StatusPill";
import { RunsMiniTrackBar } from "../runs/RunsMiniTrackBar";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import type { PipelineListRow } from "./pipelineViews";

const EM_DASH = "—";

const EYEBROW =
  "text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]";

function stripApproxCost(usd: number): string {
  const formatted = formatApproxCost(usd);
  return formatted.startsWith("~") ? formatted.slice(1) : formatted;
}

function inspectorStatsLine(row: PipelineListRow, catalogFailed: boolean): string {
  if (catalogFailed) return `${EM_DASH} · ${EM_DASH} · ${EM_DASH} runs`;
  const parts: string[] = [];
  if (row.stats.inspectorDuration) parts.push(row.stats.inspectorDuration);
  if (row.stats.inspectorCost) parts.push(row.stats.inspectorCost);
  parts.push(`${row.stats.runCount} runs`);
  return parts.join(" · ");
}

function gateChip(label: string) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-text-2)]">
      {label}
    </span>
  );
}

function InspectorShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}

export function PipelinesInspector({
  row,
  initialLoadDone,
  catalogFailed,
  onOpenEditor,
  onStartRun,
  onOpenWorkshop,
}: {
  row: PipelineListRow | null;
  initialLoadDone: boolean;
  catalogFailed: boolean;
  onOpenEditor?: () => void;
  onStartRun?: () => void;
  onOpenWorkshop?: () => void;
}) {
  if (!initialLoadDone) {
    return (
      <InspectorShell>
        <div className="flex flex-col gap-3 p-4" aria-hidden="true">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-5 w-40 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-4 w-full animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="mt-2 h-3 w-24 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-3 w-32 animate-pulse rounded bg-[var(--sf-raised)]" />
          <div className="h-3 w-28 animate-pulse rounded bg-[var(--sf-raised)]" />
        </div>
      </InspectorShell>
    );
  }

  if (!row) {
    return (
      <InspectorShell>
        <p className="p-4 text-[13px] text-[var(--sf-text-3)]">
          Select a pipeline to inspect it.
        </p>
      </InspectorShell>
    );
  }

  const waitingCount = catalogFailed
    ? 0
    : row.matchedRuns.filter((run) => statusSignalFromRun(run) === "needs")
        .length;
  const recentRuns = catalogFailed ? [] : row.matchedRuns.slice(0, 5);
  const showNoRuns = !catalogFailed && row.matchedRuns.length === 0;

  return (
    <InspectorShell>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-1.5">
          <div className={EYEBROW}>Pipeline</div>
          <h2 className="text-[18px] font-semibold text-[var(--sf-text-1)]">
            {row.pipeline.id}
          </h2>
          {row.catalogRootBasename ? (
            <p
              className="truncate text-[13px] text-[var(--sf-text-2)]"
              title={row.pipeline.project_root}
            >
              {row.catalogRootBasename}
            </p>
          ) : null}
          <div
            className="max-w-full truncate rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 py-0.5 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]"
            title={row.catalogPath}
          >
            {row.catalogPath}
          </div>
          <p
            className={`font-['Geist_Mono',monospace] text-xs ${
              catalogFailed
                ? "text-[var(--sf-text-3)]"
                : "text-[var(--sf-text-2)]"
            }`}
          >
            {inspectorStatsLine(row, catalogFailed)}
          </p>
        </div>

        <section className="mt-5 flex flex-col gap-2">
          <h3 className={EYEBROW}>Stages</h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {row.stages.map((stage, index) => (
              <li
                key={`${stage.id}:${index}`}
                className="flex min-w-0 items-center gap-1.5"
              >
                <span className="min-w-0 truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]">
                  {stage.id}
                </span>
                {stage.gates.kind === "gates" ? (
                  <>
                    {gateChip(stage.gates.firstLabel)}
                    {stage.gates.extraCount > 0
                      ? gateChip(`+${stage.gates.extraCount}`)
                      : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-5 flex flex-col gap-2">
          <h3 className={EYEBROW}>Tasks using this pipeline</h3>
          {row.tasks.length === 0 ? (
            <p className="text-[13px] text-[var(--sf-text-3)]">none</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {row.tasks.map((task) => (
                <li
                  key={`${task.project_root ?? ""}:${task.path}`}
                  className="truncate font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-1)]"
                >
                  {task.id}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-5 flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className={EYEBROW}>Recent runs</h3>
            {waitingCount > 0 ? (
              <span className="text-[11px] text-[var(--sf-needs)]">
                {waitingCount} waiting
              </span>
            ) : null}
          </div>
          {showNoRuns ? (
            <p className="text-[13px] text-[var(--sf-text-3)]">No runs yet.</p>
          ) : null}
          {recentRuns.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {recentRuns.map((run) => (
                <li key={run.run_id} className="flex flex-col gap-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]">
                      {run.run_id}
                    </span>
                    <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                      {relativeTime(run.created_at)}
                    </span>
                  </div>
                  <StatusPill
                    signal={statusSignalFromRun(run)}
                    label={runStatusPillLabel(runDisplayStatus(run))}
                  />
                  <RunsMiniTrackBar stages={run.stages} />
                  <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
                    {formatRunDuration(
                      run.created_at,
                      run.finished_at,
                      run.updated_at,
                    )}
                    {" · "}
                    {run.total_cost_usd === undefined
                      ? EM_DASH
                      : stripApproxCost(run.total_cost_usd)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-t-[#ffffff12] px-4 py-3">
        <button
          type="button"
          className="sf-btn sf-btn--primary w-full"
          onClick={onOpenEditor}
        >
          Open editor
          <Keycap className="border-[#0c0d0f2e] text-[#5a5d66]">Enter</Keycap>
        </button>
        <button
          type="button"
          className="sf-btn sf-btn--secondary w-full"
          onClick={onStartRun}
        >
          Start a run
          <Keycap>S</Keycap>
        </button>
        <button
          type="button"
          className="sf-btn sf-btn--secondary w-full"
          onClick={onOpenWorkshop}
        >
          Open in Workshop
        </button>
      </div>
    </InspectorShell>
  );
}
