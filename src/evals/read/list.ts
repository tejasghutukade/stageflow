import path from "node:path";
import type { EvalCatalogEntry } from "../../config/evalCatalog.js";
import { EVAL_DEFAULT_REPEATS, resolveEvalPaths } from "../../config/loadEval.js";
import { evalStem } from "../../config/evalWriteRoots.js";
import {
  listStatus,
  regressionBanner,
  type BannerEvalInput,
  type ListRunSummary,
  type ListStatus,
  type RegressionBanner,
} from "../listStatus.js";
import type { EvalRunRow } from "../storeTypes.js";
import {
  completedRunsNewestFirst,
  runHeadline,
  statsOfRun,
  type ReadStore,
  type RunHeadline,
} from "./runs.js";

export type EvalListItem = {
  project_root?: string;
  id: string;
  name: string;
  description: string | null;
  type: string;
  path: string;
  target: {
    kind: "stage";
    pipeline_path?: string;
    stage_id?: string;
    file?: string;
    label: string;
  };
  dataset_path: string;
  dataset_cases: number;
  repeats: number;
  grader_count: number;
  rubric_count: number;
  valid: boolean;
  finding_count: number;
  status: ListStatus;
  last_run: RunHeadline | null;
  last_run_delta_pts: number | null;
  trend: Array<{ run_number: number; passed: boolean; pass_rate: number | null; pass_threshold: number }>;
};

const TREND_RUNS = 7;

function posix(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

function pipelineStem(pipelinePath: string): string {
  return path.basename(pipelinePath).replace(/\.pipeline\.ya?ml$/, "");
}

async function listRunSummary(store: ReadStore, row: EvalRunRow): Promise<ListRunSummary> {
  const stats = statsOfRun(row, await store.listEvalResults(row.evalRunId));
  return {
    runNumber: row.runNumber,
    passed: row.passed === true,
    passRate: stats.pass_rate,
    finishedAt: row.finishedAt,
    graders: stats.by_grader.map((g) => ({ graderId: g.grader_id, hash: g.hash, passRate: g.pass_rate })),
  };
}

export async function buildEvalListItems(input: {
  store: ReadStore;
  projectRoot: string;
  entries: readonly EvalCatalogEntry[];
  datasetCases: (absPath: string) => number;
}): Promise<{ items: EvalListItem[]; banner: RegressionBanner | null; bannerInputs: BannerEvalInput[] }> {
  const { store, projectRoot } = input;
  const items: EvalListItem[] = [];
  const bannerInputs: BannerEvalInput[] = [];

  for (const entry of input.entries) {
    const findingCount = entry.findings.length;
    const valid = !entry.findings.some((f) => f.severity === "error");
    if (!entry.outcome.ok) {
      const id = evalStem(path.basename(entry.absPath));
      items.push({
        id,
        name: id,
        description: null,
        type: "capability",
        path: entry.relPath,
        target: { kind: "stage", label: "Unknown target" },
        dataset_path: "",
        dataset_cases: 0,
        repeats: EVAL_DEFAULT_REPEATS,
        grader_count: 0,
        rubric_count: 0,
        valid: false,
        finding_count: findingCount,
        status: "never_run",
        last_run: null,
        last_run_delta_pts: null,
        trend: [],
      });
      continue;
    }

    const loaded = entry.outcome.value;
    const { file } = loaded;
    const paths = resolveEvalPaths(file, loaded.path);
    const type = file.type ?? "capability";
    const completed = await completedRunsNewestFirst(store, projectRoot, loaded.id);
    const last = completed[0];
    const previous = completed[1];
    const lastSummary = last ? await listRunSummary(store, last) : null;
    const previousSummary = previous ? await listRunSummary(store, previous) : null;
    const status = listStatus(
      [lastSummary, previousSummary].filter((s): s is ListRunSummary => s !== null),
      type,
    );
    bannerInputs.push({ evalId: loaded.id, status, last: lastSummary, previous: previousSummary });

    const pipelinePath = paths.pipelinePath !== undefined ? posix(projectRoot, paths.pipelinePath) : undefined;
    const stageFile = paths.stageFile !== undefined ? posix(projectRoot, paths.stageFile) : undefined;
    const label =
      pipelinePath !== undefined
        ? `${pipelineStem(pipelinePath)} · ${file.target.stage ?? ""}`
        : path.basename(stageFile ?? "").replace(/\.(stage\.)?ya?ml$/, "");
    const delta =
      lastSummary?.passRate != null && previousSummary?.passRate != null
        ? (lastSummary.passRate - previousSummary.passRate) * 100
        : null;

    items.push({
      id: loaded.id,
      name: file.name ?? loaded.id,
      description: file.description ?? null,
      type,
      path: entry.relPath,
      target: {
        kind: "stage",
        ...(pipelinePath !== undefined ? { pipeline_path: pipelinePath } : {}),
        ...(file.target.stage !== undefined ? { stage_id: file.target.stage } : {}),
        ...(stageFile !== undefined ? { file: stageFile } : {}),
        label,
      },
      dataset_path: posix(projectRoot, paths.datasetPath),
      dataset_cases: input.datasetCases(paths.datasetPath),
      repeats: file.defaults?.repeats ?? EVAL_DEFAULT_REPEATS,
      grader_count: loaded.graders.length,
      rubric_count: loaded.graders.filter((g) => g.type === "rubric").length,
      valid,
      finding_count: findingCount,
      status,
      last_run: last ? runHeadline(last) : null,
      last_run_delta_pts: delta,
      trend: completed
        .slice(0, TREND_RUNS)
        .reverse()
        .map((r) => ({
          run_number: r.runNumber,
          passed: r.passed === true,
          pass_rate: ((r.summary ?? {}) as { pass_rate?: number | null }).pass_rate ?? null,
          pass_threshold: r.passThreshold,
        })),
    });
  }
  return { items, banner: regressionBanner(bannerInputs), bannerInputs };
}

export async function costLastSevenDays(
  store: Pick<ReadStore, "listEvalRuns">,
  projectRoot: string,
  now: Date,
): Promise<number> {
  const cutoff = now.getTime() - 7 * 24 * 3600 * 1000;
  const createdFloor = cutoff - 24 * 3600 * 1000;
  let total = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await store.listEvalRuns({ projectRoot, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const run of page.items) {
      if (run.finishedAt !== null && Date.parse(run.finishedAt) >= cutoff) total += run.costUsd;
    }
    const oldest = page.items[page.items.length - 1];
    if (page.nextCursor === null || !oldest || Date.parse(oldest.createdAt) < createdFloor) break;
    cursor = page.nextCursor;
  }
  return total;
}
