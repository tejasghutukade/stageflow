import { useMemo } from "react";
import type { RunStatus, RunSummary } from "../../api";
import { runShortId } from "../../catalogJoin";
import { navigate, runStreamPath } from "../../routes";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRunStatus } from "../statusSignal";
import {
  mergeEditorHistory,
  type EditorHistorySessionEvent,
} from "./pipelineEditorModel";

function historyClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function isPillStatus(status: string): status is RunStatus {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "created" ||
    status === "queued" ||
    status === "running"
  );
}

export function PipelineEditorHistory({
  events,
  runs,
  loading,
}: {
  events: readonly EditorHistorySessionEvent[];
  runs: readonly RunSummary[];
  loading: boolean;
}) {
  const groups = useMemo(
    () => mergeEditorHistory({ events, runs }),
    [events, runs],
  );

  return (
    <div
      role="tabpanel"
      aria-label="History"
      className="flex min-h-0 flex-1 flex-col"
    >
      <p className="px-5 pt-4 text-[12px] text-[var(--sf-text-3)]">
        Not git history
      </p>
      {groups.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-[var(--sf-text-3)]">
          {loading ? "Loading runs…" : "No history"}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-4">
          {groups.map((group) => (
            <section key={group.day}>
              <h2 className="px-5 pb-1 pt-4 text-[11px] uppercase tracking-[0.04em] text-[var(--sf-text-3)]">
                {group.label}
              </h2>
              {group.entries.map((entry) => {
                if (entry.source === "run") {
                  const href = `#${runStreamPath(entry.runId)}`;
                  return (
                    <a
                      key={entry.id}
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(runStreamPath(entry.runId));
                      }}
                      className="flex h-11 items-center gap-4 border-b border-b-[#ffffff12] px-5 text-[13px] hover:bg-[var(--sf-raised)]"
                    >
                      <span className="w-12 shrink-0 font-['Geist_Mono',monospace] text-[var(--sf-text-3)]">
                        {historyClock(entry.at)}
                      </span>
                      <span
                        className="w-28 shrink-0 truncate font-['Geist_Mono',monospace] text-[var(--sf-text-1)]"
                        title={entry.runId}
                      >
                        {runShortId(entry.runId)}
                      </span>
                      <span className="min-w-0 flex-1 text-[var(--sf-text-2)]">
                        Run finished
                      </span>
                      {isPillStatus(entry.status) ? (
                        <StatusPill
                          signal={statusSignalFromRunStatus(entry.status)}
                          label={runStatusPillLabel(entry.status)}
                        />
                      ) : (
                        <span className="text-[var(--sf-text-3)]">{entry.status}</span>
                      )}
                    </a>
                  );
                }
                return (
                  <div
                    key={entry.id}
                    className="flex h-11 items-center gap-4 border-b border-b-[#ffffff12] px-5 text-[13px]"
                  >
                    <span className="w-12 shrink-0 font-['Geist_Mono',monospace] text-[var(--sf-text-3)]">
                      {historyClock(entry.at)}
                    </span>
                    <span className="shrink-0 text-[var(--sf-text-1)]">
                      {entry.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--sf-text-2)]">
                      {entry.detail ?? ""}
                    </span>
                    <span className="shrink-0 rounded-[5px] border border-[#ffffff1a] bg-[var(--sf-raised)] px-1.5 py-0.5 text-[11px] text-[var(--sf-text-2)]">
                      This session
                    </span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
