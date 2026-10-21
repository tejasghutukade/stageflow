import { LuChevronRight } from "react-icons/lu";
import type { CaseRowView } from "./casesModel";
import { Dots, MONO_CLASS, TONE_TEXT } from "./ResultsParts";

const GRID = "grid grid-cols-[56px_minmax(160px,1.4fr)_90px_60px_minmax(160px,1.2fr)_70px_70px_24px] items-center gap-3 px-4";

export function CaseRowsTable({
  rows,
  onOpen,
}: {
  rows: CaseRowView[];
  onOpen: (caseId: string) => void;
}) {
  return (
    <div role="table">
      <div role="row" className={`${GRID} h-9 text-xs text-[var(--sf-text-3)]`}>
        <span>Case</span>
        <span>Input</span>
        <span>Repeats</span>
        <span>Score</span>
        <span>Failed graders</span>
        <span>Time</span>
        <span>Cost</span>
        <span />
      </div>
      {rows.map((row) => (
        <button
          key={row.caseId}
          type="button"
          role="row"
          onClick={() => onOpen(row.caseId)}
          className={`${GRID} h-10 w-full border-t border-[var(--sf-hairline)] text-left text-[13px] hover:bg-[var(--sf-active)]`}
        >
          <span className={`${MONO_CLASS} text-[var(--sf-text-2)]`}>{row.position}</span>
          <span className="truncate text-[var(--sf-text-1)]">{row.title}</span>
          <Dots dots={row.dots} />
          <span className={`${MONO_CLASS} ${TONE_TEXT[row.scoreTone]}`}>{row.scoreText}</span>
          <span className={`${MONO_CLASS} truncate text-xs text-[var(--sf-text-2)]`}>{row.failedGraders}</span>
          <span className={`${MONO_CLASS} text-xs text-[var(--sf-text-2)]`}>{row.timeText}</span>
          <span className={`${MONO_CLASS} text-xs text-[var(--sf-text-2)]`}>{row.costText}</span>
          <LuChevronRight className="size-4 text-[var(--sf-text-3)]" aria-hidden />
        </button>
      ))}
    </div>
  );
}
