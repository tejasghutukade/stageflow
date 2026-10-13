import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, DraftValidationResult, ValidationFinding } from "../../../api";
import {
  canSave,
  fallbackRows,
  footerHint,
  pipelineIdHint,
  planRows,
  planSummary,
  unrewrittenStagesFootnote,
  validationView,
  type DraftPlanResult,
} from "./savePlanView";

const draft: DraftPackagePayload = {
  pipeline: {
    id: "csv-export-ship",
    stages: [
      { id: "plan", uses: "./stages/plan.yaml" },
      { id: "implement", uses: "stages/implement.yaml" },
      { id: "csv-review", uses: "stages/csv-review.yaml" },
      { id: "ship", uses: "stages/ship.yaml" },
    ],
  },
  stages: [
    { path: "stages/plan.yaml", body: { id: "plan" } },
    { path: "stages/implement.yaml", body: { id: "implement" } },
    { path: "stages/csv-review.yaml", body: { id: "csv-review" } },
  ],
  task: { filename: "add-csv-export.yaml", body: { id: "add-csv-export" } },
};

const plan: DraftPlanResult = {
  pipelinePath: "pipelines/csv-export-ship.yaml",
  directory: "pipelines",
  pipelineIdTaken: false,
  files: [
    { path: "pipelines/csv-export-ship.yaml", kind: "pipeline", action: "new", added: 20, removed: 0 },
    { path: "pipelines/stages/plan.yaml", kind: "stage", action: "unchanged", added: 0, removed: 0 },
    { path: "pipelines/stages/implement.yaml", kind: "stage", action: "overwrite", added: 6, removed: 2 },
    { path: "pipelines/stages/csv-review.yaml", kind: "stage", action: "new", added: 12, removed: 0 },
    { path: "pipelines/add-csv-export.yaml", kind: "task", action: "new", added: 4, removed: 0 },
  ],
};

function finding(partial: Partial<ValidationFinding>): ValidationFinding {
  return {
    severity: "error",
    code: "pipeline.invalid_verify",
    path: "csv-export-ship.pipeline.yaml",
    message: "command is empty",
    category: "pipeline",
    ...partial,
  };
}

function validation(findings: ValidationFinding[]): DraftValidationResult {
  return {
    scope: "pipeline",
    ok: !findings.some((f) => f.severity === "error"),
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    },
    findings,
  };
}

describe("planSummary", () => {
  it("counts new, overwrite, and skipped files", () => {
    expect(planSummary(plan)).toBe("3 new · 1 overwrite · 1 skipped");
  });

  it("omits zero buckets", () => {
    expect(planSummary({ ...plan, files: plan.files.slice(0, 1) })).toBe("1 new");
    expect(planSummary({ ...plan, files: [] })).toBe("nothing to write");
  });
});

describe("planRows", () => {
  it("builds per-file statuses, diffs, and the task row", () => {
    const rows = planRows(plan, draft, []);
    expect(rows.map((r) => [r.statusLabel, r.statusPill, r.muted])).toEqual([
      ["new", true, false],
      ["exists · unchanged, skipped", false, true],
      ["exists · will overwrite", true, false],
      ["new", true, false],
      ["new", true, false],
    ]);
    expect(rows[2]).toMatchObject({ added: 6, removed: 2 });
    expect(rows.map((r) => r.taskAttached)).toEqual([false, false, false, false, true]);
  });

  it("marks errors on the file that owns the finding", () => {
    const rows = planRows(plan, draft, [
      finding({ stageId: "csv-review", path: "csv-export-ship.pipeline.yaml" }),
      finding({ path: "stages/implement.yaml", code: "stage.invalid_io" }),
      finding({ code: "pipeline.dag_error" }),
      finding({ code: "task.invalid_shape", path: "elsewhere.yaml" }),
      finding({ severity: "warning", stageId: "plan" }),
    ]);
    expect(rows.map((r) => r.errorLabel)).toEqual([
      "1 error",
      null,
      "1 error",
      "1 error",
      "1 error",
    ]);
  });
});

