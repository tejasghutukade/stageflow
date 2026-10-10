import type { CatalogSnapshot } from "../../catalog/source";
import {
  displayCatalogPath,
  normalizeCatalogSlashes,
} from "../../catalog/displayCatalogPath";
import { runDisplayStatus } from "../../status/runStatus";
import type {
  CatalogValidationResult,
  PipelineListing,
  RunSummary,
  TaskDetailFile,
  TaskListing,
} from "../../api";
import { relativeTime } from "../../catalogJoin";

export type TaskFilterTab =
  | "all"
  | "has_open_gate"
  | "has_failed_run"
  | "failing"
  | "no_runs";

function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(value);
}

function basenameOf(pathValue: string): string {
  const parts = normalizeCatalogSlashes(pathValue).split("/");
  return parts[parts.length - 1] ?? pathValue;
}

export function stripTaskFileSuffix(pathValue: string): string {
  let p = normalizeCatalogSlashes(pathValue).replace(/^\.\//, "");
  if (p.endsWith(".task.yaml")) {
    p = p.slice(0, -".task.yaml".length);
  } else if (p.endsWith(".yaml")) {
    p = p.slice(0, -".yaml".length);
  }
  return p;
}

export function catalogPathKey(pathValue: string): string {
  return stripTaskFileSuffix(pathValue);
}

function looksLikeTaskPath(value: string): boolean {
  const n = normalizeCatalogSlashes(value);
  return n.includes("/") || /\.ya?ml$/i.test(n);
}

export function projectRootsMatch(
  taskRoot?: string,
  runRoot?: string,
): boolean {
  if (!taskRoot || !runRoot) return true;
  const a = normalizeCatalogSlashes(taskRoot).replace(/\/$/, "");
  const b = normalizeCatalogSlashes(runRoot).replace(/\/$/, "");
  if (a === b) return true;
  if (!isAbsolutePath(a)) {
    if (b.endsWith(`/${a}`)) return true;
    if (basenameOf(b) === a) return true;
    return false;
  }
  if (!isAbsolutePath(b)) {
    if (a.endsWith(`/${b}`)) return true;
    if (basenameOf(a) === b) return true;
    return false;
  }
  return false;
}

function runCatalogRelativePath(run: RunSummary): string {
  const raw =
    run.task_path ??
    (run.task_id && looksLikeTaskPath(run.task_id) ? run.task_id : "");
  if (!raw) return "";
  const normalized = normalizeCatalogSlashes(raw);
  if (isAbsolutePath(normalized) && run.project_root) {
    return normalizeCatalogSlashes(
      displayCatalogPath(normalized, run.project_root),
    );
  }
  return normalized;
}

function taskPathsAlign(taskPath: string, runPath: string): boolean {
  const kt = catalogPathKey(taskPath);
  const kr = catalogPathKey(runPath);
  if (kt === kr) return true;
  const bt = basenameOf(kt);
  const br = basenameOf(kr);
  if (bt !== br) return false;
  if (!kr.includes("/")) {
    return kt === br || kt.endsWith(`/${br}`);
  }
  if (!kt.includes("/")) {
    return kr === bt || kr.endsWith(`/${bt}`);
  }
  return false;
}

export function runMatchesTask(run: RunSummary, task: TaskListing): boolean {
  if (
    task.project_root &&
    run.project_root &&
    !projectRootsMatch(task.project_root, run.project_root)
  ) {
    return false;
  }

  const taskPath = task.path ? normalizeCatalogSlashes(task.path) : "";
  const runPath = runCatalogRelativePath(run);

  const hasTaskPath = taskPath.length > 0;
  const hasRunPath =
    Boolean(run.task_path) ||
    Boolean(run.task_id && looksLikeTaskPath(run.task_id));

  if (hasTaskPath && hasRunPath && runPath) {
    if (taskPathsAlign(taskPath, runPath)) return true;
    return false;
  }

  if (taskPath && runPath && taskPathsAlign(taskPath, runPath)) {
    return true;
  }

  const taskId = task.id;
  const runTaskId = run.task_id ?? "";

  if (runTaskId && !looksLikeTaskPath(runTaskId) && runTaskId === taskId) {
    return true;
  }

  if (runTaskId) {
    if (catalogPathKey(runTaskId) === taskId) return true;
    if (basenameOf(stripTaskFileSuffix(runTaskId)) === taskId) return true;
  }

  if (runPath && basenameOf(catalogPathKey(runPath)) === taskId) {
    return true;
  }

  return false;
}

function sortRunsNewest(runs: RunSummary[]): RunSummary[] {
  return runs.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function isOpaqueRootSegment(segment: string): boolean {
  return /^[a-f0-9]{4,12}$/i.test(segment);
}

export function taskRootTitle(task: TaskListing): string {
  return task.project_root ?? task.path;
}

export function taskRootLabel(task: TaskListing): string {
  const path = normalizeCatalogSlashes(task.path);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  if (task.project_root && !isAbsolutePath(task.project_root)) {
    if (dir) {
      if (
        dir === task.project_root ||
        dir.startsWith(`${task.project_root}/`)
      ) {
        return dir;
      }
      return `${task.project_root}/${dir}`.replace(/\/+/g, "/");
    }
    return task.project_root;
  }

  if (dir) return dir;

  if (task.project_root && isAbsolutePath(task.project_root)) {
    const base = basenameOf(task.project_root);
    if (!isOpaqueRootSegment(base)) return base;
    return "repo";
  }

  return "project";
}

export function parseConstraintItems(
  constraints: string | string[] | undefined,
): string[] {
  if (!constraints) return [];
  if (Array.isArray(constraints)) {
    return constraints.map(String).filter((line) => line.trim().length > 0);
  }
  const lines = constraints
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const listed = lines.filter((line) => /^[-*]\s+/.test(line));
  if (listed.length === 0) return [constraints.trim()].filter((line) => line.length > 0);
  return listed
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

export function taskRowKey(task: TaskListing): string {
  return `${task.project_root ?? ""}\0${task.path}`;
}

export function sortTasksForDisplay(tasks: TaskListing[]): TaskListing[] {
  return [...tasks].sort((a, b) => {
    const rootCmp = taskRootLabel(a).localeCompare(taskRootLabel(b));
    if (rootCmp !== 0) return rootCmp;
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return a.path.localeCompare(b.path);
  });
}

export function runsForTaskListing(
  snapshot: CatalogSnapshot,
  task: TaskListing,
): RunSummary[] {
  return sortRunsNewest(
    snapshot.runs.filter((run) => runMatchesTask(run, task)),
  );
}

export function filterTasksByTab(
  tasks: TaskListing[],
  snapshot: CatalogSnapshot,
  tab: TaskFilterTab,
): TaskListing[] {
  const sorted = sortTasksForDisplay(tasks);
  if (tab === "all") return sorted;
  return sorted.filter((task) => {
    const runs = runsForTaskListing(snapshot, task);
    if (tab === "no_runs") return runs.length === 0;
    if (tab === "has_open_gate") {
      return runs.some((run) => Boolean(run.waiting_stage_id));
    }
    if (tab === "has_failed_run") {
      return runs.some((run) => runDisplayStatus(run) === "failed");
    }
    if (tab === "failing") {
      return taskLastRunKind(runs[0]) === "failed";
    }
    return true;
  });
}

export function taskRunCount(
  snapshot: CatalogSnapshot,
  task: TaskListing,
): number {
  return runsForTaskListing(snapshot, task).length;
}

export function taskTotalCostUsd(
  snapshot: CatalogSnapshot,
  task: TaskListing,
): number | undefined {
  const runs = runsForTaskListing(snapshot, task);
  let sum = 0;
  let any = false;
  for (const run of runs) {
    if (run.total_cost_usd !== undefined) {
      sum += run.total_cost_usd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

export function taskFilterCounts(
  tasks: TaskListing[],
  snapshot: CatalogSnapshot,
): Record<TaskFilterTab, number> {
  return {
    all: tasks.length,
    has_open_gate: filterTasksByTab(tasks, snapshot, "has_open_gate").length,
    has_failed_run: filterTasksByTab(tasks, snapshot, "has_failed_run").length,
    failing: filterTasksByTab(tasks, snapshot, "failing").length,
    no_runs: filterTasksByTab(tasks, snapshot, "no_runs").length,
  };
}

export type TaskLastRunKind =
  | "waiting"
  | "failed"
  | "running"
  | "succeeded"
  | "cancelled"
  | "none";

export function taskLastRunKind(last: RunSummary | undefined): TaskLastRunKind {
  if (!last) return "none";
  if (last.waiting_stage_id) return "waiting";
  switch (last.status) {
    case "failed":
      return "failed";
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

const ATTENTION_ORDER: TaskLastRunKind[] = [
  "waiting",
  "failed",
  "running",
  "succeeded",
  "cancelled",
  "none",
];

export function taskAttentionBucket(last: RunSummary | undefined): number {
  return ATTENTION_ORDER.indexOf(taskLastRunKind(last));
}

export function sortTasksByAttention(
  tasks: TaskListing[],
  snapshot: CatalogSnapshot,
): TaskListing[] {
  const lastByKey = new Map<string, RunSummary | undefined>();
  for (const task of tasks) {
    lastByKey.set(taskRowKey(task), runsForTaskListing(snapshot, task)[0]);
  }
  return [...tasks].sort((a, b) => {
    const la = lastByKey.get(taskRowKey(a));
    const lb = lastByKey.get(taskRowKey(b));
    const bucketCmp = taskAttentionBucket(la) - taskAttentionBucket(lb);
    if (bucketCmp !== 0) return bucketCmp;
    if (la && lb) {
      const timeCmp = lb.created_at.localeCompare(la.created_at);
      if (timeCmp !== 0) return timeCmp;
    }
    const idCmp = a.id.localeCompare(b.id);
    if (idCmp !== 0) return idCmp;
    return a.path.localeCompare(b.path);
  });
}

export function filterTasksBySearch(
  tasks: TaskListing[],
  query: string,
): TaskListing[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter(
    (task) =>
      task.id.toLowerCase().includes(q) ||
      (task.goal ?? "").toLowerCase().includes(q),
  );
}

export function catalogRelativePath(pathValue: string, projectRoot?: string): string {
  const normalized = normalizeCatalogSlashes(pathValue).replace(/^\.\//, "");
  if (isAbsolutePath(normalized) && projectRoot) {
    return normalizeCatalogSlashes(displayCatalogPath(normalized, projectRoot));
  }
  return normalized;
}

export function parentDirectory(pathValue: string): string {
  const normalized = normalizeCatalogSlashes(pathValue);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : ".";
}

export function taskFolderLabel(tasks: TaskListing[]): string {
  if (tasks.length === 0) return "tasks/";
  const dirs = new Set(
    tasks.map((task) =>
      parentDirectory(catalogRelativePath(task.path, task.project_root)),
    ),
  );
  if (dirs.size !== 1) return "multiple folders";
  const [dir] = [...dirs];
  return dir === "." ? "./" : `${dir}/`;
}

export type TaskPipelineRef = { id: string; path?: string; project_root?: string };

function pipelineRef(listing: PipelineListing): TaskPipelineRef {
  return {
    id: listing.id,
    path: listing.path,
    ...(listing.project_root ? { project_root: listing.project_root } : {}),
  };
}

export function taskPipelineFor(
  task: TaskListing,
  last: RunSummary | undefined,
  pipelines: PipelineListing[],
): TaskPipelineRef | null {
  if (last) {
    const listing = pipelines
      .filter(
        (p) =>
          p.id === last.pipeline_id &&
          projectRootsMatch(task.project_root, p.project_root),
      )
      .sort((a, b) => a.path.localeCompare(b.path))[0];
    return listing ? pipelineRef(listing) : { id: last.pipeline_id };
  }
  const taskDir = parentDirectory(catalogRelativePath(task.path, task.project_root));
  const match = pipelines
    .filter(
      (p) =>
        projectRootsMatch(task.project_root, p.project_root) &&
        parentDirectory(catalogRelativePath(p.path, p.project_root)) === taskDir,
    )
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path))[0];
  return match ? pipelineRef(match) : null;
}

export type TaskRowView = {
  key: string;
  task: TaskListing;
  runs: RunSummary[];
  last: RunSummary | undefined;
  kind: TaskLastRunKind;
  pipeline: TaskPipelineRef | null;
  costUsd: number | undefined;
};

export function buildTaskRowViews(
  tasks: TaskListing[],
  snapshot: CatalogSnapshot,
  pipelines: PipelineListing[],
): TaskRowView[] {
  return sortTasksByAttention(tasks, snapshot).map((task) => {
    const runs = runsForTaskListing(snapshot, task);
    const last = runs[0];
    return {
      key: taskRowKey(task),
      task,
      runs,
      last,
      kind: taskLastRunKind(last),
      pipeline: taskPipelineFor(task, last, pipelines),
      costUsd: runsTotalCostUsd(runs),
    };
  });
}

export function filterRowViewsByTab(
  rows: TaskRowView[],
  tab: TaskFilterTab,
): TaskRowView[] {
  if (tab === "all") return rows;
  return rows.filter((row) => {
    if (tab === "no_runs") return row.runs.length === 0;
    if (tab === "has_open_gate") return openGateCount(row.runs) > 0;
    if (tab === "has_failed_run") {
      return row.runs.some((run) => runDisplayStatus(run) === "failed");
    }
    if (tab === "failing") return row.kind === "failed";
    return true;
  });
}

export function formatUsd(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(2)}`;
}

export function shortRunId(runId: string): string {
  return runId.length > 10 ? `run_${runId.slice(-6)}` : runId;
}

export function openGateCount(runs: RunSummary[]): number {
  return runs.filter((run) => Boolean(run.waiting_stage_id)).length;
}

export function runsTotalCostUsd(runs: RunSummary[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const run of runs) {
    if (run.total_cost_usd !== undefined) {
      sum += run.total_cost_usd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

export type RunHistorySegment = { kind: "runs" | "cost" | "gates"; text: string };

export function runHistorySegments(runs: RunSummary[]): RunHistorySegment[] {
  const segments: RunHistorySegment[] = [];
  if (runs.length > 0) {
    segments.push({
      kind: "runs",
      text: `${runs.length} ${runs.length === 1 ? "run" : "runs"}`,
    });
  }
  const cost = runsTotalCostUsd(runs);
  if (cost !== undefined && cost > 0) {
    segments.push({ kind: "cost", text: formatUsd(cost) });
  }
  const gates = openGateCount(runs);
  if (gates > 0) {
    segments.push({
      kind: "gates",
      text: `${gates} open ${gates === 1 ? "gate" : "gates"}`,
    });
  }
  return segments;
}

export function newestWaitingRun(runs: RunSummary[]): RunSummary | undefined {
  return sortRunsNewest(runs).find((run) => Boolean(run.waiting_stage_id));
}

export function runDurationMs(run: RunSummary): number | undefined {
  if (!run.finished_at || !run.created_at) return undefined;
  const start = Date.parse(run.created_at);
  const end = Date.parse(run.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

export type TaskCheckoutView = { target?: string; repository?: string };

export function taskCheckoutView(
  detail: Pick<TaskDetailFile, "checkout" | "repository" | "ref"> | null | undefined,
): TaskCheckoutView | null {
  if (!detail) return null;
  const checkout = detail.checkout?.trim();
  const repository = detail.repository?.trim();
  if (!checkout && !repository) return null;
  const ref = detail.ref?.trim();
  const target = checkout || ref || undefined;
  return {
    ...(target ? { target } : {}),
    ...(repository ? { repository } : {}),
  };
}

export function validationStatusLabel(
  result: CatalogValidationResult | null,
  checkedAt: string | null,
  now = Date.now(),
): string | null {
  if (!result || !checkedAt) return null;
  const errors = result.summary.errors;
  if (errors > 0) return `${errors} ${errors === 1 ? "error" : "errors"}`;
  return `validated ${relativeAgo(checkedAt, now)}`;
}

export function relativeAgo(iso: string, now = Date.now()): string {
  const rel = relativeTime(iso, now);
  if (rel === "just now" || rel.endsWith(" ago")) return rel;
  return /^\d+m$/.test(rel) ? `${rel} ago` : rel;
}
