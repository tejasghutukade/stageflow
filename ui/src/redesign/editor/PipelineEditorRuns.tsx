import type { RunSummary } from "../../api";
import { runTaskLabel } from "../../catalog/displayCatalogPath";
import { relativeTime, runShortId } from "../../catalogJoin";
import { navigate, runStreamPath } from "../../routes";
import { formatRunDuration } from "../../runs/formatRunMetrics";
import { runDisplayStatus } from "../../status/runStatus";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";

const HEAD =
  "flex h-9 shrink-0 items-center gap-6 border-b border-b-[#ffffff12] px-5 text-[11px] uppercase tracking-[0.04em] text-[var(--sf-text-3)]";

export function PipelineEditorRuns({
  runs,
  loading,
  error,
}: {
  runs: readonly RunSummary[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <div
      role="tabpanel"
      aria-label="Runs"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className={HEAD}>
        <span className="w-28">Run</span>
        <span className="w-36">Status</span>
        <span className="min-w-0 flex-1">Task</span>
        <span className="w-28">Created</span>
        <span className="w-24 text-right">Duration</span>
      </div>
      {error ? (
        <p className="px-5 py-2 text-[13px] text-[var(--sf-fail)]">{error}</p>
      ) : null}
      {loading ? (
        <p className="px-5 py-6 text-[13px] text-[var(--sf-text-3)]">
          Loading runs…
        </p>
      ) : null}
      {!loading && runs.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-[var(--sf-text-3)]">No runs</p>
      ) : null}
      {!loading && runs.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {runs.map((run) => {
            const href = `#${runStreamPath(run.run_id)}`;
            return (
              <a
                key={run.run_id}
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(runStreamPath(run.run_id));
                }}
                className="flex h-11 items-center gap-6 border-b border-b-[#ffffff12] px-5 text-[13px] hover:bg-[var(--sf-raised)]"
              >
                <span
                  className="w-28 truncate font-['Geist_Mono',monospace] text-[var(--sf-text-1)]"
                  title={run.run_id}
                >
                  {runShortId(run.run_id)}
                </span>
                <span className="flex w-36">
                  <StatusPill
                    signal={statusSignalFromRun(run)}
                    label={runStatusPillLabel(runDisplayStatus(run))}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                  {runTaskLabel(run)}
                </span>
                <span className="w-28 truncate text-[var(--sf-text-3)]">
                  {relativeTime(run.created_at)}
                </span>
                <span className="w-24 text-right font-['Geist_Mono',monospace] text-[var(--sf-text-2)]">
                  {formatRunDuration(
                    run.created_at,
                    run.finished_at,
                    run.updated_at,
                  )}
                </span>
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
