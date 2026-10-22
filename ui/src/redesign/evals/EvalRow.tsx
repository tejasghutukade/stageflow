import { LuChevronRight, LuPlay } from "react-icons/lu";
import type { EvalRowModel, EvalTone, TrendDot } from "./evalListModel";

const MONO = "font-['Geist_Mono',monospace]";

export const TONE_COLOR: Record<EvalTone | "empty", string> = {
  ok: "var(--sf-ok)",
  needs: "var(--sf-needs)",
  fail: "var(--sf-fail)",
  muted: "var(--sf-text-3)",
  empty: "var(--sf-track-empty)",
};

export const COLUMN = {
  target: "w-[250px]",
  dataset: "w-[190px]",
  lastRun: "w-[150px]",
  trend: "w-[110px]",
  cost: "w-[72px]",
  status: "w-[104px]",
} as const;

function TrendDots({ dots }: { dots: TrendDot[] }) {
  return (
    <span className="flex items-center gap-[3px]" aria-label="Last runs, oldest to newest">
      {dots.map((dot, index) => (
        <span
          key={index}
          title={dot.title || undefined}
          className="block h-[14px] w-[7px] rounded-[2px]"
          style={{ background: TONE_COLOR[dot.tone] }}
        />
      ))}
    </span>
  );
}

export function EvalRow({
  row,
  selected,
  onSelect,
  onOpen,
  onRun,
}: {
  row: EvalRowModel;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onRun: () => void;
}) {
  return (
    <div
      role="row"
      aria-selected={selected}
      data-eval-id={row.id}
      onMouseEnter={onSelect}
      onClick={onOpen}
      className={`flex w-full cursor-pointer items-center gap-4 border-b border-b-[var(--sf-hairline)] px-4 py-3 last:border-b-0 ${
        selected ? "bg-[var(--sf-active)]" : ""
      }`}
    >
      <div role="cell" className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--sf-text-1)]">{row.name}</p>
        {row.description ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-[1.4] text-[var(--sf-text-3)]">{row.description}</p>
        ) : null}
      </div>
      <div role="cell" className={`${COLUMN.target} shrink-0 min-w-0`}>
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-sm border border-[var(--sf-hairline-strong)] bg-[var(--sf-raised)] px-1.5 text-[11px] text-[var(--sf-text-2)]">
            {row.targetKind}
          </span>
          <span className={`${MONO} truncate text-xs text-[var(--sf-text-1)]`}>{row.targetLabel}</span>
        </div>
        {row.targetPath ? (
          <p className={`${MONO} mt-1 truncate text-[11px] text-[var(--sf-text-3)]`}>{row.targetPath}</p>
        ) : null}
      </div>
      <div role="cell" className={`${COLUMN.dataset} shrink-0 min-w-0`}>
        <p className={`${MONO} truncate text-xs text-[var(--sf-text-1)]`}>{row.datasetName}</p>
        <p className="mt-0.5 text-xs leading-[1.4] text-[var(--sf-text-3)]">{row.datasetMeta}</p>
      </div>
      <div role="cell" className={`${COLUMN.lastRun} shrink-0`}>
        {row.hasRun ? (
          <>
            <p className="flex items-baseline gap-2">
              <span className={`${MONO} text-sm font-medium`} style={{ color: TONE_COLOR[row.rateTone] }}>
                {row.rateText}
              </span>
              {row.deltaText ? (
                <span className={`${MONO} text-[11px]`} style={{ color: TONE_COLOR[row.deltaTone] }}>
                  {row.deltaText}
                </span>
              ) : null}
            </p>
            <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-[var(--sf-track-empty)]">
              <span
                className="block h-full rounded-full"
                style={{ width: `${row.barPercent}%`, background: TONE_COLOR[row.rateTone] }}
              />
            </span>
          </>
        ) : (
          <>
            <p className={`${MONO} text-xs text-[var(--sf-text-3)]`}>— Not run yet</p>
            <span className="mt-1.5 block h-1 w-full rounded-full bg-[var(--sf-track-empty)]" />
          </>
        )}
      </div>
      <div role="cell" className={`${COLUMN.trend} shrink-0`}>
        <TrendDots dots={row.trend} />
      </div>
      <div role="cell" className={`${COLUMN.cost} ${MONO} shrink-0 text-xs text-[var(--sf-text-2)]`}>
        {row.costText}
      </div>
      <div role="cell" className={`${COLUMN.status} flex shrink-0 items-center gap-2`}>
        <span className="block size-1.5 shrink-0 rounded-full" style={{ background: TONE_COLOR[row.status.tone] }} />
        <span className="whitespace-nowrap text-[13px] text-[var(--sf-text-1)]">{row.status.label}</span>
      </div>
      <span className="block w-[52px] shrink-0">
        {row.canRun ? (
          <button
            type="button"
            aria-label={`Run ${row.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--sf-hairline-strong)] px-2 text-xs font-medium text-[var(--sf-text-1)]"
          >
            <LuPlay className="size-3" aria-hidden />
            Run
          </button>
        ) : null}
      </span>
      <LuChevronRight className="size-3.5 shrink-0 text-[var(--sf-text-3)]" aria-hidden />
    </div>
  );
}
