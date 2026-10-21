import { useEffect, useMemo, useRef, useState } from "react";
import { LuSearch } from "react-icons/lu";
import type { EvalListItem } from "../../../api/evalTypes";
import { INPUT } from "../datasets/DialogShell";
import { MONO, SELECT } from "./parts";
import { evalCountFor, filterStageRows, sameTarget, type StageRow, type WizardTarget } from "./wizardModel";

type Props = {
  rows: StageRow[];
  evals: EvalListItem[];
  loading: boolean;
  error: string | null;
  target: WizardTarget | null;
  onPick: (row: StageRow, pipelinePath?: string) => void;
  listClass?: string;
};

/** The wizard's stage list: search, one row per stage, a pipeline choice for stages used by several. */
export function StagePicker({ rows: allRows, evals, loading, error, target: t, onPick, listClass = "max-h-[260px]" }: Props) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => filterStageRows(allRows, query), [allRows, query]);
  const targetKey = `${t?.projectRoot ?? ""}|${t?.pipelinePath ?? t?.file ?? ""}|${t?.stageId ?? ""}`;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [targetKey, loading]);

  return (
    <>
      <div className="relative">
        <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--sf-text-3)]" aria-hidden />
        <input className={`${INPUT} pl-8`} placeholder="Search stages by id, model or pipeline" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search stages" />
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--sf-fail)]">{error}</p> : null}
      <div ref={listRef} className={`${listClass} overflow-y-auto rounded-lg border border-[var(--sf-hairline)]`} role="radiogroup" aria-label="Stages">
        {loading ? <p className="p-3 text-xs text-[var(--sf-text-3)]">Loading stages…</p> : null}
        {!loading && rows.length === 0 ? <p className="p-3 text-xs text-[var(--sf-text-3)]">No stages match.</p> : null}
        {rows.map((row) => {
          const active = sameTarget(row, t);
          const count = evalCountFor(row, evals);
          return (
            <div key={row.key} className={`border-b border-b-[var(--sf-hairline)] last:border-b-0 ${active ? "bg-[var(--sf-raised)]" : ""}`}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={row.readOnly}
                title={row.readOnly ? "Read-only catalog. Copy the pipeline into your project to evaluate it." : undefined}
                onClick={() => onPick(row)}
                className="grid w-full grid-cols-[18px_150px_minmax(0,1fr)_minmax(0,1fr)_70px] items-center gap-3 px-3 py-2.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className={`size-3.5 rounded-full border ${active ? "border-[var(--sf-text-1)] bg-[var(--sf-text-1)]" : "border-[var(--sf-hairline-strong)]"}`} />
                <span className={`${MONO} truncate text-[var(--sf-text-1)]`}>{row.stageId}</span>
                <span className={`${MONO} truncate text-xs text-[var(--sf-text-2)]`}>{row.model ?? ""}</span>
                <span className={`${MONO} truncate text-xs text-[var(--sf-text-3)]`}>{row.pipelines.map((p) => p.id).join(", ")}</span>
                <span className="text-right text-xs text-[var(--sf-text-3)]">{count} {count === 1 ? "eval" : "evals"}</span>
              </button>
              {active && row.pipelines.length > 1 && t?.kind === "pipeline" ? (
                <div className="flex items-center gap-2 px-10 pb-2.5 text-xs text-[var(--sf-text-3)]">
                  Evaluate it as part of
                  <select className={`${SELECT} h-7 w-auto`} value={t.pipelinePath} onChange={(e) => onPick(row, e.target.value)} aria-label="Pipeline">
                    {row.pipelines.map((p) => (
                      <option key={p.path} value={p.path}>{p.id}</option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
