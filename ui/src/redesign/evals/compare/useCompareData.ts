import { useEffect, useState } from "react";
import { EvalApiError, fetchEvalCompare, fetchEvalRunByNumber, fetchEvalRuns } from "../../../api";
import type { EvalCompareResult, EvalRunDetail } from "../../../api/evalTypes";
import { datasetIdOf } from "../run/runDialogModel";
import { runDatasetPath } from "../run/liveProgressModel";
import { loadCases } from "../run/useRunDialogData";
import {
  compareErrorText,
  defaultSelection,
  pickerOptions,
  type CaseInfo,
  type PickerOption,
  type Selection,
} from "./compareModel";

export type CompareData =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; options: PickerOption[] }
  | {
      status: "ready";
      selection: Selection;
      options: PickerOption[];
      result: EvalCompareResult;
      runA: EvalRunDetail;
      runB: EvalRunDetail;
      cases: CaseInfo[] | null;
    };

function failure(err: unknown, runNumbers?: number): CompareData {
  const code = err instanceof EvalApiError ? err.code : null;
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", message: compareErrorText(code, message, runNumbers) };
}

async function loadRun(evalId: string, runNumber: number): Promise<EvalRunDetail> {
  try {
    return await fetchEvalRunByNumber(evalId, runNumber);
  } catch (err) {
    const notFound = err instanceof EvalApiError && err.status === 404;
    if (notFound) throw new EvalApiError(404, "NOT_FOUND", `Run #${runNumber} no longer exists.`);
    throw err;
  }
}

export function useCompareData(evalId: string, qa: number | undefined, qb: number | undefined): CompareData {
  const [data, setData] = useState<CompareData>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setData({ status: "loading" });
    void (async () => {
      try {
        const listed = await fetchEvalRuns({ eval_id: evalId, status: "completed", limit: 200 });
        const completed = listed.items;
        const selection = defaultSelection(
          completed.map((r) => r.run_number),
          { a: qa, b: qb },
        );
        if (!selection) {
          if (!cancelled) setData({ status: "empty", options: pickerOptions(completed) });
          return;
        }
        const [runA, runB] = await Promise.all([loadRun(evalId, selection.a), loadRun(evalId, selection.b)]);
        const result = await fetchEvalCompare(runA.eval_run_id, runB.eval_run_id);
        const datasetPath = runDatasetPath(runB);
        const cases = datasetPath
          ? await loadCases(datasetIdOf(datasetPath), evalId).then(
              ({ cases: list }) =>
                list.map((c, index) => ({ id: c.id, title: c.title ?? null, position: index + 1 })),
              () => null,
            )
          : null;
        if (cancelled) return;
        setData({
          status: "ready",
          selection,
          options: pickerOptions(completed, [
            { run_number: runA.run_number, pass_rate: runA.stats?.pass_rate ?? null },
            { run_number: runB.run_number, pass_rate: runB.stats?.pass_rate ?? null },
          ]),
          result,
          runA,
          runB,
          cases,
        });
      } catch (err) {
        if (!cancelled) setData(failure(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evalId, qa, qb]);

  return data;
}
