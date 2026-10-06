import { describe, expect, it } from "vitest";
import {
  filterTasksByTab,
  projectRootsMatch,
  runMatchesTask,
  taskRootLabel,
  taskRunCount,
  taskRowKey,
} from "./taskViews";
import type { TaskListing } from "../../api";

const tasks: TaskListing[] = [
  { path: "tasks/a.yaml", id: "a", goal: "A" },
  { path: "tasks/b.yaml", id: "b", goal: "B" },
  {
    path: "examples/tasks/a.yaml",
    id: "a",
    goal: "A copy",
    project_root: "/repo/examples",
  },
  {
    path: "tasks/my-task.task.yaml",
    id: "my-task",
    goal: "My task",
    project_root: "/repo/main",
  },
  {
    path: "tasks/hello.task.yaml",
    id: "hello",
    goal: "Hello",
    project_root: "/repo/main",
  },
  {
    path: "examples/hello-world/my-task.task.yaml",
    id: "my-task",
    goal: "Hello world task",
    project_root: "examples",
  },
];

const snapshot = {
  runs: [
    {
      run_id: "r1",
      pipeline_id: "p",
      task_id: "a",
      task_path: "tasks/a.yaml",
      status: "succeeded" as const,
      created_at: "2026-01-01T00:00:00Z",
      stages: [],
    },
    {
      run_id: "r2",
      pipeline_id: "p",
      task_id: "a",
      task_path: "examples/tasks/a.yaml",
      project_root: "/repo/examples",
      waiting_stage_id: "gate",
      status: "running" as const,
      created_at: "2026-01-02T00:00:00Z",
      stages: [],
    },
    {
      run_id: "r3",
      pipeline_id: "pipe",
      task_id: "my-task.task.yaml",
      project_root: "/repo/main",
      status: "succeeded" as const,
      created_at: "2026-01-03T00:00:00Z",
      stages: [],
    },
    {
      run_id: "r4",
      pipeline_id: "pipe",
      task_id: "tasks/hello.task.yaml",
      task_path: "tasks/hello.task.yaml",
      project_root: "/repo/main",
      status: "failed" as const,
      created_at: "2026-01-04T00:00:00Z",
      stages: [],
    },
    {
      run_id: "r5",
      pipeline_id: "pipe",
      task_id: "examples/hello-world/my-task.task.yaml",
      task_path: "examples/hello-world/my-task.task.yaml",
      project_root: "/abs/examples",
      status: "succeeded" as const,
      created_at: "2026-01-05T00:00:00Z",
      stages: [],
    },
    {
      run_id: "r6",
      pipeline_id: "pipe",
      task_id: "hello",
      task_path: "/repo/main/tasks/hello.task.yaml",
      project_root: "/repo/main",
      status: "succeeded" as const,
      created_at: "2026-01-06T00:00:00Z",
      stages: [],
    },
  ],
  health: null,
};

describe("taskViews", () => {
  it("uses stable row keys across duplicate ids", () => {
    expect(taskRowKey(tasks[0]!)).not.toBe(taskRowKey(tasks[2]!));
  });

  it("matches runs with absolute task_path under project_root", () => {
    const hello = {
      path: "tasks/hello.task.yaml",
      id: "hello",
      goal: "Hello",
      project_root: "/repo/main",
    } satisfies TaskListing;
    expect(
      snapshot.runs.filter((run) => runMatchesTask(run, hello)).map((r) => r.run_id),
    ).toEqual(["r4", "r6"]);
  });

  it("matches runs with file-like task ids", () => {
    const myTask = tasks[3]!;
    const hello = tasks[4]!;
    const helloWorld = tasks[5]!;
    expect(
      snapshot.runs.filter((run) => runMatchesTask(run, myTask)).map((r) => r.run_id),
    ).toEqual(["r3"]);
    expect(
      snapshot.runs.filter((run) => runMatchesTask(run, hello)).map((r) => r.run_id),
    ).toEqual(["r4", "r6"]);
    expect(
      snapshot.runs.filter((run) => runMatchesTask(run, helloWorld)).map((r) => r.run_id),
    ).toEqual(["r5"]);
  });

  it("matches seeded project_root to absolute run root", () => {
    expect(projectRootsMatch("examples", "/abs/examples")).toBe(true);
    expect(projectRootsMatch("/repo/main", "/other/root")).toBe(false);
  });

  it("filters tabs", () => {
    expect(filterTasksByTab(tasks, snapshot, "all")).toHaveLength(6);
    expect(filterTasksByTab(tasks, snapshot, "no_runs").map((t) => t.path)).toEqual([
      "tasks/b.yaml",
    ]);
    expect(
      filterTasksByTab(tasks, snapshot, "has_open_gate").length,
    ).toBeGreaterThan(0);
    expect(
      filterTasksByTab(tasks, snapshot, "has_failed_run").some((t) => t.id === "hello"),
    ).toBe(true);
  });

  it("counts runs per task listing", () => {
    expect(taskRunCount(snapshot, tasks[0]!)).toBe(1);
    expect(taskRunCount(snapshot, tasks[1]!)).toBe(0);
    expect(taskRunCount(snapshot, tasks[3]!)).toBe(1);
    expect(taskRunCount(snapshot, tasks[4]!)).toBe(2);
  });

  it("derives human root labels from catalog paths", () => {
    expect(
      taskRootLabel({
        path: "examples/hello-world/my-task.task.yaml",
        id: "my-task",
        goal: "g",
        project_root: "examples",
      }),
    ).toBe("examples/hello-world");
    expect(
      taskRootLabel({
        path: "tasks/foo.yaml",
        id: "foo",
        goal: "g",
        project_root: "/Users/me/worktrees/68d4",
      }),
    ).toBe("tasks");
  });
});
