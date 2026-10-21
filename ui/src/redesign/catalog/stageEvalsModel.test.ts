import { describe, expect, it } from "vitest";
import type { EvalListItem, PipelineListing } from "../../api";
import {
  STAGE_EVALS_GUIDANCE,
  buildStageEvalsModel,
  evaluateHref,
  stageEvalRow,
  stageEvalsQueries,
} from "./stageEvalsModel";
import type { StageRowFromPipelines } from "./stagesFromPipelines";

const NOW = Date.parse("2026-10-21T12:00:00Z");

const pipelines: PipelineListing[] = [
  { path: "pipelines/a.pipeline.yaml", id: "a", stages: [{ id: "review", uses_path: "stages/review.stage.yaml" }] },
  { path: "pipelines/b.pipeline.yaml", id: "b", stages: [{ id: "review", uses_path: "stages/review.stage.yaml" }] },
];

function row(extra: Partial<StageRowFromPipelines> = {}): StageRowFromPipelines {
  return {
    rowKey: ":review",
    id: "review",
    uses_path: "stages/review.stage.yaml",
    used_by_pipeline_ids: ["a", "b"],
    ...extra,
  };
}

function item(id: string, extra: Partial<EvalListItem> = {}): EvalListItem {
  return {
    id,
    name: id,
    description: null,
    type: "capability",
    path: `evals/${id}.eval.yaml`,
    target: { kind: "stage", pipeline_path: "pipelines/a.pipeline.yaml", stage_id: "review", label: "a · review" },
    dataset_path: "d.dataset.jsonl",
    dataset_cases: 12,
    repeats: 1,
    grader_count: 1,
    rubric_count: 0,
    valid: true,
    finding_count: 0,
    status: "passing",
    last_run: null,
    last_run_delta_pts: null,
    trend: [],
    ...extra,
  };
}

describe("stageEvalsQueries", () => {
  it("one query per pipeline plus one for the stage file", () => {
    const queries = stageEvalsQueries(row(), pipelines);
    expect(queries.map((q) => q.label)).toEqual(["a", "b", "review.stage.yaml"]);
    expect(queries[0].query).toEqual({ target_pipeline: "pipelines/a.pipeline.yaml", target_stage: "review" });
    expect(queries[2].query).toEqual({ target_file: "stages/review.stage.yaml" });
  });

  it("inline stages have no file query and carry project_root", () => {
    const queries = stageEvalsQueries(row({ uses_path: undefined, project_root: "/p" }), pipelines.map((p) => ({ ...p, project_root: "/p" })));
    expect(queries).toHaveLength(2);
    expect(queries[0].query.project_root).toBe("/p");
  });
});

describe("stageEvalRow", () => {
  it("shows never run when there is no finished run", () => {
    const r = stageEvalRow(item("e1"), NOW);
    expect(r.meta).toBe("12 cases · never run");
    expect(r.passRateLabel).toBeNull();
    expect(r.href).toBe("/evals/e1");
  });

  it("shows relative time and pass rate", () => {
    const r = stageEvalRow(
      item("e1", {
        dataset_cases: 1,
        last_run: {
          eval_run_id: "r",
          eval_id: "e1",
          run_number: 2,
          status: "completed",
          passed: true,
          pass_rate: 0.9,
          pass_rate_ci: null,
          results_executed: 1,
          cost_total: 0,
          finished_at: "2026-10-21T10:00:00Z",
          fingerprint: "f",
          label: null,
        },
      }),
      NOW,
    );
    expect(r.meta).toMatch(/^1 case · last run /);
    expect(r.meta).not.toContain("never");
    expect(r.passRateLabel).toBe("90.0%");
  });
});

describe("evaluateHref", () => {
  const r = row();
  it("zero evals goes to the wizard preselected for the stage", () => {
    expect(evaluateHref(r, "pipelines/a.pipeline.yaml", [])).toBe(
      "/evals/new?pipeline=pipelines%2Fa.pipeline.yaml&stage=review",
    );
  });
  it("zero evals without a pipeline falls back to the file", () => {
    expect(evaluateHref(r, undefined, [])).toBe("/evals/new?file=stages%2Freview.stage.yaml");
  });
  it("one eval opens its run dialog", () => {
    expect(evaluateHref(r, undefined, ["e1"])).toBe("/evals/e1?openRun=1");
  });
  it("two or more go to the filtered list", () => {
    expect(evaluateHref(r, undefined, ["e1", "e2"])).toBe("/evals?stage=review");
  });
});

describe("buildStageEvalsModel", () => {
  const queries = stageEvalsQueries(row(), pipelines);

  it("empty state has no sections and no guidance", () => {
    const m = buildStageEvalsModel(row(), pipelines, queries.map((query) => ({ query, items: [] })), NOW);
    expect(m.total).toBe(0);
    expect(m.sections).toEqual([]);
    expect(m.guidance).toBeNull();
    expect(m.evaluateHref).toBe(m.newEvalHref);
  });

  it("two evals in separate pipelines list per pipeline and Evaluate opens the list", () => {
    const m = buildStageEvalsModel(
      row(),
      pipelines,
      [
        { query: queries[0], items: [item("e1")] },
        { query: queries[1], items: [item("e2")] },
        { query: queries[2], items: [] },
      ],
      NOW,
    );
    expect(m.total).toBe(2);
    expect(m.sections.map((s) => s.label)).toEqual(["a", "b"]);
    expect(m.guidance).toBe(STAGE_EVALS_GUIDANCE);
    expect(m.evaluateHref).toBe("/evals?stage=review");
  });

  it("the same eval in two sections counts once", () => {
    const m = buildStageEvalsModel(
      row(),
      pipelines,
      [
        { query: queries[0], items: [item("e1")] },
        { query: queries[1], items: [item("e1")] },
      ],
      NOW,
    );
    expect(m.total).toBe(1);
    expect(m.evaluateHref).toBe("/evals/e1?openRun=1");
  });
});
