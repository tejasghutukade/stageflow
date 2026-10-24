import { useEffect, useMemo, useState } from "react";
import { LuChevronRight, LuPlus } from "react-icons/lu";
import { fetchEvals, type EvalListItem, type PipelineListing } from "../../api";
import { navigate } from "../../routes";
import {
  STAGE_EVALS_EMPTY,
  buildStageEvalsModel,
  evaluateHref,
  stageEvalsQueries,
  newEvalHref,
  type StageEvalsModel,
} from "./stageEvalsModel";
import type { StageRowFromPipelines } from "./stagesFromPipelines";

const MONO = "[font-family:'Geist_Mono',_monospace]";
const LABEL =
  "font-sans text-[11px] font-medium uppercase leading-normal tracking-[0.88px] text-[#8b8f98] whitespace-nowrap";

export type StageEvalsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; model: StageEvalsModel };

export function useStageEvals(
  row: StageRowFromPipelines | null,
  pipelines: PipelineListing[],
): StageEvalsState {
  const [state, setState] = useState<StageEvalsState>({ status: "loading" });
  const queries = useMemo(() => (row ? stageEvalsQueries(row, pipelines) : []), [row, pipelines]);

  useEffect(() => {
    if (!row) return;
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all(
      queries.map(async (query) => ({
        query,
        items: (await fetchEvals(query.query)).items as EvalListItem[],
      })),
    ).then(
      (results) => {
        if (!cancelled)
          setState({ status: "ok", model: buildStageEvalsModel(row, pipelines, results, Date.now()) });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [row, pipelines, queries]);

  return state;
}

export function stageEvaluateTarget(row: StageRowFromPipelines, state: StageEvalsState): string {
  if (state.status === "ok") return state.model.evaluateHref;
  return evaluateHref(row, undefined, []);
}

export function StageEvalsSection({
  row,
  state,
}: {
  row: StageRowFromPipelines;
  state: StageEvalsState;
}) {
  const newHref = state.status === "ok" ? state.model.newEvalHref : newEvalHref(row, undefined);
  return (
    <div className="flex flex-col gap-1.5" data-testid="stage-evals">
      <div className="flex items-center gap-1.5">
        <span className={LABEL}>Evals</span>
        {state.status === "ok" ? (
          <span className={`${MONO} text-[11px] leading-normal text-[#a7aab2]`}>{state.model.total}</span>
        ) : null}
        <span className="block flex-1" />
        <button
          type="button"
          onClick={() => navigate(newHref)}
          className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[#a7aab2] hover:bg-[#1a1c21] hover:text-[#ecedee]"
        >
          <LuPlus className="size-3" aria-hidden />
          <span className="font-sans text-xs font-medium leading-normal">New eval</span>
        </button>
      </div>
      {state.status === "loading" ? (
        <span className="font-sans text-xs text-[#8b8f98]">Loading evals…</span>
      ) : state.status === "error" ? (
        <span className="font-sans text-xs text-[#f2645a]">Could not load evals.</span>
      ) : state.model.total === 0 ? (
        <span className="font-sans text-xs leading-[1.5] text-[#8b8f98]">{STAGE_EVALS_EMPTY}</span>
      ) : (
        <>
          <div className="flex flex-col rounded-[10px] border border-[#ffffff12]">
            {state.model.sections.map((section) => (
              <div key={section.key} className="flex flex-col">
                {state.model.sections.length > 1 || row.used_by_pipeline_ids.length > 1 ? (
                  <span
                    className={`border-b border-b-[#ffffff12] px-2.5 py-1 ${MONO} text-[11px] leading-normal text-[#8b8f98]`}
                  >
                    {section.label}
                  </span>
                ) : null}
                {section.rows.map((evalRow) => (
                  <button
                    key={evalRow.id}
                    type="button"
                    onClick={() => navigate(evalRow.href)}
                    className="flex min-h-10 w-full items-center gap-2.5 border-b border-b-[#ffffff12] px-2.5 py-1.5 text-left last:border-b-0 hover:bg-[#1a1c21]"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate ${MONO} text-xs leading-normal text-[#ecedee]`}>{evalRow.id}</span>
                      <span className="truncate font-sans text-[11px] leading-normal text-[#8b8f98]">
                        {evalRow.meta}
                      </span>
                    </span>
                    {evalRow.passRate !== null ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="block h-1 w-10 overflow-hidden rounded-full bg-[#ffffff1a]">
                          <span
                            className="block h-full rounded-full bg-[#4cc38a]"
                            style={{ width: `${Math.round(evalRow.passRate * 100)}%` }}
                          />
                        </span>
                        <span className={`${MONO} text-xs leading-normal text-[#ecedee]`}>
                          {evalRow.passRateLabel}
                        </span>
                      </span>
                    ) : null}
                    <LuChevronRight className="size-3.5 shrink-0 text-[#8b8f98]" aria-hidden />
                  </button>
                ))}
              </div>
            ))}
          </div>
          {state.model.guidance ? (
            <span className="font-sans text-[11px] leading-[1.4] text-[#8b8f98]">{state.model.guidance}</span>
          ) : null}
        </>
      )}
    </div>
  );
}
