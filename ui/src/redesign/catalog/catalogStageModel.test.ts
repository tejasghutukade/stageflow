import { describe, expect, it } from "vitest";
import type { PipelineListing, RunSummary } from "../../api";
import {
  avgCellLabel,
  filterStageRows,
  gateChipSummary,
  groupStageRows,
  latestRunForPipeline,
  orderedRowKeys,
  passPercentLabel,
  pipelineDirectoryOptions,
  promptTokenHint,
  readStageYaml,
  recentStageStats,
  runStatusPill,
  skillStripEntries,
  stepSelection,
  validateNewStage,
  newStageFormFrom,
} from "./catalogStageModel";
import { stagesFromPipelines, type StageRowFromPipelines } from "./stagesFromPipelines";

function row(
  id: string,
  usedBy: string[],
  extra: Partial<StageRowFromPipelines> = {},
): StageRowFromPipelines {
  return { rowKey: `:${id}`, id, used_by_pipeline_ids: usedBy, ...extra };
}

function run(partial: Partial<RunSummary>): RunSummary {
  return {
    run_id: "r",
    pipeline_id: "p",
    status: "succeeded",
    created_at: "2026-10-01T00:00:00.000Z",
    stages: [],
    ...partial,
  };
}

describe("stagesFromPipelines merge", () => {
  it("unions pipelines and prefers non-empty model, skill and uses_path", () => {
    const pipelines = [
      {
        path: "pipelines/a.pipeline.yaml",
        id: "pipe-a",
        stages: [{ id: "review", model: "" }],
      },
      {
        path: "pipelines/b.pipeline.yaml",
        id: "pipe-b",
        stages: [
          {
            id: "review",
            uses_path: "stages/review.yaml",
            model: "openai/gpt-5.2",
            skill: "code-review",
          },
        ],
      },
      {
        path: "pipelines/c.pipeline.yaml",
        id: "pipe-a",
        stages: [{ id: "review", skill: "other" }],
      },
    ] as unknown as PipelineListing[];
    const [merged] = stagesFromPipelines(pipelines);
    expect(merged?.used_by_pipeline_ids).toEqual(["pipe-a", "pipe-b"]);
    expect(merged?.model).toBe("openai/gpt-5.2");
    expect(merged?.skill).toBe("code-review");
    expect(merged?.uses_path).toBe("stages/review.yaml");
  });

  it("keeps stages from different project roots apart", () => {
    const pipelines: PipelineListing[] = [
      { path: "a", id: "a", project_root: "/x", stages: [{ id: "s" }] },
      { path: "b", id: "b", project_root: "/y", stages: [{ id: "s" }] },
    ];
    expect(stagesFromPipelines(pipelines).map((r) => r.rowKey)).toEqual([
      "/x:s",
      "/y:s",
    ]);
  });
});

describe("gateChipSummary", () => {
  it("returns no chip without gates", () => {
    expect(gateChipSummary(undefined)).toEqual({ first: null, extra: 0 });
    expect(gateChipSummary([])).toEqual({ first: null, extra: 0 });
  });

  it("returns the first gate and the overflow count", () => {
    expect(gateChipSummary(["confirm"])).toEqual({ first: "confirm", extra: 0 });
    expect(gateChipSummary(["confirm", "artifact_backed", "free_text"])).toEqual({
      first: "confirm",
      extra: 2,
    });
  });
});

describe("passPercentLabel and avgCellLabel", () => {
  it("rounds pass rate to a percent", () => {
    expect(passPercentLabel(0.944)).toBe("94%");
    expect(passPercentLabel(1)).toBe("100%");
    expect(passPercentLabel(undefined)).toBe("—");
  });

  it("formats avg cell from duration and cost", () => {
    expect(avgCellLabel(undefined)).toBe("no runs");
    expect(avgCellLabel({ runs: 0 })).toBe("no runs");
    expect(avgCellLabel({ runs: 3, avgMs: 252_000, avgCostUsd: 0.2234 })).toBe(
      "4m 12s · $0.22",
    );
    expect(avgCellLabel({ runs: 3, avgMs: 48_000 })).toBe("48s");
    expect(avgCellLabel({ runs: 3, avgCostUsd: 0.1 })).toBe("$0.10");
    expect(avgCellLabel({ runs: 3 })).toBe("no runs");
  });
});

describe("groupStageRows", () => {
  it("sorts in-use stages by pipeline count then id, and splits unused", () => {
    const groups = groupStageRows([
      row("plan", ["a", "b"]),
      row("ship", ["a"]),
      row("review", ["a", "b", "c"]),
      row("implement", ["a", "b"]),
      row("security-scan", []),
    ]);
    expect(groups.inUse.map((r) => r.id)).toEqual([
      "review",
      "implement",
      "plan",
      "ship",
    ]);
    expect(groups.unused.map((r) => r.id)).toEqual(["security-scan"]);
    expect(orderedRowKeys(groups)).toEqual([
      ":review",
      ":implement",
      ":plan",
      ":ship",
      ":security-scan",
    ]);
  });
});

describe("filterStageRows", () => {
  const rows = [
    row("review", ["feature-ship"], { model: "anthropic/claude", skill: "code-review" }),
    row("plan", ["bugfix-loop"], { model: "openai/gpt-5.2" }),
  ];

  it("matches id, model, skill, and pipeline ids case-insensitively", () => {
    expect(filterStageRows(rows, "REV").map((r) => r.id)).toEqual(["review"]);
    expect(filterStageRows(rows, "gpt").map((r) => r.id)).toEqual(["plan"]);
    expect(filterStageRows(rows, "code-review").map((r) => r.id)).toEqual(["review"]);
    expect(filterStageRows(rows, "bugfix").map((r) => r.id)).toEqual(["plan"]);
    expect(filterStageRows(rows, "  ").length).toBe(2);
    expect(filterStageRows(rows, "nope")).toEqual([]);
  });
});

