import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTask,
  fetchTasks,
  type TaskDetailFile,
  type TaskListing,
} from "../../api";
import { useRunCatalog } from "../../catalog/useRunCatalog";
import { displayCatalogPath } from "../../catalog/displayCatalogPath";
import { relativeTime } from "../../catalogJoin";
import {
  newRunPath,
  pipelinePath,
  runStreamPath,
  taskPath,
  workshopPath,
} from "../../routes";
import { navigate } from "../../routes";
import { runDisplayStatus } from "../../status/runStatus";
import { Keycap } from "../Keycap";
import { useHotkeys } from "../keys";
import { StatusPill } from "../StatusPill";
import { runStatusPillLabel, statusSignalFromRun } from "../statusSignal";
import {
  filterTasksByTab,
  parseConstraintItems,
  runsForTaskListing,
  taskFilterCounts,
  taskRowKey,
  type TaskFilterTab,
} from "./taskViews";
import { TasksColumnHeader, TasksTableRow } from "./TasksTableRow";

function tasksShowRootLabels(tasks: TaskListing[]): boolean {
  const byId = new Map<string, number>();
  for (const task of tasks) {
    byId.set(task.id, (byId.get(task.id) ?? 0) + 1);
  }
  if ([...byId.values()].some((n) => n > 1)) return true;
  const roots = new Set(tasks.map((t) => t.project_root ?? ""));
  return roots.size > 1;
}

function TaskFilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  accentIcon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 py-0 text-[13px]${
        active
          ? " border border-[#ffffff1a] bg-[var(--sf-raised)] font-medium text-[var(--sf-text-1)]"
          : " text-[var(--sf-text-2)]"
      }`}
    >
      <span>{label}</span>
      <span className="font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-2)]">
        {count}
      </span>
    </button>
  );
}

export function TasksRedesign({
  taskId,
  onNew,
}: {
  taskId?: string;
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } =
    useRunCatalog();
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tab, setTab] = useState<TaskFilterTab>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetailFile | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await fetchTasks();
      setTasks(t.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const showRootLabels = useMemo(
    () => tasksShowRootLabels(tasks),
    [tasks],
  );

  const filtered = useMemo(
    () => filterTasksByTab(tasks, snapshot, tab),
    [tasks, snapshot, tab],
  );

  const selected = useMemo(() => {
    if (selectedKey) {
      return tasks.find((t) => taskRowKey(t) === selectedKey) ?? null;
    }
    if (taskId) {
      return tasks.find((t) => t.id === taskId) ?? null;
    }
    return null;
  }, [tasks, selectedKey, taskId]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedKey(null);
      return;
    }
    const key = selected ? taskRowKey(selected) : null;
    if (!key || !filtered.some((t) => taskRowKey(t) === key)) {
      setSelectedKey(taskRowKey(filtered[0]!));
    }
  }, [filtered, selected]);

  useEffect(() => {
    if (taskId && tasks.length > 0) {
      const match = tasks.find((t) => t.id === taskId);
      if (match) setSelectedKey(taskRowKey(match));
    }
  }, [taskId, tasks]);

  const history = selected ? runsForTaskListing(snapshot, selected) : [];
  const last = history[0];

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    let cancelled = false;
    void fetchTask(selected.id)
      .then((res) => {
        if (!cancelled) setDetail(res.task);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.path, selected?.project_root]);

  const loading = tasksLoading || catalogLoading;
  const displayError = error ?? catalogError;
  const counts = useMemo(
    () => taskFilterCounts(tasks, snapshot),
    [tasks, snapshot],
  );

  const selectTask = useCallback((task: TaskListing) => {
    setSelectedKey(taskRowKey(task));
    navigate(taskPath(task.id));
  }, []);

  const selectedIndex = selected
    ? filtered.findIndex((t) => taskRowKey(t) === taskRowKey(selected))
    : -1;

  useHotkeys(
    [
      {
        key: "j",
        scope: "tasks",
        handler: () => {
          if (filtered.length === 0) return;
          const next = Math.min(
            selectedIndex < 0 ? 0 : selectedIndex + 1,
            filtered.length - 1,
          );
          selectTask(filtered[next]!);
        },
      },
      {
        key: "k",
        scope: "tasks",
        handler: () => {
          if (filtered.length === 0) return;
          const next = Math.max(selectedIndex <= 0 ? 0 : selectedIndex - 1, 0);
          selectTask(filtered[next]!);
        },
      },
      {
        key: "o",
        scope: "tasks",
        when: () => Boolean(last),
        handler: () => {
          if (last) navigate(runStreamPath(last.run_id));
        },
      },
      {
        key: "r",
        scope: "tasks",
        when: () => Boolean(selected),
        handler: () => {
          if (!selected) return;
          onNew(
            newRunPath({
              task: selected.path,
              pipeline: last?.pipeline_id,
            }),
          );
        },
      },
    ],
    "tasks",
  );

  const workshopPipeline =
    last?.pipeline_path && last.project_root
      ? displayCatalogPath(last.pipeline_path, last.project_root)
      : last?.pipeline_path && !last.pipeline_path.startsWith("/")
        ? last.pipeline_path
        : undefined;

  const briefGoal = detailLoading
    ? null
    : (detail?.goal ?? selected?.goal ?? "");
  const briefContext = detailLoading ? null : detail?.context;
  const briefConstraints = detailLoading ? null : detail?.constraints;
  const constraintItems = useMemo(
    () => parseConstraintItems(briefConstraints ?? undefined),
    [briefConstraints],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <div className="flex h-14 w-full shrink-0 items-center justify-between gap-4 border-b border-b-[#ffffff12] px-5 py-0">
        <div className="flex shrink-0 items-baseline gap-2.5">
          <h1 className="text-xl font-semibold tracking-[-0.4px] text-[var(--sf-text-1)]">
            Tasks
          </h1>
          <span className="font-['Geist_Mono',monospace] text-[13px] text-[var(--sf-text-3)]">
            {tasks.length}
          </span>
          <span className="flex items-center gap-[5px] font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
            tasks/
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {selected ? (
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-[var(--sf-text-1)] px-3 py-0 text-[13px] font-medium text-[var(--sf-ground)]"
              onClick={() =>
                onNew(
                  newRunPath({
                    task: selected.path,
                    pipeline: last?.pipeline_id,
                  }),
                )
              }
            >
              Start a run
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex h-12 w-full shrink-0 items-center border-b border-b-[#ffffff12] px-5 py-0">
        <div className="flex items-center gap-0.5">
          <TaskFilterChip
            active={tab === "all"}
            label="All"
            count={counts.all}
            onClick={() => setTab("all")}
          />
          <TaskFilterChip
            active={tab === "has_open_gate"}
            label="Has open gate"
            count={counts.has_open_gate}
            onClick={() => setTab("has_open_gate")}
          />
          <TaskFilterChip
            active={tab === "has_failed_run"}
            label="Has failed run"
            count={counts.has_failed_run}
            onClick={() => setTab("has_failed_run")}
          />
          <TaskFilterChip
            active={tab === "no_runs"}
            label="No runs yet"
            count={counts.no_runs}
            onClick={() => setTab("no_runs")}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-r-[#ffffff12]">
          {displayError ? (
            <p className="px-5 py-3 text-xs text-[var(--sf-fail)]">{displayError}</p>
          ) : null}
          {loading ? (
            <p className="px-5 py-3 text-xs text-[var(--sf-text-3)]">Loading tasks…</p>
          ) : null}
          {!loading && filtered.length === 0 ? (
            <p className="px-5 py-3 text-xs text-[var(--sf-text-3)]">
              No tasks match this filter.
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <TasksColumnHeader />
            {filtered.map((task) => (
              <TasksTableRow
                key={taskRowKey(task)}
                task={task}
                snapshot={snapshot}
                showRootLabel={showRootLabels}
                selected={
                  selected !== null && taskRowKey(task) === taskRowKey(selected)
                }
                onSelect={() => selectTask(task)}
              />
            ))}
          </div>
          <footer className="shrink-0 border-t border-t-[#ffffff12] px-3 py-2 text-[11px] text-[var(--sf-text-3)]">
            <Keycap>J</Keycap>/<Keycap>K</Keycap> select · <Keycap>O</Keycap> open
            run · <Keycap>R</Keycap> start run
          </footer>
        </div>

        {selected ? (
          <aside className="flex w-[440px] min-w-0 shrink-0 flex-col overflow-clip bg-[var(--sf-panel)]">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex w-full flex-col gap-1 border-b border-b-[#ffffff12] px-4 py-2.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                  Task
                </div>
                <div className="font-['Geist_Mono',monospace] text-[15px] font-semibold text-[var(--sf-text-1)]">
                  {selected.id}
                </div>
                <div className="truncate font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                  {selected.path}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <div className="flex flex-col gap-3 border-b border-b-[#ffffff12] pb-3">
                  <div className="flex flex-col gap-1">
                    <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                      Goal
                    </div>
                    {detailLoading ? (
                      <p className="text-sm text-[var(--sf-text-3)]">Loading…</p>
                    ) : (
                      <p className="text-sm font-medium leading-[1.4] text-[var(--sf-text-1)]">
                        {briefGoal}
                      </p>
                    )}
                  </div>
                  {constraintItems.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                        Constraints
                      </div>
                      <ul className="list-disc space-y-1 pl-4 text-[13px] leading-[1.4] text-[var(--sf-text-2)]">
                        {constraintItems.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {briefContext ? (
                    <div className="flex flex-col gap-1">
                      <div className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                        Context
                      </div>
                      <p className="text-[13px] text-[var(--sf-text-2)]">
                        {briefContext}
                      </p>
                    </div>
                  ) : null}
                </div>

                <div className="pt-3">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
                    Run history
                  </div>
                  {history.length === 0 ? (
                    <p className="text-xs text-[var(--sf-text-3)]">No runs yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {history.slice(0, 8).map((run) => (
                        <li
                          key={run.run_id}
                          className="flex flex-wrap items-center gap-2 text-xs"
                        >
                          <a
                            className="font-['Geist_Mono',monospace] text-[var(--sf-text-1)]"
                            href={`#${runStreamPath(run.run_id)}`}
                          >
                            {run.run_id}
                          </a>
                          <StatusPill
                            signal={statusSignalFromRun(run)}
                            label={runStatusPillLabel(runDisplayStatus(run))}
                          />
                          <span className="font-['Geist_Mono',monospace] text-[var(--sf-text-3)]">
                            {relativeTime(run.created_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--sf-text-1)] px-3 py-1.5 text-xs font-medium text-[var(--sf-ground)]"
                    onClick={() =>
                      onNew(
                        newRunPath({
                          task: selected.path,
                          pipeline: last?.pipeline_id,
                        }),
                      )
                    }
                  >
                    Start a run
                  </button>
                  {workshopPipeline ? (
                    <a
                      className="rounded-lg border border-[#ffffff1a] bg-[var(--sf-raised)] px-3 py-1.5 text-xs font-medium text-[var(--sf-text-2)]"
                      href={`#${workshopPath({ pipeline: workshopPipeline })}`}
                    >
                      Open in Workshop
                    </a>
                  ) : null}
                  {last ? (
                    <a
                      className="rounded-lg px-3 py-1.5 text-xs text-[var(--sf-text-2)]"
                      href={`#${pipelinePath(last.pipeline_id)}`}
                    >
                      Pipeline {last.pipeline_id}
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