describe("fallbackRows", () => {
  it("lists draft paths without actions", () => {
    const rows = fallbackRows(draft, "./pipelines/", "csv-export-ship", []);
    expect(rows.map((r) => r.path)).toEqual([
      "pipelines/csv-export-ship.yaml",
      "pipelines/stages/plan.yaml",
      "pipelines/stages/implement.yaml",
      "pipelines/stages/csv-review.yaml",
      "pipelines/add-csv-export.yaml",
    ]);
    expect(rows.every((r) => r.action === null && r.statusLabel === null)).toBe(true);
    expect(rows[4].taskAttached).toBe(true);
  });
});

describe("pipelineIdHint", () => {
  const base = { pipelineId: "csv-export-ship", initialPipelineId: "csv-export-ship", planLoading: false };

  it("says the id is free or taken", () => {
    expect(pipelineIdHint({ ...base, mode: "create", plan })).toEqual({ text: "id is free", tone: "muted" });
    expect(
      pipelineIdHint({ ...base, mode: "create", plan: { ...plan, pipelineIdTaken: true } }),
    ).toEqual({ text: "id already exists", tone: "warn" });
  });

  it("treats the saved id as an overwrite in overwrite mode", () => {
    expect(
      pipelineIdHint({ ...base, mode: "overwrite", plan: { ...plan, pipelineIdTaken: true } }),
    ).toEqual({ text: "overwrites saved pipeline", tone: "muted" });
  });

  it("handles empty, invalid, loading, and unknown states", () => {
    expect(pipelineIdHint({ ...base, pipelineId: " ", mode: "create", plan })?.text).toBe("id required");
    expect(pipelineIdHint({ ...base, pipelineId: "a b", mode: "create", plan })?.text).toBe("invalid id");
    expect(pipelineIdHint({ ...base, planLoading: true, mode: "create", plan: null })?.text).toBe("checking…");
    expect(pipelineIdHint({ ...base, mode: "create", plan: null })).toBeNull();
  });
});

describe("unrewrittenStagesFootnote", () => {
  it("names referenced stages that are not in the draft", () => {
    expect(unrewrittenStagesFootnote(draft)).toBe(
      "ship references the existing stages/ship.yaml and is not rewritten.",
    );
  });

  it("joins several and returns null when none", () => {
    const many: DraftPackagePayload = { ...draft, stages: [] };
    expect(unrewrittenStagesFootnote(many)).toBe(
      "plan, implement, csv-review and ship reference existing stage files and are not rewritten.",
    );
    expect(unrewrittenStagesFootnote({ pipeline: { id: "x", stages: [{ id: "a" }] } })).toBeNull();
  });
});

describe("validation gating", () => {
  it("summarizes failed and passed validation", () => {
    const failed = validationView(validation([finding({ stageId: "csv-review" })]));
    expect(failed).toMatchObject({ status: "failed", title: "Validation failed · 1 error", errors: 1 });
    if (failed.status === "failed") expect(failed.lines[0].location).toBe("csv-review.verify");
    expect(validationView(validation([finding({ severity: "warning" })]))).toMatchObject({
      status: "passed",
      title: "Validation passed · 1 warning",
    });
    expect(validationView(null)).toEqual({ status: "none" });
  });

  it("blocks save on errors unless overridden", () => {
    const failed = validationView(validation([finding({})]));
    expect(canSave({ validation: failed, allowInvalid: false, saving: false, pipelineId: "x" })).toBe(false);
    expect(canSave({ validation: failed, allowInvalid: true, saving: false, pipelineId: "x" })).toBe(true);
    expect(canSave({ validation: failed, allowInvalid: true, saving: true, pipelineId: "x" })).toBe(false);
    expect(canSave({ validation: { status: "none" }, allowInvalid: false, saving: false, pipelineId: "" })).toBe(false);
  });

  it("explains the footer state", () => {
    const failed = validationView(validation([finding({})]));
    expect(footerHint({ validation: failed, allowInvalid: false, plan })).toBe(
      "Fix the error or check Save invalid anyway",
    );
    expect(footerHint({ validation: failed, allowInvalid: true, plan })).toBe("Saving with 1 error");
    expect(footerHint({ validation: validationView(validation([])), allowInvalid: false, plan })).toBe(
      "Writes 4 files",
    );
  });
});
