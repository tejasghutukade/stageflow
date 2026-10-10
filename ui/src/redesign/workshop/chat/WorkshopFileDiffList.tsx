import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import type { WorkshopChatProposalPayload } from "../../../api";
import { changeFileRows, type ChangeFileRow } from "./changeCardModel";
import type { DiffDisplayRow } from "./lineDiff";

export type WorkshopFileDiffListProps = {
  artifacts: WorkshopChatProposalPayload["artifacts"];
  defaultExpandedPath?: string;
};

const MONO = "font-['Geist_Mono',monospace]";

function DiffRow({ row }: { row: DiffDisplayRow }) {
  if (row.kind === "skip") {
    return (
      <div className={`flex h-[18px] items-center gap-2.5 px-3 ${MONO} text-[11px] text-[#8b8f98]`}>
        <span className="min-w-4 text-right">⋯</span>
        <span>
          {row.count} unchanged line{row.count === 1 ? "" : "s"}
        </span>
      </div>
    );
  }
  const tone =
    row.kind === "added"
      ? { bg: "bg-[#4cc38a14]", gutter: "text-[#4cc38a]", text: "text-[#ecedee]", mark: "+" }
      : row.kind === "removed"
        ? { bg: "bg-[#f2645a14]", gutter: "text-[#f2645a]", text: "text-[#ecedee]", mark: "−" }
        : { bg: "", gutter: "text-[#8b8f98]", text: "text-[#a7aab2]", mark: String(row.newLine ?? "") };
  return (
    <div className={`flex h-[18px] min-w-fit items-center gap-2.5 px-3 ${tone.bg}`}>
      <span className={`min-w-4 shrink-0 text-right ${MONO} text-[11px] leading-normal ${tone.gutter}`}>
        {tone.mark}
      </span>
      <span
        className={`${MONO} text-[11px] leading-normal ${tone.text} whitespace-pre`}
      >
        {row.text}
      </span>
    </div>
  );
}

export function WorkshopMiniDiff({ rows }: { rows: readonly DiffDisplayRow[] }) {
  if (rows.length === 0) {
    return (
      <div className={`border-y border-y-[#ffffff0f] bg-[#0c0d0f] px-3 py-1.5 ${MONO} text-[11px] text-[#8b8f98]`}>
        No line changes
      </div>
    );
  }
  return (
    <div className="max-h-[240px] overflow-auto border-y border-y-[#ffffff0f] bg-[#0c0d0f] py-1.5">
      {rows.map((row, index) => (
        <DiffRow key={index} row={row} />
      ))}
    </div>
  );
}

function FileTag({ kind }: { kind: ChangeFileRow["kind"] }) {
  if (kind === "added") {
    return (
      <span className={`flex h-4 shrink-0 items-center rounded-sm bg-[#6ca6ff1f] px-[5px] ${MONO} text-[10px] font-medium text-[#6ca6ff]`}>
        NEW
      </span>
    );
  }
  if (kind === "removed") {
    return (
      <span className={`flex h-4 shrink-0 items-center rounded-sm bg-[#f2645a1f] px-[5px] ${MONO} text-[10px] font-medium text-[#f2645a]`}>
        DELETED
      </span>
    );
  }
  return null;
}

export function WorkshopFileDiffList({
  artifacts,
  defaultExpandedPath,
}: WorkshopFileDiffListProps) {
  const rows = useMemo(() => changeFileRows(artifacts), [artifacts]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpandedPath ? [defaultExpandedPath] : []),
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (rows.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col">
      {rows.map((row) => {
        const open = expanded.has(row.path);
        const { added, removed } = row.diff.totals;
        const Chevron = open ? LuChevronDown : LuChevronRight;
        return (
          <div key={row.path} className="flex min-w-0 flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(row.path)}
              className={`flex h-[30px] w-full min-w-0 items-center gap-2 px-3 text-left hover:bg-[#1a1c21] ${open ? "bg-[#1a1c21]" : ""}`}
            >
              <Chevron
                aria-hidden
                className={`size-3 shrink-0 ${open ? "text-[#ecedee]" : "text-[#8b8f98]"}`}
              />
              <span
                title={row.path}
                className={`min-w-0 flex-1 truncate ${MONO} text-xs leading-normal text-[#ecedee]`}
              >
                {row.path}
              </span>
              <FileTag kind={row.kind} />
              <span
                className={`min-w-7 shrink-0 text-right ${MONO} text-[11px] leading-normal ${added > 0 ? "text-[#4cc38a]" : "text-[#8b8f98]"}`}
              >
                {added > 0 ? `+${added}` : "0"}
              </span>
              <span
                className={`min-w-5 shrink-0 text-right ${MONO} text-[11px] leading-normal ${removed > 0 ? "text-[#f2645a]" : "text-[#8b8f98]"}`}
              >
                {removed > 0 ? `−${removed}` : "0"}
              </span>
            </button>
            {open ? <WorkshopMiniDiff rows={row.diff.rows} /> : null}
          </div>
        );
      })}
    </div>
  );
}
