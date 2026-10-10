import { describe, expect, it } from "vitest";
import type { PipelineListing, RunSummary, TaskListing } from "../../api";
import { buildPipelineListView, pipelineRowKey } from "./pipelineViews";

function pipeline(
  partial: Partial<PipelineListing> & Pick<PipelineListing, "path" | "id">,
): PipelineListing {
  return {
    stages: [],
    ...partial,
  };
}

function run(
  partial: Partial<RunSummary> &
    Pick<RunSummary, "run_id" | "pipeline_id" | "created_at">,
): RunSummary {
  return {
    status: "succeeded",
    stages: [],
    ...partial,
  };
}

function row(
  view: ReturnType<typeof buildPipelineListView>,
  id: string,
  path?: string,
) {
  const found = view.rows.find(
    (item) =>
      item.pipeline.id === id && (path === undefined || item.pipeline.path === path),
  );
  if (!found) throw new Error(`missing row ${id} ${path ?? ""}`);
  return found;
}

describe("pipelineViews", () => {
  it("keys rows by path, project root, and id", () => {
    const alpha = pipeline({
      path: "examples/alpha/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "examples",
    });
    const beta = pipeline({
      path: "examples/beta/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "/abs/beta",
    });
    const unrooted = pipeline({
      path: "pipelines/solo.pipeline.yaml",
      id: "solo",
    });
    expect(pipelineRowKey(alpha)).toBe(
      "examples/alpha/fork-demo.pipeline.yaml:examples:fork-demo",
    );
    expect(pipelineRowKey(beta)).toBe(
      "examples/beta/fork-demo.pipeline.yaml:/abs/beta:fork-demo",
    );
    expect(pipelineRowKey(unrooted)).toBe("pipelines/solo.pipeline.yaml::solo");
    expect(pipelineRowKey(alpha)).not.toBe(pipelineRowKey(beta));
  });

  it("matches an absolute run path to the catalog-relative listing", () => {
    const listing = pipeline({
      path: "pipelines/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "examples",
      stages: [{ id: "plan" }],
    });
    const view = buildPipelineListView({
      pipelines: [listing],
      runs: [
        run({
          run_id: "abs",
          pipeline_id: "not-the-listing-id",
          pipeline_path: "/repo/pipelines/fork-demo.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-02-01T00:00:00.000Z",
        }),
      ],
    });
    expect(row(view, "fork-demo").stats.runCount).toBe(1);
    expect(row(view, "fork-demo").stats.lastRun?.run_id).toBe("abs");
  });

  it("gives fork-demo listings with different paths their own run counts", () => {
    const alpha = pipeline({
      path: "examples/alpha/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "examples",
    });
    const beta = pipeline({
      path: "examples/beta/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "/abs/beta",
    });
    const view = buildPipelineListView({
      pipelines: [alpha, beta],
      runs: [
        run({
          run_id: "a1",
          pipeline_id: "fork-demo",
          pipeline_path: "/work/examples/examples/alpha/fork-demo.pipeline.yaml",
          project_root: "/work/examples",
          created_at: "2026-03-01T00:00:00.000Z",
        }),
        run({
          run_id: "a2",
          pipeline_id: "fork-demo",
          pipeline_path: "/work/examples/examples/alpha/fork-demo.pipeline.yaml",
          project_root: "/work/examples",
          created_at: "2026-03-02T00:00:00.000Z",
        }),
        run({
          run_id: "b1",
          pipeline_id: "fork-demo",
          pipeline_path: "/abs/beta/examples/beta/fork-demo.pipeline.yaml",
          project_root: "/abs/beta",
          created_at: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });
    expect(view.rows).toHaveLength(2);
    expect(row(view, "fork-demo", alpha.path).stats.runCount).toBe(2);
    expect(row(view, "fork-demo", beta.path).stats.runCount).toBe(1);
    expect(row(view, "fork-demo", alpha.path).key).not.toBe(
      row(view, "fork-demo", beta.path).key,
    );
  });

  it("disambiguates a shared relative path by project root", () => {
    const left = pipeline({
      path: "pipelines/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "/repo/a",
    });
    const right = pipeline({
      path: "pipelines/fork-demo.pipeline.yaml",
      id: "fork-demo",
      project_root: "/repo/b",
    });
    const view = buildPipelineListView({
      pipelines: [left, right],
      runs: [
        run({
          run_id: "left",
          pipeline_id: "fork-demo",
          pipeline_path: "/repo/a/pipelines/fork-demo.pipeline.yaml",
          project_root: "/repo/a",
          created_at: "2026-04-01T00:00:00.000Z",
        }),
        run({
          run_id: "right",
          pipeline_id: "fork-demo",
          pipeline_path: "/repo/b/pipelines/fork-demo.pipeline.yaml",
          project_root: "/repo/b",
          created_at: "2026-04-02T00:00:00.000Z",
        }),
        run({
          run_id: "neither",
          pipeline_id: "fork-demo",
          pipeline_path: "/repo/c/pipelines/fork-demo.pipeline.yaml",
          project_root: "/repo/c",
          created_at: "2026-04-03T00:00:00.000Z",
        }),
      ],
    });
    expect(row(view, "fork-demo", left.path).stats.runCount).toBe(1);
    expect(
      view.rows.find((item) => item.pipeline.project_root === "/repo/a")?.stats
        .lastRun?.run_id,
    ).toBe("left");
    expect(
      view.rows.find((item) => item.pipeline.project_root === "/repo/b")?.stats
        .lastRun?.run_id,
    ).toBe("right");
  });

  it("attaches an id-only run only when that id is unique", () => {
    const solo = pipeline({
      path: "pipelines/solo.pipeline.yaml",
      id: "solo",
    });
    const sharedA = pipeline({
      path: "pipelines/shared-a.pipeline.yaml",
      id: "shared",
      project_root: "/repo/a",
    });
    const sharedB = pipeline({
      path: "pipelines/shared-b.pipeline.yaml",
      id: "shared",
      project_root: "/repo/b",
    });
    const view = buildPipelineListView({
      pipelines: [solo, sharedA, sharedB],
      runs: [
        run({
          run_id: "solo-run",
          pipeline_id: "solo",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
        run({
          run_id: "shared-run",
          pipeline_id: "shared",
          created_at: "2026-01-02T00:00:00.000Z",
        }),
      ],
    });
    expect(row(view, "solo").stats.runCount).toBe(1);
    expect(row(view, "solo").stats.lastRun?.run_id).toBe("solo-run");
    expect(row(view, "shared", sharedA.path).stats.runCount).toBe(0);
    expect(row(view, "shared", sharedB.path).stats.runCount).toBe(0);
    expect(row(view, "shared", sharedA.path).stats.lastRun).toBeUndefined();
    expect(row(view, "shared", sharedB.path).stats.lastRun).toBeUndefined();
  });

  it("does not attach a pathed run by pipeline id when the path matches nothing", () => {
    const listing = pipeline({
      path: "pipelines/demo.pipeline.yaml",
      id: "demo",
    });
    const view = buildPipelineListView({
      pipelines: [listing],
      runs: [
        run({
          run_id: "miss",
          pipeline_id: "demo",
          pipeline_path: "/somewhere/else.yaml",
          project_root: "/somewhere",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(row(view, "demo").stats.runCount).toBe(0);
  });

  it("searches id, catalog path, stage id, and root basename", () => {
    const routed = pipeline({
      path: "pipelines/plain.pipeline.yaml",
      id: "plain",
      project_root: "/work/other",
      stages: [{ id: "route" }],
    });
    const dropped = pipeline({
      path: "pipelines/quiet.pipeline.yaml",
      id: "quiet",
      project_root: "/work/other",
      stages: [{ id: "plan" }, { id: "implement" }],
    });
    const named = pipeline({
      path: "pipelines/special-path.pipeline.yaml",
      id: "alpha",
      project_root: "/work/catalog-root-name",
      stages: [{ id: "plan" }],
    });
    const view = buildPipelineListView({
      pipelines: [routed, dropped, named],
      search: "route",
    });
    expect(view.filteredRows.map((item) => item.pipeline.id)).toEqual(["plain"]);
    expect(view.filteredCount).toBe(view.filteredRows.length);
    expect(view.filteredCount).toBe(1);

    const upper = buildPipelineListView({
      pipelines: [routed, dropped],
      search: "ROUTE",
    });
    expect(upper.filteredRows.map((item) => item.pipeline.id)).toEqual(["plain"]);

    expect(
      buildPipelineListView({
        pipelines: [routed, dropped, named],
        search: "alpha",
      }).filteredRows.map((item) => item.pipeline.id),
    ).toEqual(["alpha"]);
    expect(
      buildPipelineListView({
        pipelines: [routed, dropped, named],
        search: "special-path",
      }).filteredRows.map((item) => item.pipeline.id),
    ).toEqual(["alpha"]);
    expect(
      buildPipelineListView({
        pipelines: [routed, dropped, named],
        search: "catalog-root-name",
      }).filteredRows.map((item) => item.pipeline.id),
    ).toEqual(["alpha"]);
  });

  it("sorts by last run, id, and stage count", () => {
    const pipelines = [
      pipeline({
        path: "p/never.yaml",
        id: "aaa-never",
        stages: [{ id: "only" }],
      }),
      pipeline({
        path: "p/new.yaml",
        id: "zzz-new",
        stages: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      }),
      pipeline({
        path: "p/old.yaml",
        id: "mmm-old",
        stages: [{ id: "s1" }],
      }),
      pipeline({
        path: "p/tie-b.yaml",
        id: "tie-b",
        stages: [{ id: "s1" }, { id: "s2" }],
      }),
      pipeline({
        path: "p/tie-a.yaml",
        id: "tie-a",
        stages: [{ id: "s1" }, { id: "s2" }],
      }),
    ];
    const runs = [
      run({
        run_id: "new",
        pipeline_id: "zzz-new",
        pipeline_path: "/repo/p/new.yaml",
        project_root: "/repo",
        created_at: "2026-08-01T00:00:00.000Z",
      }),
      run({
        run_id: "old",
        pipeline_id: "mmm-old",
        pipeline_path: "/repo/p/old.yaml",
        project_root: "/repo",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      run({
        run_id: "tie-a",
        pipeline_id: "tie-a",
        pipeline_path: "/repo/p/tie-a.yaml",
        project_root: "/repo",
        created_at: "2026-04-01T00:00:00.000Z",
      }),
      run({
        run_id: "tie-b",
        pipeline_id: "tie-b",
        pipeline_path: "/repo/p/tie-b.yaml",
        project_root: "/repo",
        created_at: "2026-04-01T00:00:00.000Z",
      }),
    ];
    const ids = (sort: "last-run" | "id" | "stage-count") =>
      buildPipelineListView({ pipelines, runs, sort }).filteredRows.map(
        (item) => item.pipeline.id,
      );

    expect(ids("last-run")).toEqual([
      "zzz-new",
      "tie-a",
      "tie-b",
      "mmm-old",
      "aaa-never",
    ]);
    expect(ids("id")).toEqual([
      "aaa-never",
      "mmm-old",
      "tie-a",
      "tie-b",
      "zzz-new",
    ]);
    expect(ids("stage-count")).toEqual([
      "zzz-new",
      "tie-a",
      "tie-b",
      "aaa-never",
      "mmm-old",
    ]);
  });

  it("joins the stage chain and counts stages", () => {
    const view = buildPipelineListView({
      pipelines: [
        pipeline({
          path: "pipelines/loop.pipeline.yaml",
          id: "loop",
          stages: [{ id: "plan" }, { id: "implement" }],
        }),
      ],
    });
    const loop = row(view, "loop");
    expect(loop.stageChain).toBe("plan → implement");
    expect(loop.stageCount).toBe(2);
  });

  it("summarizes gates from raw kinds in stage order", () => {
    const mixed = pipeline({
      path: "pipelines/gated.pipeline.yaml",
      id: "gated",
      stages: [
        { id: "plan", gate_kinds: ["confirm"] },
        { id: "implement", gate_kinds: ["artifact_backed"] },
      ],
    });
    const open = pipeline({
      path: "pipelines/open.pipeline.yaml",
      id: "open",
      stages: [{ id: "plan" }, { id: "ship", gate_kinds: [] }],
    });
    const labeled = pipeline({
      path: "pipelines/labels.pipeline.yaml",
      id: "labels",
      stages: [
        {
          id: "ask",
          gate_kinds: [
            "free_text",
            "confirm",
            "multi_question",
            "artifact_backed",
          ],
        },
      ],
    });
    const view = buildPipelineListView({
      pipelines: [mixed, open, labeled],
    });
    expect(row(view, "gated").gateLabels).toEqual(["confirm", "artifact"]);
    expect(row(view, "gated").gates).toEqual({
      kind: "gates",
      firstLabel: "confirm",
      extraCount: 1,
    });
    expect(row(view, "open").gates).toEqual({ kind: "none" });
    expect(row(view, "open").gateLabels).toEqual([]);
    expect(row(view, "labels").gateLabels).toEqual([
      "free text",
      "confirm",
      "multi-question",
      "artifact",
    ]);
  });

  it("averages succeeded duration and cost without a run cap", () => {
    const mixedCost = pipeline({
      path: "pipelines/cost.pipeline.yaml",
      id: "cost",
    });
    const noCost = pipeline({
      path: "pipelines/duration-only.pipeline.yaml",
      id: "duration-only",
    });
    const drawing = pipeline({
      path: "pipelines/drawing.pipeline.yaml",
      id: "drawing",
    });
    const inspector = pipeline({
      path: "pipelines/inspector.pipeline.yaml",
      id: "inspector",
    });
    const updated = pipeline({
      path: "pipelines/updated.pipeline.yaml",
      id: "updated",
    });
    const noDuration = pipeline({
      path: "pipelines/no-duration.pipeline.yaml",
      id: "no-duration",
    });
    const idle = pipeline({
      path: "pipelines/idle.pipeline.yaml",
      id: "idle",
      stages: [{ id: "plan" }],
    });
    const many = pipeline({
      path: "pipelines/many.pipeline.yaml",
      id: "many",
    });

    const manyRuns = Array.from({ length: 21 }, (_, index) => {
      const newest = index < 20;
      const start = newest
        ? `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
        : "2026-01-01T00:00:00.000Z";
      const end = newest
        ? `2026-07-${String(index + 1).padStart(2, "0")}T00:02:00.000Z`
        : "2026-01-01T00:00:00.000Z";
      return run({
        run_id: `many-${index}`,
        pipeline_id: "many",
        pipeline_path: "/repo/pipelines/many.pipeline.yaml",
        project_root: "/repo",
        created_at: start,
        finished_at: end,
      });
    });

    const view = buildPipelineListView({
      pipelines: [
        mixedCost,
        noCost,
        drawing,
        inspector,
        updated,
        noDuration,
        idle,
        many,
      ],
      runs: [
        run({
          run_id: "cost-a",
          pipeline_id: "cost",
          pipeline_path: "/repo/pipelines/cost.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-01-01T00:00:00.000Z",
          finished_at: "2026-01-01T00:10:00.000Z",
        }),
        run({
          run_id: "cost-b",
          pipeline_id: "cost",
          pipeline_path: "/repo/pipelines/cost.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-01-02T00:00:00.000Z",
          finished_at: "2026-01-02T00:08:00.000Z",
          total_cost_usd: 2,
        }),
        run({
          run_id: "cost-failed",
          pipeline_id: "cost",
          pipeline_path: "/repo/pipelines/cost.pipeline.yaml",
          project_root: "/repo",
          status: "failed",
          created_at: "2026-01-03T00:00:00.000Z",
          finished_at: "2026-01-03T05:00:00.000Z",
          total_cost_usd: 100,
        }),
        run({
          run_id: "duration-only",
          pipeline_id: "duration-only",
          pipeline_path: "/repo/pipelines/duration-only.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-02-01T00:00:00.000Z",
          finished_at: "2026-02-01T00:18:00.000Z",
        }),
        run({
          run_id: "drawing",
          pipeline_id: "drawing",
          pipeline_path: "/repo/pipelines/drawing.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-03-01T00:00:00.000Z",
          finished_at: "2026-03-01T00:18:00.000Z",
          total_cost_usd: 1.04,
        }),
        run({
          run_id: "inspector",
          pipeline_id: "inspector",
          pipeline_path: "/repo/pipelines/inspector.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-04-01T00:00:00.000Z",
          finished_at: "2026-04-01T00:05:12.000Z",
          total_cost_usd: 0.19,
        }),
        run({
          run_id: "updated",
          pipeline_id: "updated",
          pipeline_path: "/repo/pipelines/updated.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:05:00.000Z",
          total_cost_usd: 0.001,
        }),
        run({
          run_id: "open-ended",
          pipeline_id: "no-duration",
          pipeline_path: "/repo/pipelines/no-duration.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-06-01T00:00:00.000Z",
        }),
        run({
          run_id: "ten-min",
          pipeline_id: "no-duration",
          pipeline_path: "/repo/pipelines/no-duration.pipeline.yaml",
          project_root: "/repo",
          created_at: "2026-06-02T00:00:00.000Z",
          finished_at: "2026-06-02T00:10:00.000Z",
        }),
        ...manyRuns,
      ],
    });

    const cost = row(view, "cost");
    expect(cost.stats.runCount).toBe(3);
    expect(cost.stats.runsLabel).toBe("3");
    expect(cost.stats.lastRun?.run_id).toBe("cost-failed");
    expect(cost.stats.avgDurationMs).toBe(9 * 60_000);
    expect(cost.stats.avgCostUsd).toBe(1);
    expect(cost.stats.tableAvg).toBe("9m · $1.00");
    expect(cost.stats.inspectorDuration).toBe("avg 9m");
    expect(cost.stats.inspectorCost).toBe("$1.00 / run");
    expect(cost.stats.neverRun).toBe(false);

    const durationOnly = row(view, "duration-only");
    expect(durationOnly.stats.avgCostUsd).toBeUndefined();
    expect(durationOnly.stats.tableAvg).toBe("18m");
    expect(durationOnly.stats.inspectorDuration).toBe("avg 18m");
    expect(durationOnly.stats.inspectorCost).toBeUndefined();

    expect(row(view, "drawing").stats.tableAvg).toBe("18m · $1.04");
    expect(row(view, "inspector").stats.inspectorDuration).toBe("avg 5m 12s");
    expect(row(view, "inspector").stats.inspectorCost).toBe("$0.19 / run");
    expect(row(view, "inspector").stats.tableAvg).toBe("5m 12s · $0.19");

    expect(row(view, "updated").stats.tableAvg).toBe("5m · <$0.01");
    expect(row(view, "updated").stats.inspectorCost).toBe("<$0.01 / run");

    const missingEnd = row(view, "no-duration");
    expect(missingEnd.stats.runCount).toBe(2);
    expect(missingEnd.stats.avgDurationMs).toBe(10 * 60_000);
    expect(missingEnd.stats.tableAvg).toBe("10m");

    const never = row(view, "idle");
    expect(never.stats.runCount).toBe(0);
    expect(never.stats.runsLabel).toBe("—");
    expect(never.stats.lastRun).toBeUndefined();
    expect(never.stats.neverRun).toBe(true);
    expect(never.stats.tableAvg).toBe("—");
    expect(never.stats.inspectorDuration).toBeUndefined();
    expect(never.stats.inspectorCost).toBeUndefined();
    expect(view.rows.some((item) => item.pipeline.id === "idle")).toBe(true);

    const capped = row(view, "many");
    expect(capped.stats.runCount).toBe(21);
    expect(capped.stats.avgDurationMs).toBe((20 * 2 * 60_000) / 21);
    expect(capped.stats.tableAvg).toBe("1m 54s");
  });

  it("lists tasks in the pipeline directory and defaults only a single match", () => {
    const loop = pipeline({
      path: "examples/feature-loop/feature.pipeline.yaml",
      id: "feature",
    });
    const alone = pipeline({
      path: "examples/hello/hello.pipeline.yaml",
      id: "hello",
    });
    const emptyDir = pipeline({
      path: "examples/empty/empty.pipeline.yaml",
      id: "empty",
    });
    const tasks: TaskListing[] = [
      {
        path: "examples/feature-loop/plan.task.yaml",
        id: "plan",
        goal: "Plan",
      },
      {
        path: "examples/feature-loop/implement.task.yaml",
        id: "implement",
        goal: "Implement",
      },
      {
        path: "examples/other/nope.task.yaml",
        id: "nope",
        goal: "Other directory",
      },
      {
        path: "examples/hello/hello.task.yaml",
        id: "hello-task",
        goal: "Hello",
      },
    ];
    const view = buildPipelineListView({
      pipelines: [loop, alone, emptyDir],
      tasks,
    });
    expect(row(view, "feature").tasks.map((task) => task.path)).toEqual([
      "examples/feature-loop/plan.task.yaml",
      "examples/feature-loop/implement.task.yaml",
    ]);
    expect(row(view, "feature").defaultTaskPath).toBeUndefined();
    expect(row(view, "hello").tasks.map((task) => task.id)).toEqual(["hello-task"]);
    expect(row(view, "hello").defaultTaskPath).toBe(
      "examples/hello/hello.task.yaml",
    );
    expect(row(view, "empty").tasks).toEqual([]);
    expect(row(view, "empty").defaultTaskPath).toBeUndefined();
  });

  it("shows catalog roots only when project roots differ", () => {
    const same = [
      pipeline({ path: "a.yaml", id: "a", project_root: "/repo" }),
      pipeline({ path: "b.yaml", id: "b", project_root: "/repo" }),
    ];
    const one = [pipeline({ path: "a.yaml", id: "a", project_root: "/repo" })];
    const missing = [
      pipeline({ path: "a.yaml", id: "a" }),
      pipeline({ path: "b.yaml", id: "b" }),
    ];
    const different = [
      pipeline({ path: "a.yaml", id: "a", project_root: "/repo" }),
      pipeline({ path: "b.yaml", id: "b", project_root: "/other" }),
    ];
    expect(buildPipelineListView({ pipelines: same }).catalogRootsVisible).toBe(
      false,
    );
    expect(buildPipelineListView({ pipelines: one }).catalogRootsVisible).toBe(
      false,
    );
    expect(
      buildPipelineListView({ pipelines: missing }).catalogRootsVisible,
    ).toBe(false);
    expect(
      buildPipelineListView({ pipelines: different }).catalogRootsVisible,
    ).toBe(true);
  });
});
