import { useCallback, useEffect, useState } from "react";
import {
  fetchTasks,
  type RunSummary,
  type TaskListing,
} from "../api";
import { useRunCatalog } from "../catalog/useRunCatalog";
import { bucketViews, runsForTaskView } from "../catalog/views";
import { relativeTime } from "../catalogJoin";
import {
  newRunPath,
  pipelinePath,
  runStreamPath,
  taskPath,
} from "../routes";
import { StatusDot } from "../StatusLabel";
import { runDisplayStatus } from "../status/runStatus";

export function TasksPage({
  taskId,
  onNew,
}: {
  taskId?: string;
  onNew: (path: string) => void;
}) {
  const { snapshot, error: catalogError, loading: catalogLoading } = useRunCatalog();
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tasksLoading, setTasksLoading] = useState(true);

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

  const loading = tasksLoading || catalogLoading;
  const displayError = error ?? catalogError;
  const selected = taskId
    ? (tasks.find((task) => task.id === taskId) ?? null)
    : null;
  const history = selected ? runsForTaskView(snapshot, selected.id) : [];

  if (taskId) {
    return (
      <TaskDetail
        taskId={taskId}
        task={selected}
        runs={history}
        loading={loading}
        error={displayError}
        onNew={onNew}
      />
    );
  }

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p>
            A task is a brief plus the pipeline it should run through. Tasks
            are reusable; runs are not.
          </p>
        </div>
      </div>

        {displayError ? (
          <p style={{ color: "var(--color-text-red)" }}>{displayError}</p>
        ) : null}
        {loading ? <p className="muted">Loading tasks…</p> : null}
        {!loading && tasks.length === 0 ? (
          <p className="muted">No tasks yet. Add a YAML file under tasks/ in this project.</p>
        ) : null}

        {!loading && tasks.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Pipeline</th>
                <th>Runs</th>
                <th>Last result</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const historyForTask = runsForTaskView(snapshot, task.id);
                const last = historyForTask[0];
                const lastStatus = last ? runDisplayStatus(last) : undefined;
                const pipeline = last?.pipeline_id;
                return (
                  <tr key={task.id}>
                    <td>
                      <a href={`#${taskPath(task.id)}`}>{task.id}</a>
                      <div
                        className="muted"
                        style={{ fontSize: "var(--font-size-xs)" }}
                      >
                        {task.goal}
                      </div>
                    </td>
                    <td className="mono">{pipeline ?? "—"}</td>
                    <td className="mono">{historyForTask.length}</td>
                    <td>
                      {lastStatus ? (
                        <StatusDot status={lastStatus} />
                      ) : (
                        <span className="muted">no runs</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {last ? (
                        <a
                          className="btn btn--sm"
                          href={`#${runStreamPath(last.run_id)}`}
                        >
                          Open run
                        </a>
                      ) : (
                        <button
                          className="btn btn--sm"
                          onClick={() =>
                            onNew(newRunPath({ task: task.path }))
                          }
                        >
                          Run it
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
    </div>
  );
}

function TaskDetail({
  taskId,
  task,
  runs,
  loading,
  error,
  onNew,
}: {
  taskId: string;
  task: TaskListing | null;
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
  onNew: (path: string) => void;
}) {
  const last = runs[0];

  const buckets = bucketViews({ runs, health: null });
  const inFlight = buckets.waiting.length + buckets.inFlight.length;
  const subtitle = task
    ? `${task.path} · ${runs.length} ${runs.length === 1 ? "run" : "runs"}${
        inFlight > 0 ? ` · ${inFlight} in flight` : ""
      }`
    : taskId;

  return (
    <div className="main__inner">
      <p className="crumbs">
        <a href="#/tasks">Tasks</a> / {taskId}
      </p>

      <div className="page-head">
        <div>
          <h1>{taskId}</h1>
          <p className="mono">{subtitle}</p>
        </div>
          {task ? (
            <button
              className="btn btn--primary"
              onClick={() =>
                onNew(
                  newRunPath({
                    task: task.path,
                    pipeline: last?.pipeline_id,
                  }),
                )
              }
            >
              Run it again
            </button>
          ) : null}
        </div>

        {error ? (
          <p style={{ color: "var(--color-text-red)" }}>{error}</p>
        ) : null}
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && !task ? (
          <p className="muted">
            {taskId} is not in this project's tasks/ catalog.
          </p>
        ) : null}

        {task ? (
          <>
            <h3>Brief</h3>
            <p>{task.goal}</p>
            <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
              Pipeline
            </p>
            {last ? (
              <a
                href={`#${pipelinePath(last.pipeline_id)}`}
                style={{ fontWeight: 500 }}
              >
                {last.pipeline_id}
              </a>
            ) : (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No runs yet — pick a pipeline when you start one.
              </p>
            )}

            <h3 style={{ marginTop: "var(--spacing-6)" }}>Run history</h3>
            {runs.length === 0 ? (
              <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                No runs of this task yet.
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Status</th>
                    <th>Pipeline</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.run_id}>
                      <td>
                        <a href={`#${runStreamPath(run.run_id)}`}>
                          {run.run_id}
                        </a>
                      </td>
                      <td>
                        <StatusDot status={runDisplayStatus(run)} />
                      </td>
                      <td>
                        <a href={`#${pipelinePath(run.pipeline_id)}`}>
                          {run.pipeline_id}
                        </a>
                      </td>
                      <td className="muted">{relativeTime(run.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
    </div>
  );
}
