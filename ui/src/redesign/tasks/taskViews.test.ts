import { describe, expect, it } from "vitest";
import {
  buildTaskRowViews,
  filterRowViewsByTab,
  filterTasksBySearch,
  filterTasksByTab,
  projectRootsMatch,
  runHistorySegments,
  runMatchesTask,
  shortRunId,
  sortTasksByAttention,
  taskCheckoutView,
  taskFolderLabel,
  taskLastRunKind,
  taskPipelineFor,
  taskRootLabel,
  taskRunCount,
  taskRowKey,
  validationStatusLabel,
} from "./taskViews";
import type { PipelineListing, TaskListing } from "../../api";

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

  it("filters failing by latest run only", () => {
    expect(filterTasksByTab(tasks, snapshot, "failing")).toEqual([]);
    expect(filterTasksByTab(tasks, snapshot, "has_failed_run").some((t) => t.id === "hello")).toBe(
      true,
    );
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

describe("needs-attention sort", () => {
  const run = (
    run_id: string,
    task: string,
    status: "running" | "queued" | "succeeded" | "failed" | "cancelled",
    created_at: string,
    extra: Record<string, unknown> = {},
  ) => ({
    run_id,
    pipeline_id: "p",
    task_id: task,
    task_path: `tasks/${task}.yaml`,
    status,
    created_at,
    stages: [],
    ...extra,
  });
  const listing = (id: string): TaskListing => ({ id, path: `tasks/${id}.yaml`, goal: id });
  const sortTasks = [
    "zz-never",
    "aa-never",
    "done-old",
    "done-new",
    "cancelled",
    "running",
    "queued",
    "failed",
    "waiting",
  ].map(listing);
  const sortSnapshot = {
    health: null,
    runs: [
      run("w1", "waiting", "running", "2026-01-01T00:00:00Z", { waiting_stage_id: "review" }),
      run("f1", "failed", "failed", "2026-01-02T00:00:00Z"),
      run("r1", "running", "running", "2026-01-03T00:00:00Z"),
      run("q1", "queued", "queued", "2026-01-04T00:00:00Z"),
      run("s1", "done-old", "succeeded", "2026-01-05T00:00:00Z"),
      run("s2", "done-new", "succeeded", "2026-01-06T00:00:00Z"),
      run("c1", "cancelled", "cancelled", "2026-01-07T00:00:00Z"),
      run("f0", "waiting", "failed", "2025-12-01T00:00:00Z"),
    ],
  };

  it("orders by waiting, failed, running/queued, succeeded, cancelled, never run", () => {
    expect(sortTasksByAttention(sortTasks, sortSnapshot).map((t) => t.id)).toEqual([
      "waiting",
      "failed",
      "queued",
      "running",
      "done-new",
      "done-old",
      "cancelled",
      "aa-never",
      "zz-never",
    ]);
  });

  it("classifies the latest run", () => {
    expect(taskLastRunKind(undefined)).toBe("none");
    expect(taskLastRunKind(sortSnapshot.runs[0])).toBe("waiting");
    expect(taskLastRunKind(sortSnapshot.runs[3])).toBe("running");
    expect(taskLastRunKind(sortSnapshot.runs[6])).toBe("cancelled");
  });

  it("builds row views with failing and gate filters", () => {
    const rows = buildTaskRowViews(sortTasks, sortSnapshot, []);
    expect(filterRowViewsByTab(rows, "failing").map((r) => r.task.id)).toEqual(["failed"]);
    expect(filterRowViewsByTab(rows, "has_open_gate").map((r) => r.task.id)).toEqual(["waiting"]);
    expect(filterRowViewsByTab(rows, "no_runs").map((r) => r.task.id)).toEqual([
      "aa-never",
      "zz-never",
    ]);
  });
});

describe("taskPipelineFor", () => {
  const pipelines: PipelineListing[] = [
    { id: "zeta", path: "examples/flow/zeta.pipeline.yaml", stages: [] },
    { id: "alpha", path: "examples/flow/alpha.pipeline.yaml", stages: [] },
    { id: "other", path: "examples/other/other.pipeline.yaml", stages: [] },
    { id: "ship", path: "pipelines/ship.pipeline.yaml", stages: [] },
  ];
  const task: TaskListing = { id: "t", path: "examples/flow/t.task.yaml", goal: "g" };

  it("uses the last run pipeline and its listing path", () => {
    const last = {
      run_id: "r",
      pipeline_id: "ship",
      status: "succeeded" as const,
      created_at: "2026-01-01T00:00:00Z",
      stages: [],
    };
    expect(taskPipelineFor(task, last, pipelines)).toEqual({
      id: "ship",
      path: "pipelines/ship.pipeline.yaml",
    });
    expect(taskPipelineFor(task, { ...last, pipeline_id: "gone" }, pipelines)).toEqual({
      id: "gone",
    });
  });

  it("falls back to the first pipeline by id in the task directory", () => {
    expect(taskPipelineFor(task, undefined, pipelines)).toEqual({
      id: "alpha",
      path: "examples/flow/alpha.pipeline.yaml",
    });
  });

  it("never invents a pipeline", () => {
    expect(
      taskPipelineFor({ id: "x", path: "tasks/x.yaml", goal: "g" }, undefined, pipelines),
    ).toBeNull();
  });
});

describe("task inspector helpers", () => {
  it("folder label uses a shared parent or says multiple folders", () => {
    expect(
      taskFolderLabel([
        { id: "a", path: "examples/flow/a.yaml", goal: "" },
        { id: "b", path: "examples/flow/b.yaml", goal: "" },
      ]),
    ).toBe("examples/flow/");
    expect(
      taskFolderLabel([
        { id: "a", path: "x/a.yaml", goal: "" },
        { id: "b", path: "y/b.yaml", goal: "" },
      ]),
    ).toBe("multiple folders");
  });

  it("searches id and goal case-insensitively", () => {
    const list: TaskListing[] = [
      { id: "Fix-Login", path: "a.yaml", goal: "OAuth" },
      { id: "other", path: "b.yaml", goal: "Rate LIMIT api" },
    ];
    expect(filterTasksBySearch(list, "login").map((t) => t.id)).toEqual(["Fix-Login"]);
    expect(filterTasksBySearch(list, "limit").map((t) => t.id)).toEqual(["other"]);
  });

  it("summarizes run history and omits zero segments", () => {
    const base = { pipeline_id: "p", status: "succeeded" as const, stages: [] };
    expect(
      runHistorySegments([
        { ...base, run_id: "a", created_at: "1", total_cost_usd: 1.5 },
        { ...base, run_id: "b", created_at: "2", waiting_stage_id: "g", total_cost_usd: 0.25 },
      ]).map((s) => s.text),
    ).toEqual(["2 runs", "$1.75", "1 open gate"]);
    expect(
      runHistorySegments([{ ...base, run_id: "a", created_at: "1" }]).map((s) => s.text),
    ).toEqual(["1 run"]);
  });

  it("builds the checkout chip without inventing a base branch", () => {
    expect(taskCheckoutView({})).toBeNull();
    expect(taskCheckoutView({ checkout: "../repo" })).toEqual({ target: "../repo" });
    expect(taskCheckoutView({ repository: "o/r", ref: "dev" })).toEqual({
      target: "dev",
      repository: "o/r",
    });
    expect(taskCheckoutView({ repository: "o/r" })).toEqual({ repository: "o/r" });
  });

  it("shortens long run ids", () => {
    expect(shortRunId("run_abc")).toBe("run_abc");
    expect(shortRunId("20260101-123456-7f3a9c")).toBe("run_7f3a9c");
  });

  it("labels validation status", () => {
    const ok = { scope: "full" as const, ok: true, summary: { errors: 0, warnings: 0 }, findings: [] };
    const now = Date.parse("2026-01-01T00:10:00Z");
    expect(validationStatusLabel(ok, "2026-01-01T00:09:50Z", now)).toBe("validated just now");
    expect(validationStatusLabel(ok, "2026-01-01T00:05:00Z", now)).toBe("validated 5m ago");
    expect(
      validationStatusLabel({ ...ok, ok: false, summary: { errors: 2, warnings: 0 } }, "x", now),
    ).toBe("2 errors");
    expect(validationStatusLabel(null, null, now)).toBeNull();
  });
});
