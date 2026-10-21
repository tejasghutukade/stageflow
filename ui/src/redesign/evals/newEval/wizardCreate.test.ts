import { describe, expect, it, vi } from "vitest";
import { createFromDraft, datasetInput } from "./wizardCreate";
import {
  addGrader,
  datasetFromConfirm,
  datasetFromRuns,
  datasetFromSample,
  initialDraft,
  withTarget,
  DEFAULT_DIRS,
  type WizardDraft,
  type WizardTarget,
} from "./wizardModel";

const target: WizardTarget = { kind: "pipeline", stageId: "review", pipelinePath: "p/a.pipeline.yaml", projectRoot: "/root", label: "" };

function draft(): WizardDraft {
  let d = withTarget(initialDraft(), target, null, []);
  d = { ...d, dataset: datasetFromConfirm({ cases: [{ input: { a: 1 } }], ready: 1, skipped: 0, fileName: "x.jsonl" }, "upload", "review", []) };
  return addGrader(d, "schema");
}

describe("createFromDraft", () => {
  it("writes the dataset first, then the eval", async () => {
    const order: string[] = [];
    const out = await createFromDraft(draft(), DEFAULT_DIRS, {
      createDataset: vi.fn(async () => void order.push("dataset")),
      createEval: vi.fn(async () => {
        order.push("eval");
        return { id: "review-eval" };
      }),
    });
    expect(order).toEqual(["dataset", "eval"]);
    expect(out).toEqual({ ok: true, evalId: "review-eval" });
  });
  it("keeps the dataset and says so when the eval write fails", async () => {
    const out = await createFromDraft(draft(), DEFAULT_DIRS, {
      createDataset: vi.fn(async () => undefined),
      createEval: vi.fn(async () => {
        throw new Error("Eval definition is invalid");
      }),
    });
    expect(out).toEqual({
      ok: false,
      datasetWritten: true,
      message: "The dataset was saved to datasets/x.dataset.jsonl, but the eval could not be created: Eval definition is invalid",
    });
  });
  it("does not write the eval when the dataset write fails", async () => {
    const createEval = vi.fn();
    const out = await createFromDraft(draft(), DEFAULT_DIRS, {
      createDataset: vi.fn(async () => {
        throw new Error("exists");
      }),
      createEval,
    });
    expect(out.ok).toBe(false);
    expect(createEval).not.toHaveBeenCalled();
  });
  it("skips the dataset write on retry", async () => {
    const createDataset = vi.fn();
    await createFromDraft(draft(), DEFAULT_DIRS, { createDataset, createEval: async () => ({ id: "x" }) }, { datasetAlreadyWritten: true });
    expect(createDataset).not.toHaveBeenCalled();
  });
  it("refuses an incomplete draft without calling the API", async () => {
    const createDataset = vi.fn();
    const out = await createFromDraft(initialDraft(), DEFAULT_DIRS, { createDataset, createEval: vi.fn() });
    expect(out.ok).toBe(false);
    expect(createDataset).not.toHaveBeenCalled();
  });
});

describe("datasetInput", () => {
  it("maps each source to its endpoint shape", () => {
    const d = draft();
    expect(datasetInput(d, DEFAULT_DIRS)).toEqual({ name: "x", directory: "datasets", project_root: "/root", cases: [{ input: { a: 1 } }] });
    const sample = { ...d, dataset: datasetFromSample("review", []) };
    expect(datasetInput(sample, DEFAULT_DIRS)).toMatchObject({ source: "sample", target: { pipeline_path: "p/a.pipeline.yaml", stage_id: "review" } });
    const runs = { ...d, dataset: datasetFromRuns(["r1", "r2"], ["a", "b"], "review", []) };
    expect(datasetInput(runs, DEFAULT_DIRS)).toMatchObject({ source: "runs", run_ids: ["r1", "r2"], name: "review-cases" });
  });
});
