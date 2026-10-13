import type {
  PipelineListing,
  PipelineStageListing,
  RunSummary,
  StageGateKind,
  TaskListing,
} from "../../api";
import {
  displayCatalogPath,
  normalizeCatalogSlashes,
} from "../../catalog/displayCatalogPath";
import { formatApproxCost } from "../../catalog/stats";
import { formatDurationMs } from "../../runs/formatRunMetrics";

export type PipelineSort = "last-run" | "id" | "stage-count";

export type PipelineGateSummary =
  | { kind: "none" }
  | { kind: "gates"; firstLabel: string; extraCount: number };

export type PipelineStageView = {
  id: string;
  gateLabels: string[];
  gates: PipelineGateSummary;
};

export type PipelineRowStats = {
  runCount: number;
  runsLabel: string;
  lastRun?: RunSummary;
  neverRun: boolean;
  avgDurationMs?: number;
  avgCostUsd?: number;
  tableAvg: string;
  inspectorDuration?: string;
  inspectorCost?: string;
};

export type PipelineListRow = {
  key: string;
  pipeline: PipelineListing;
  stageChain: string;
  stageCount: number;
  catalogPath: string;
  catalogRootBasename: string;
  stages: PipelineStageView[];
  gateLabels: string[];
  gates: PipelineGateSummary;
  tasks: TaskListing[];
  defaultTaskPath?: string;
  matchedRuns: RunSummary[];
  stats: PipelineRowStats;
};

export type PipelineListView = {
  rows: PipelineListRow[];
  filteredRows: PipelineListRow[];
  filteredCount: number;
  catalogRootsVisible: boolean;
  sort: PipelineSort;
};

const EM_DASH = "—";

export function pipelineRowKey(pipeline: PipelineListing): string {
  return `${pipeline.path}:${pipeline.project_root ?? ""}:${pipeline.id}`;
}

function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(value);
}

function basenameOf(pathValue: string): string {
  const parts = normalizeCatalogSlashes(pathValue).replace(/\/$/, "").split("/");
  return parts[parts.length - 1] ?? pathValue;
}

function gateDisplayLabel(kind: StageGateKind): string {
  switch (kind) {
    case "free_text":
      return "free text";
    case "confirm":
      return "confirm";
    case "multi_question":
      return "multi-question";
    case "artifact_backed":
      return "artifact";
  }
}

function gateLabelsForStages(stages: PipelineStageListing[]): string[] {
  const labels: string[] = [];
  for (const stage of stages) {
    for (const kind of stage.gate_kinds ?? []) {
      labels.push(gateDisplayLabel(kind));
    }
  }
  return labels;
}

function summarizeGates(labels: string[]): PipelineGateSummary {
  const firstLabel = labels[0];
  if (firstLabel === undefined) return { kind: "none" };
  return {
    kind: "gates",
    firstLabel,
    extraCount: labels.length - 1,
  };
}

