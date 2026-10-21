import { useEffect, useState } from "react";
import {
  fetchEval,
  fetchEvalDataset,
  fetchEvalRunByNumber,
  fetchEvalRuns,
  fetchModels,
  type CatalogModel,
} from "../../../api";
import type { EvalDatasetCase } from "../../../api/evalTypes";
import { buildContext, datasetIdOf, type LastCompletedRun, type RunDialogContext } from "./runDialogModel";
import type { RunDialogTarget } from "./runDialogStore";

const PAGE = 200;
const MAX_CASES = 2000;

export type RunDialogData =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; ctx: RunDialogContext; cases: EvalDatasetCase[]; models: CatalogModel[] };

export async function loadCases(datasetId: string, evalId: string, projectRoot?: string) {
  const cases: EvalDatasetCase[] = [];
  let total = 0;
  while (cases.length < MAX_CASES) {
    const page = await fetchEvalDataset(datasetId, {
      eval_id: evalId,
      project_root: projectRoot,
      offset: cases.length,
      limit: PAGE,
    });
    total = page.cases_total;
    cases.push(...page.cases);
    if (page.cases.length === 0 || cases.length >= total) break;
  }
  return { cases, total };
}

export function useRunDialogData(target: RunDialogTarget | null): RunDialogData {
  const [data, setData] = useState<RunDialogData>({ status: "loading" });
  const evalId = target?.evalId;
  const projectRoot = target?.projectRoot;

  useEffect(() => {
    if (!evalId) return;
    let cancelled = false;
    setData({ status: "loading" });
    (async () => {
      const detail = await fetchEval(evalId, projectRoot);
      const datasetId = detail.definition ? datasetIdOf(detail.definition.dataset) : null;
      const [casesResult, lastRuns, models] = await Promise.all([
        datasetId ? loadCases(datasetId, evalId, projectRoot).catch(() => null) : Promise.resolve(null),
        fetchEvalRuns({ eval_id: evalId, status: "completed", limit: 1, project_root: projectRoot }).catch(() => null),
        fetchModels().catch(() => null),
      ]);
      let lastCompleted: LastCompletedRun | null = null;
      let lastRunConfig: Record<string, any> | null = null;
      const headline = lastRuns?.items[0];
      if (headline) {
        const lastRun = await fetchEvalRunByNumber(evalId, headline.run_number, projectRoot).catch(() => null);
        lastRunConfig = lastRun?.config ?? null;
        lastCompleted = {
          evalRunId: headline.eval_run_id,
          runNumber: headline.run_number,
          failedCases: lastRun?.stats ? lastRun.stats.failing_cases.length : null,
        };
      }
      const ctx = buildContext({
        evalId,
        projectRoot,
        detail,
        casesTotal: casesResult?.total ?? null,
        lastCompleted,
        lastRunConfig,
      });
      return {
        status: "ready" as const,
        ctx,
        cases: casesResult?.cases ?? [],
        models: models ? models.providers.flatMap((p) => p.models) : [],
      };
    })().then(
      (next) => {
        if (!cancelled) setData(next);
      },
      (err) => {
        if (!cancelled) setData({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evalId, projectRoot]);

  return data;
}
