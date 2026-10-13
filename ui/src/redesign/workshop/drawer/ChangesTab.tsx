import { useMemo, useState } from "react";
import { LuCheck, LuChevronRight, LuTriangleAlert, LuX } from "react-icons/lu";
import { WorkshopFileDiffList } from "../chat/WorkshopFileDiffList";
import { formatAgo, useNow } from "../relativeTime";
import {
  changeRows,
  changeStatusLabel,
  type ChangeRowStatus,
  type WorkshopMutationCard,
} from "./drawerModel";

export type ChangesTabProps = {
  mutationCards: ReadonlyMap<string, WorkshopMutationCard>;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
};

const MONO = "font-['Geist_Mono',monospace]";

function StatusIcon({ status }: { status: ChangeRowStatus }) {
  const label = changeStatusLabel(status);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" title={label} aria-label={label}>
      {status === "pending" ? (
        <span className="block size-2 rounded-full bg-[#6ca6ff]" />
      ) : status === "accepted" || status === "auto" ? (
        <LuCheck className="size-3.5 text-[#4cc38a]" aria-hidden />
      ) : status === "conflict" ? (
        <LuTriangleAlert className="size-3.5 text-[#f5b544]" aria-hidden />
      ) : (
        <LuX className="size-3.5 text-[#8b8f98]" aria-hidden />
      )}
    </span>
  );
}

export function ChangesTab({ mutationCards, onAccept, onReject }: ChangesTabProps) {
  const rows = useMemo(() => changeRows(mutationCards), [mutationCards]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const now = useNow(10000, rows.some((row) => row.at !== undefined));

  if (rows.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-6">
        <span className="font-sans text-[13px] font-medium text-[#ecedee]">No changes yet</span>
        <span className="text-center font-sans text-xs leading-[1.45] text-[#8b8f98]">
          Edits the agent makes to the draft show up here, applied or pending.
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col py-1.5">
      {rows.map((row) => {
        const expanded = row.id === expandedId;
        const muted = row.status === "rejected";
        return (
          <div key={row.id} className="flex w-full flex-col">
            <div
              className={`flex h-[30px] w-full items-center gap-2.5 border-l-2 pr-3.5 ${
                expanded ? "border-l-[#6ca6ff] bg-[#ffffff08]" : "border-l-transparent hover:bg-[#ffffff05]"
              }`}
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : row.id)}
                className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-3 text-left"
              >
                <LuChevronRight
                  className={`size-3 shrink-0 text-[#8b8f98] transition-transform ${expanded ? "rotate-90" : ""}`}
                  aria-hidden
                />
                <StatusIcon status={row.status} />
                {row.status === "auto" ? (
                  <span
                    className={`shrink-0 rounded-sm border border-[#ffffff1a] px-1 ${MONO} text-[10px] text-[#a7aab2]`}
                  >
                    auto
                  </span>
                ) : null}
                <span
                  className={`min-w-0 flex-1 truncate font-sans text-[13px] ${
                    muted ? "text-[#8b8f98] line-through decoration-[#8b8f98]" : "text-[#ecedee]"
                  }`}
                  title={row.summary}
                >
                  {row.summary}
                </span>
                <span className={`shrink-0 ${MONO} text-[11px] text-[#8b8f98]`}>{row.filesLabel}</span>
                <span className={`flex shrink-0 items-center gap-1.5 ${MONO} text-[11px]`}>
                  <span className={muted ? "text-[#8b8f98]" : "text-[#4cc38a]"}>+{row.added}</span>
                  <span className={muted ? "text-[#8b8f98]" : "text-[#f2645a]"}>−{row.removed}</span>
                </span>
                <span className={`w-14 shrink-0 text-right ${MONO} text-[11px] text-[#8b8f98]`}>
                  {row.at !== undefined ? formatAgo(row.at, now) : ""}
                </span>
              </button>
              {row.status === "pending" ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onAccept(row.id)}
                    className="flex h-[22px] items-center rounded-md bg-[#ecedee] px-2 font-sans text-xs font-medium text-[#0c0d0f] hover:bg-white"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => onReject(row.id)}
                    className="flex h-[22px] items-center rounded-md px-1.5 font-sans text-xs font-medium text-[#a7aab2] hover:bg-[#ffffff0a] hover:text-[#ecedee]"
                  >
                    Reject
                  </button>
                </div>
              ) : null}
            </div>
            {expanded ? (
              <div className="flex flex-col gap-2 border-l-2 border-l-[#6ca6ff] bg-[#ffffff05] py-2 pl-[38px] pr-3.5">
                {row.notice ? (
                  <span className="font-sans text-xs text-[#f5b544]">{row.notice}</span>
                ) : null}
                <WorkshopFileDiffList artifacts={row.artifacts} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