describe("stepSelection", () => {
  it("clamps within the ordered keys", () => {
    expect(stepSelection([], null, 1)).toBeNull();
    expect(stepSelection(["a", "b"], null, 1)).toBe("a");
    expect(stepSelection(["a", "b"], "a", 1)).toBe("b");
    expect(stepSelection(["a", "b"], "b", 1)).toBe("b");
    expect(stepSelection(["a", "b"], "a", -1)).toBe("a");
  });
});

describe("runs helpers", () => {
  it("picks the latest run per pipeline and maps its pill", () => {
    const runs = [
      run({ run_id: "1", created_at: "2026-10-01T00:00:00Z", status: "failed" }),
      run({ run_id: "2", created_at: "2026-10-02T00:00:00Z", status: "running" }),
      run({ run_id: "3", pipeline_id: "other", created_at: "2026-10-03T00:00:00Z" }),
    ];
    const latest = latestRunForPipeline(runs, "p");
    expect(latest?.run_id).toBe("2");
    expect(runStatusPill(latest)?.label).toBe("Running");
    expect(runStatusPill(run({ waiting_stage_id: "x", status: "running" }))?.label).toBe(
      "Needs you",
    );
    expect(runStatusPill(null)).toBeNull();
  });

  it("counts recent runs that include the stage", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    const runs = [
      run({
        created_at: "2026-10-05T00:00:00Z",
        stages: [{ id: "review", status: "succeeded", attempt_count: 1, cost_usd: 0.2 }],
      }),
      run({
        created_at: "2026-10-06T00:00:00Z",
        stages: [{ id: "review", status: "failed", attempt_count: 1 }],
      }),
      run({
        created_at: "2026-08-01T00:00:00Z",
        stages: [{ id: "review", status: "succeeded", attempt_count: 1 }],
      }),
      run({ pipeline_id: "x", stages: [{ id: "review", status: "succeeded", attempt_count: 1 }] }),
      run({ created_at: "2026-10-07T00:00:00Z", stages: [{ id: "plan", status: "succeeded", attempt_count: 1 }] }),
    ];
    const recent = recentStageStats(runs, "review", ["p"], now);
    expect(recent.runs).toBe(2);
    expect(recent.stats?.passRate).toBe(0.5);
    expect(recent.stats?.avgCostUsd).toBe(0.2);
    expect(recent.stats?.avgMs).toBeUndefined();
  });
});

describe("readStageYaml", () => {
  it("reads system_prompt and schema ref", () => {
    const info = readStageYaml(
      "id: review\nsystem_prompt: |\n  Line one\n  Line two\nio:\n  output:\n    schema:\n      $ref: schemas/review.json\n",
    );
    expect(info.systemPrompt).toBe("Line one\nLine two\n");
    expect(info.payloadSchema).toBe("schemas/review.json");
  });

  it("reports inline and none schemas without inventing names", () => {
    expect(readStageYaml("id: a\nio:\n  output:\n    schema:\n      type: object\n").payloadSchema).toBe(
      "inline",
    );
    const none = readStageYaml("id: a\n");
    expect(none).toEqual({ systemPrompt: null, payloadSchema: "none" });
    expect(readStageYaml(":\n  - [").systemPrompt).toBeNull();
  });

  it("formats token hint", () => {
    expect(promptTokenHint("x".repeat(4961))).toBe("1,241 tok");
  });
});

describe("skillStripEntries", () => {
  it("lists skills used by visible stages only", () => {
    const skills = [
      { name: "code-review" },
      { name: "unused-skill" },
      { name: "test-writer" },
    ] as never[];
    const entries = skillStripEntries(
      skills,
      { usages: { "code-review": { stage_ids: ["review"], pipeline_ids: ["p"] } } },
      [row("review", ["p"]), row("test", ["p"], { skill: "test-writer" })],
    );
    expect(entries).toEqual([
      { name: "code-review", stageId: "review" },
      { name: "test-writer", stageId: "test" },
    ]);
  });
});

describe("new stage form", () => {
  it("validates required fields and kebab-case id", () => {
    const form = newStageFormFrom({ id: "Bad_Id" });
    expect(form.filename).toBe("Bad_Id.yaml");
    const errors = validateNewStage(form);
    expect(errors.id).toBe("id must be lowercase kebab-case");
    expect(errors.directory).toBeDefined();
    expect(errors.systemPrompt).toBeDefined();
    expect(
      validateNewStage({
        ...newStageFormFrom({ id: "review-copy", systemPrompt: "x" }),
        directoryKey: "k",
      }),
    ).toEqual({});
  });

  it("dedupes pipeline directories per project root", () => {
    const options = pipelineDirectoryOptions([
      { path: "pipelines/a.pipeline.yaml", id: "a", stages: [] },
      { path: "pipelines/b.pipeline.yaml", id: "b", stages: [] },
      { path: "pipelines/c.pipeline.yaml", id: "c", project_root: "/r", stages: [] },
    ]);
    expect(options.map((o) => [o.directory, o.project_root])).toEqual([
      ["pipelines", undefined],
      ["pipelines", "/r"],
    ]);
  });
});
