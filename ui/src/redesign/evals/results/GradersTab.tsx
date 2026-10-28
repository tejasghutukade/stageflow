import { useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import type { EvalRunDetail } from "../../../api/evalTypes";
import { graderRows, judgeSummary, lowestCases } from "./gradersModel";
import { CalibrationPanel } from "./CalibrationPanel";
import { Bar, KindChip, MONO_CLASS, TONE_TEXT } from "./ResultsParts";
import { useRunExport } from "./useResultsData";

export function GradersTab({
  run,
  onOpenCase,
  onShowFailing,
}: {
  run: EvalRunDetail;
  onOpenCase: (caseId: string, repeat: number) => void;
  onShowFailing: (graderId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const exported = useRunExport(run.eval_run_id, open !== null);
  const rows = graderRows(run);

  if (rows.length === 0) return <p className="px-5 py-4 text-[13px] text-[var(--sf-text-2)]">No graders in this run.</p>;

  return (
    <div className="px-5 py-4">
      <div className="overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)]">
        {rows.map((row, i) => {
          const expanded = open === row.id;
          const results = exported.data?.results ?? [];
          const judge = expanded && row.isRubric ? judgeSummary(results, row.id) : null;
          return (
            <div key={row.id} className={i > 0 ? "border-t border-[var(--sf-hairline)]" : ""}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : row.id)}
                className="grid w-full grid-cols-[20px_minmax(220px,1.6fr)_90px_minmax(140px,1fr)_60px_70px_60px_100px] items-center gap-3 px-4 py-3 text-left text-[13px] hover:bg-[var(--sf-active)]"
              >
                {expanded ? <LuChevronDown className="size-4" aria-hidden /> : <LuChevronRight className="size-4" aria-hidden />}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <KindChip kind={row.kind} />
                    <span className={`${MONO_CLASS} truncate text-[var(--sf-text-1)]`}>{row.id}</span>
                  </span>
                  {row.description ? <span className="truncate text-xs text-[var(--sf-text-3)]">{row.description}</span> : null}
                </span>
                <span className={`${MONO_CLASS} text-xs text-[var(--sf-text-2)]`}>{row.weightText}</span>
                <span className="flex items-center gap-2">
                  <Bar fraction={row.barFraction} tone={row.barTone} />
                  <span className={`${MONO_CLASS} w-10 text-right ${TONE_TEXT[row.barTone]}`}>{row.passText}</span>
                </span>
                <span className={MONO_CLASS}>{row.meanText}</span>
                <span className={`${MONO_CLASS} text-[var(--sf-text-2)]`}>{row.rangeText}</span>
                <span className={`${MONO_CLASS} ${row.errors > 0 ? "text-[var(--sf-fail)]" : "text-[var(--sf-text-3)]"}`}>
                  {row.errorsText} err
                </span>
                <span className={`${MONO_CLASS} text-xs ${TONE_TEXT[row.delta.tone]}`}>{row.delta.text}</span>
              </button>
              {expanded ? (
                <div className="flex flex-col gap-3 border-t border-[var(--sf-hairline)] bg-[var(--sf-ground)] px-10 py-3 text-[13px]">
                  <div className="flex flex-col gap-1 text-[var(--sf-text-2)]">
                    {row.summary.map((line, idx) => (
                      <p key={idx} className={row.type === "code" || row.type === "field" ? MONO_CLASS : ""}>
                        {line}
                      </p>
                    ))}
                  </div>
                  {row.isRubric ? (
                    <CalibrationPanel
                      evalId={run.eval_id}
                      graderId={row.id}
                      graderHash={run.current?.grader_hashes?.[row.id] ?? null}
                      judge={null}
                      onOpenCase={onOpenCase}
                    />
                  ) : null}
                  {judge ? (
                    <p className="text-xs text-[var(--sf-text-3)]">
                      Judge {judge.model} · {judge.tokensText} · {judge.costText}
                    </p>
                  ) : null}
                  <div>
                    <p className="mb-1 text-xs text-[var(--sf-text-3)]">Lowest-scoring cases</p>
                    {exported.loading ? <p className="text-xs text-[var(--sf-text-3)]">Loading…</p> : null}
                    {exported.error ? <p className="text-xs text-[var(--sf-fail)]">{exported.error}</p> : null}
                    {exported.data
                      ? lowestCases(results, row.id, run.lowest_cases_by_grader?.[row.id]).map((c) => (
                          <button
                            key={c.caseId}
                            type="button"
                            onClick={() => onOpenCase(c.caseId, c.repeatIndex)}
                            className="flex w-full items-baseline gap-3 py-1 text-left hover:text-[var(--sf-text-1)]"
                          >
                            <span className={`${MONO_CLASS} text-[var(--sf-text-1)]`}>{c.caseId}</span>
                            <span className={`${MONO_CLASS} text-[var(--sf-fail)]`}>{c.scoreText}</span>
                            <span className="truncate text-xs text-[var(--sf-text-3)]">{c.reason ?? ""}</span>
                          </button>
                        ))
                      : null}
                  </div>
                  <button
                    type="button"
                    className="self-start text-xs text-[var(--sf-text-1)] underline"
                    onClick={() => onShowFailing(row.id)}
                  >
                    Show all failing cases
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
