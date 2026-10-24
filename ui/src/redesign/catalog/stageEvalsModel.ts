import type { EvalListItem, EvalListQuery, PipelineListing } from "../../api";
import { evalNewPath, evalPath, evalsPath } from "../../routes";
import { formatPercent, formatRelativeTime } from "../evals/format";
import type { StageRowFromPipelines } from "./stagesFromPipelines";

export const STAGE_EVALS_GUIDANCE = "Run an eval before you save changes to this stage.";
export const STAGE_EVALS_EMPTY = "No evals yet. Create one to check this stage before you ship changes.";

export type StageEvalsQuery = {
  key: string;
  label: string;
  query: EvalListQuery;
};

export type StageEvalRow = {
  id: string;
  href: string;
  meta: string;
  passRateLabel: string | null;
  passRate: number | null;
};

export type StageEvalsSection = {
  key: string;
  label: string;
  rows: StageEvalRow[];
};

export type StageEvalsModel = {
  total: number;
  sections: StageEvalsSection[];
  newEvalHref: string;
  evaluateHref: string;
  guidance: string | null;
};

export function stageEvalsQueries(
  row: StageRowFromPipelines,
  pipelines: PipelineListing[],
): StageEvalsQuery[] {
  const queries: StageEvalsQuery[] = [];
  for (const pipelineId of row.used_by_pipeline_ids) {
    const pipeline = pipelines.find(
      (p) => p.id === pipelineId && (p.project_root ?? "") === (row.project_root ?? ""),
    );
    if (!pipeline) continue;
    queries.push({
      key: `pipeline:${pipeline.path}`,
      label: pipeline.id,
      query: {
        ...(row.project_root ? { project_root: row.project_root } : {}),
        target_pipeline: pipeline.path,
        target_stage: row.id,
      },
    });
  }
  if (row.uses_path) {
    queries.push({
      key: `file:${row.uses_path}`,
      label: row.uses_path.replace(/\\/g, "/").split("/").pop() ?? row.uses_path,
      query: {
        ...(row.project_root ? { project_root: row.project_root } : {}),
        target_file: row.uses_path,
      },
    });
  }
  return queries;
}

export function stageEvalRow(item: EvalListItem, now: number): StageEvalRow {
  const cases = `${item.dataset_cases} ${item.dataset_cases === 1 ? "case" : "cases"}`;
  const lastRun = item.last_run;
  const meta = lastRun?.finished_at
    ? `${cases} · last run ${formatRelativeTime(lastRun.finished_at, now)}`
    : `${cases} · never run`;
  const passRate = lastRun?.pass_rate ?? null;
  return {
    id: item.id,
    href: evalPath(item.id),
    meta,
    passRate,
    passRateLabel: passRate === null ? null : formatPercent(passRate),
  };
}

export function newEvalHref(
  row: Pick<StageRowFromPipelines, "id" | "uses_path">,
  pipelinePath: string | undefined,
): string {
  if (pipelinePath) return evalNewPath({ pipeline: pipelinePath, stage: row.id });
  if (row.uses_path) return evalNewPath({ file: row.uses_path });
  return evalNewPath({ stage: row.id });
}

export function evaluateHref(
  row: Pick<StageRowFromPipelines, "id" | "uses_path">,
  pipelinePath: string | undefined,
  evalIds: string[],
): string {
  if (evalIds.length === 1) return evalPath(evalIds[0], { openRun: true });
  if (evalIds.length >= 2) return evalsPath({ stage: row.id });
  return newEvalHref(row, pipelinePath);
}

export function buildStageEvalsModel(
  row: StageRowFromPipelines,
  pipelines: PipelineListing[],
  results: Array<{ query: StageEvalsQuery; items: EvalListItem[] }>,
  now: number,
): StageEvalsModel {
  const seen = new Set<string>();
  const sections: StageEvalsSection[] = [];
  const evalIds: string[] = [];
  for (const { query, items } of results) {
    const rows = items.map((item) => stageEvalRow(item, now));
    for (const item of items) {
      const dedupeKey = `${item.project_root ?? ""}:${item.id}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        evalIds.push(item.id);
      }
    }
    if (rows.length > 0) sections.push({ key: query.key, label: query.label, rows });
  }
  const firstPipelinePath = stageEvalsQueries(row, pipelines).find((q) => q.query.target_pipeline)?.query
    .target_pipeline;
  return {
    total: evalIds.length,
    sections,
    newEvalHref: newEvalHref(row, firstPipelinePath),
    evaluateHref: evaluateHref(row, firstPipelinePath, evalIds),
    guidance: evalIds.length > 0 ? STAGE_EVALS_GUIDANCE : null,
  };
}
