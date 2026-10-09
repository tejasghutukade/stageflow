import { LuFolderOpen, LuMessageSquare } from "react-icons/lu";
import type { WorkshopSessionSummary } from "../../../api";
import type { StudioPickerRow } from "../../../pages/workshopStudio";
import { historyBuildName, pickerRowValue } from "../../../pages/workshopStudio";

export type WorkshopHistoryPopoverProps = {
  sessions: readonly WorkshopSessionSummary[];
  activeSessionId?: string | null;
  loading?: boolean;
  error?: string | null;
  pickerRows: readonly StudioPickerRow[];
  selectedBuildId?: string | null;
  onOpenSession: (id: string) => void;
  onPickRow: (row: StudioPickerRow) => void;
};

const MONO = "font-['Geist_Mono',monospace]";
const HEADING =
  "px-3 pb-1.5 pt-3 text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98]";

function whenLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function WorkshopHistoryPopover({
  sessions,
  activeSessionId,
  loading,
  error,
  pickerRows,
  selectedBuildId,
  onOpenSession,
  onPickRow,
}: WorkshopHistoryPopoverProps) {
  return (
    <div
      role="dialog"
      aria-label="Workshop history"
      className="absolute left-3 right-3 top-[48px] z-30 flex max-h-[min(480px,70vh)] flex-col overflow-auto rounded-[10px] border border-[#ffffff1a] bg-[#131418] pb-1.5 shadow-[0px_12px_32px_rgba(0,0,0,0.45)]"
    >
      <div className={HEADING}>Sessions</div>
      {loading ? (
        <div className="px-3 py-1.5 text-xs text-[#8b8f98]">Loading sessions…</div>
      ) : error ? (
        <div className="px-3 py-1.5 text-xs text-[#f2645a]">{error}</div>
      ) : sessions.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-[#8b8f98]">No prior sessions yet.</div>
      ) : (
        <div className="flex flex-col px-1.5">
          {sessions.map((session) => {
            const active = session.id === activeSessionId;
            const build = historyBuildName(session.activeBuildId, pickerRows);
            const meta = [build, whenLabel(session.updatedAt)].filter(Boolean).join(" · ");
            return (
              <button
                key={session.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onOpenSession(session.id)}
                className={`flex min-w-0 items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[#1a1c21] ${active ? "bg-[#1a1c21]" : ""}`}
              >
                <LuMessageSquare aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[#8b8f98]" />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13px] leading-normal text-[#ecedee]">
                    {session.title.trim() || "Untitled session"}
                  </span>
                  {meta ? (
                    <span className={`truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
                      {meta}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className={`${HEADING} mt-1 border-t border-t-[#ffffff12]`}>Open existing pipeline…</div>
      {pickerRows.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-[#8b8f98]">No pipelines in the catalog yet.</div>
      ) : (
        <div className="flex flex-col px-1.5">
          {pickerRows.map((row) => {
            const active = row.id != null && row.id === selectedBuildId;
            return (
              <button
                key={pickerRowValue(row)}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onPickRow(row)}
                className={`flex min-w-0 items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[#1a1c21] ${active ? "bg-[#1a1c21]" : ""}`}
              >
                <LuFolderOpen aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[#8b8f98]" />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className={`truncate ${MONO} text-xs leading-normal text-[#ecedee]`}>
                    {row.name}
                  </span>
                  {row.relativePath ? (
                    <span className={`truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
                      {row.relativePath}
                    </span>
                  ) : row.id ? (
                    <span className={`truncate ${MONO} text-[11px] leading-normal text-[#8b8f98]`}>
                      workshop build
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
