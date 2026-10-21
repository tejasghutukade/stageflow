import { LuChevronRight, LuTag } from "react-icons/lu";
import type { EvalResultRow, EvalRunDetail } from "../../../api/evalTypes";
import { CaseRowsTable } from "./CaseRowsTable";
import { byGraderHeader, byGraderView, failingCardHeader, failingCaseRows, failureTypesModel, flakyNote, FAILURE_TYPES_HINT, histogramModel, kpiTiles } from "./overviewModel";
import { Bar, Card, KindChip, MONO_CLASS, TONE_BG, TONE_TEXT } from "./ResultsParts";

export function OverviewTab({
  run,
  rows,
  previousRun,
  onOpenCase,
  onTag,
  onAllCases,
}: {
  run: EvalRunDetail;
  rows: EvalResultRow[];
  previousRun: number | null;
  onOpenCase: (caseId: string) => void;
  onTag: (tag: string) => void;
  onAllCases: () => void;
}) {
  if (!run.stats) {
    return <p className="px-5 py-4 text-[13px] text-[var(--sf-text-2)]">No results were executed in this run.</p>;
  }
  const tiles = kpiTiles(run);
  const graderHeader = byGraderHeader(previousRun);
  const graders = byGraderView(run);
  const histogram = histogramModel(run);
  const flaky = flakyNote(run);
  const failure = failureTypesModel(run);
  const failing = failingCaseRows(run, rows);
  const failingHeader = failingCardHeader(run);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div
        className="grid overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
      >
        {tiles.map((tile, i) => (
          <div key={tile.id} className={`flex flex-col gap-1.5 p-4 ${i > 0 ? "border-l border-[var(--sf-hairline)]" : ""}`}>
            <span className="text-xs text-[var(--sf-text-2)]">{tile.label}</span>
            <span className={`text-[28px] font-semibold leading-none ${MONO_CLASS} ${tile.tone === "muted" ? "text-[var(--sf-text-1)]" : TONE_TEXT[tile.tone]}`}>
              {tile.value}
            </span>
            {tile.sub ? <span className="text-xs text-[var(--sf-text-3)]">{tile.sub}</span> : null}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="By grader" right={graderHeader.subtitle}>
          <div className="grid grid-cols-[minmax(160px,1.4fr)_minmax(120px,1fr)_70px_70px_100px] gap-3 px-4 py-2 text-xs text-[var(--sf-text-3)]">
            {graderHeader.columns.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          {graders.map((g) => (
            <div
              key={g.id}
              className="grid grid-cols-[minmax(160px,1.4fr)_minmax(120px,1fr)_70px_70px_100px] items-center gap-3 border-t border-[var(--sf-hairline)] px-4 py-2.5 text-[13px]"
            >
              <span className="flex items-center gap-2">
                <KindChip kind={g.kind} />
                <span className={`${MONO_CLASS} truncate text-[var(--sf-text-1)]`}>{g.id}</span>
              </span>
              <span className="flex items-center gap-2">
                <Bar fraction={g.barFraction} tone={g.barTone} />
                <span className={`${MONO_CLASS} w-10 text-right ${TONE_TEXT[g.barTone]}`}>{g.passText}</span>
              </span>
              <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{g.meanText}</span>
              <span className={`${MONO_CLASS} text-[var(--sf-text-2)]`}>{g.rangeText}</span>
              <span className={`${MONO_CLASS} text-xs ${TONE_TEXT[g.delta.tone]}`}>{g.delta.text}</span>
            </div>
          ))}
        </Card>

        {histogram ? (
          <Card title="Score per result" right={histogram.totalText}>
            <div className="flex flex-col gap-3 p-4">
              <div className="relative flex h-32 items-end gap-1.5">
                {histogram.bars.map((bar) => (
                  <div key={bar.index} className="flex h-full flex-1 items-end" title={bar.label}>
                    <div className={`w-full rounded-sm ${TONE_BG[bar.tone]}`} style={{ height: `${bar.heightPercent}%` }} />
                  </div>
                ))}
                <div
                  className="pointer-events-none absolute inset-y-0 border-l border-dashed border-[var(--sf-text-3)]"
                  style={{ left: `${histogram.thresholdPercent}%` }}
                />
              </div>
              <div className={`relative flex justify-between text-[11px] text-[var(--sf-text-3)] ${MONO_CLASS}`}>
                <span>0.0</span>
                <span className="text-[var(--sf-needs)]">{histogram.thresholdLabel}</span>
                <span>1.0</span>
              </div>
              {flaky ? (
                <div className="rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] p-3 text-xs">
                  <p className="font-medium text-[var(--sf-text-1)]">{flaky.title}</p>
                  <p className="mt-1 text-[var(--sf-text-2)]">{flaky.body}</p>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>

      {failure ? (
        <Card title="Failure types" addon={failure.failedText} right={FAILURE_TYPES_HINT}>
          {failure.emptyText ? <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">{failure.emptyText}</p> : null}
          {failure.rows.map((row) => {
            const inner = (
              <>
                <span className="flex items-center gap-2 text-[var(--sf-text-1)]">
                  <LuTag className="size-3.5 text-[var(--sf-text-3)]" aria-hidden />
                  <span className={row.tag === null ? "text-[var(--sf-text-2)]" : ""}>{row.label}</span>
                </span>
                <Bar fraction={row.fraction} tone={row.tag === null ? "muted" : "fail"} />
                <span className={`${MONO_CLASS} text-right text-[var(--sf-text-1)]`}>{row.count}</span>
              </>
            );
            const cls =
              "grid grid-cols-[minmax(180px,1fr)_2fr_40px] items-center gap-4 border-t border-[var(--sf-hairline)] px-4 py-2.5 text-left text-[13px] first:border-t-0";
            return row.tag === null ? (
              <div key={row.key} className={cls}>
                {inner}
              </div>
            ) : (
              <button key={row.key} type="button" className={`${cls} hover:bg-[var(--sf-active)]`} onClick={() => onTag(row.tag!)}>
                {inner}
              </button>
            );
          })}
        </Card>
      ) : null}

      <Card
        title="Failing and flaky cases"
        addon={failingHeader.shownText}
        right={
          <button type="button" className="flex items-center gap-1 text-[var(--sf-text-1)]" onClick={onAllCases}>
            {failingHeader.allText}
            <LuChevronRight className="size-3.5" aria-hidden />
          </button>
        }
      >
        {failing.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">No failing cases.</p>
        ) : (
          <CaseRowsTable rows={failing} onOpen={onOpenCase} />
        )}
      </Card>
    </div>
  );
}