function pipelineDirectory(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

function tasksForPipeline(
  pipeline: PipelineListing,
  tasks: TaskListing[],
): TaskListing[] {
  const dir = pipelineDirectory(pipeline.path);
  return tasks.filter((task) =>
    dir === "." ? !task.path.includes("/") : task.path.startsWith(`${dir}/`),
  );
}

function catalogPathOf(pipeline: PipelineListing): string {
  const stored = normalizeCatalogSlashes(pipeline.path);
  if (!isAbsolutePath(stored)) return stored;
  return normalizeCatalogSlashes(
    displayCatalogPath(stored, pipeline.project_root),
  );
}

function catalogRootBasename(projectRoot?: string): string {
  if (!projectRoot) return "";
  return basenameOf(projectRoot);
}

function normalizeRoot(root?: string): string | undefined {
  if (root === undefined || root === "") return undefined;
  return normalizeCatalogSlashes(root).replace(/\/$/, "");
}

function rootsEqual(left?: string, right?: string): boolean {
  return normalizeRoot(left) === normalizeRoot(right);
}

function runRelativePath(run: RunSummary): string | undefined {
  if (!run.pipeline_path) return undefined;
  const raw = normalizeCatalogSlashes(run.pipeline_path);
  // displayCatalogPath on an already-relative path returns only the basename.
  if (!isAbsolutePath(raw)) return raw;
  return normalizeCatalogSlashes(displayCatalogPath(raw, run.project_root));
}

function sameListing(left: PipelineListing, right: PipelineListing): boolean {
  return pipelineRowKey(left) === pipelineRowKey(right);
}

function listingsForRun(
  run: RunSummary,
  pipelines: PipelineListing[],
): PipelineListing[] {
  if (run.pipeline_path) {
    const relative = runRelativePath(run);
    if (!relative) return [];
    const matches = pipelines.filter(
      (pipeline) => normalizeCatalogSlashes(pipeline.path) === relative,
    );
    if (matches.length === 1) return matches;
    if (matches.length > 1) {
      return matches.filter((pipeline) =>
        rootsEqual(pipeline.project_root, run.project_root),
      );
    }
    return [];
  }
  const idMatches = pipelines.filter((pipeline) => pipeline.id === run.pipeline_id);
  return idMatches.length === 1 ? idMatches : [];
}

function matchedRunsFor(
  pipeline: PipelineListing,
  pipelines: PipelineListing[],
  runs: RunSummary[],
): RunSummary[] {
  return runs
    .filter((run) =>
      listingsForRun(run, pipelines).some((match) => sameListing(match, pipeline)),
    )
    .sort((left, right) => {
      const created = right.created_at.localeCompare(left.created_at);
      if (created !== 0) return created;
      return right.run_id.localeCompare(left.run_id);
    });
}

function runDurationMs(run: RunSummary): number | undefined {
  const start = Date.parse(run.created_at);
  const endRaw = run.finished_at ?? run.updated_at;
  if (!endRaw) return undefined;
  const end = Date.parse(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function stripApproxCost(usd: number): string {
  const formatted = formatApproxCost(usd);
  return formatted.startsWith("~") ? formatted.slice(1) : formatted;
}

function tableAvg(
  avgDurationMs: number | undefined,
  avgCostUsd: number | undefined,
): string {
  if (avgDurationMs === undefined) return EM_DASH;
  const duration = formatDurationMs(avgDurationMs);
  if (avgCostUsd === undefined) return duration;
  return `${duration} · ${stripApproxCost(avgCostUsd)}`;
}

function statsFor(runs: RunSummary[]): PipelineRowStats {
  const succeeded = runs.filter((run) => run.status === "succeeded");
  const durations = succeeded
    .map(runDurationMs)
    .filter((ms): ms is number => ms != null);
  const avgDurationMs =
    durations.length > 0
      ? durations.reduce((sum, ms) => sum + ms, 0) / durations.length
      : undefined;
  let costSum = 0;
  let anyCost = false;
  for (const run of succeeded) {
    if (run.total_cost_usd !== undefined) {
      costSum += run.total_cost_usd;
      anyCost = true;
    }
  }
  const avgCostUsd =
    anyCost && succeeded.length > 0 ? costSum / succeeded.length : undefined;
  const lastRun = runs[0];
  return {
    runCount: runs.length,
    runsLabel: runs.length === 0 ? EM_DASH : String(runs.length),
    ...(lastRun ? { lastRun } : {}),
    neverRun: lastRun === undefined,
    ...(avgDurationMs !== undefined ? { avgDurationMs } : {}),
    ...(avgCostUsd !== undefined ? { avgCostUsd } : {}),
    tableAvg: tableAvg(avgDurationMs, avgCostUsd),
    ...(avgDurationMs !== undefined
      ? { inspectorDuration: `avg ${formatDurationMs(avgDurationMs)}` }
      : {}),
    ...(avgCostUsd !== undefined
      ? { inspectorCost: `${stripApproxCost(avgCostUsd)} / run` }
      : {}),
  };
}

function matchesSearch(pipeline: PipelineListing, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const displayed = normalizeCatalogSlashes(
    displayCatalogPath(pipeline.path, pipeline.project_root),
  ).toLowerCase();
  const stored = normalizeCatalogSlashes(pipeline.path).toLowerCase();
  if (pipeline.id.toLowerCase().includes(query)) return true;
  if (displayed.includes(query)) return true;
  if (stored.includes(query)) return true;
  if (catalogRootBasename(pipeline.project_root).toLowerCase().includes(query)) {
    return true;
  }
  return pipeline.stages.some((stage) => stage.id.toLowerCase().includes(query));
}

function compareRows(
  left: PipelineListRow,
  right: PipelineListRow,
  sort: PipelineSort,
): number {
  if (sort === "id") return left.pipeline.id.localeCompare(right.pipeline.id);
  if (sort === "stage-count") {
    const byCount = right.stageCount - left.stageCount;
    if (byCount !== 0) return byCount;
    return left.pipeline.id.localeCompare(right.pipeline.id);
  }
  const leftAt = left.stats.lastRun?.created_at;
  const rightAt = right.stats.lastRun?.created_at;
  if (leftAt && rightAt) {
    const byTime = rightAt.localeCompare(leftAt);
    if (byTime !== 0) return byTime;
  } else if (leftAt) {
    return -1;
  } else if (rightAt) {
    return 1;
  }
  return left.pipeline.id.localeCompare(right.pipeline.id);
}

function catalogRootsVisible(pipelines: PipelineListing[]): boolean {
  const first = pipelines[0]?.project_root;
  return pipelines.some((pipeline) => pipeline.project_root !== first);
}

function stageViews(stages: PipelineStageListing[]): PipelineStageView[] {
  return stages.map((stage) => {
    const gateLabels = gateLabelsForStages([stage]);
    return {
      id: stage.id,
      gateLabels,
      gates: summarizeGates(gateLabels),
    };
  });
}

export function buildPipelineListView(input: {
  pipelines: PipelineListing[];
  tasks?: TaskListing[];
  runs?: RunSummary[];
  search?: string;
  sort?: PipelineSort;
}): PipelineListView {
  const tasks = input.tasks ?? [];
  const runs = input.runs ?? [];
  const sort = input.sort ?? "last-run";
  const search = input.search ?? "";
  const rows = input.pipelines
    .map((pipeline) => {
      const gateLabels = gateLabelsForStages(pipeline.stages);
      const directoryTasks = tasksForPipeline(pipeline, tasks);
      const matchedRuns = matchedRunsFor(pipeline, input.pipelines, runs);
      return {
        key: pipelineRowKey(pipeline),
        pipeline,
        stageChain: pipeline.stages.map((stage) => stage.id).join(" → "),
        stageCount: pipeline.stages.length,
        catalogPath: catalogPathOf(pipeline),
        catalogRootBasename: catalogRootBasename(pipeline.project_root),
        stages: stageViews(pipeline.stages),
        gateLabels,
        gates: summarizeGates(gateLabels),
        tasks: directoryTasks,
        ...(directoryTasks.length === 1
          ? { defaultTaskPath: directoryTasks[0]!.path }
          : {}),
        matchedRuns,
        stats: statsFor(matchedRuns),
      };
    })
    .sort((left, right) => compareRows(left, right, sort));
  const filteredRows = rows.filter((item) => matchesSearch(item.pipeline, search));
  return {
    rows,
    filteredRows,
    filteredCount: filteredRows.length,
    catalogRootsVisible: catalogRootsVisible(input.pipelines),
    sort,
  };
}
