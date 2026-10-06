import type { CatalogSnapshot } from "../../catalog/source";
import {
  displayCatalogPath,
  normalizeCatalogSlashes,
} from "../../catalog/displayCatalogPath";
import { runDisplayStatus } from "../../status/runStatus";
import type { RunSummary, TaskListing } from "../../api";

export type TaskFilterTab =
  | "all"
  | "has_open_gate"
  | "has_failed_run"
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
  return constraints
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
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
    no_runs: filterTasksByTab(tasks, snapshot, "no_runs").length,
  };
}
