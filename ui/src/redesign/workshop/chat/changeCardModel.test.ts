import { describe, expect, it } from "vitest";
import {
  askToChangePrefill,
  changeFileRows,
  changeTotals,
  modelTail,
  proposalChangeSummary,
  stageLabelFromPath,
  toolResultView,
} from "./changeCardModel";

const draft = (ids: string[]) => ({
  pipeline: { id: "p", stages: ids.map((id) => ({ id })) },
});

describe("changeFileRows", () => {
  it("computes per-file and total line counts", () => {
    const rows = changeFileRows([
      { path: "stages/security-scan.yaml", kind: "added", after: "a\nb\nc" },
      { path: "stages/review.yaml", kind: "modified", before: "a\nb", after: "a\nc\nd" },
    ]);
    expect(rows.map((row) => row.diff.totals)).toEqual([
      { added: 3, removed: 0 },
      { added: 2, removed: 1 },
    ]);
    expect(changeTotals(rows)).toEqual({ added: 5, removed: 1 });
    expect(changeFileRows(undefined)).toEqual([]);
  });
});

describe("proposalChangeSummary", () => {
  it("summarizes stage files, a task, and affected stages", () => {
    const summary = proposalChangeSummary({
      artifacts: [
        { path: "csv-export-ship.pipeline.yaml", kind: "modified", before: "a", after: "b" },
        { path: "stages/csv-review.yaml", kind: "added", after: "x" },
        { path: "add-csv-export.task.yaml", kind: "added", after: "t" },
      ],
      affectedStageIds: ["csv-review", "implement"],
      baseDraft: draft(["implement"]),
      nextDraft: draft(["implement", "csv-review"]),
    });
    expect(summary.line).toBe("+ csv-review · ~ implement · + task");
    expect(summary.countLine).toBe("2 stages · 3 files");
    expect(summary.stageCount).toBe(2);
  });

  it("detects added and removed inline stages from the drafts", () => {
    const summary = proposalChangeSummary({
      artifacts: [{ path: "p.pipeline.yaml", kind: "modified", before: "a", after: "b" }],
      affectedStageIds: ["new-one", "old-one"],
      baseDraft: draft(["old-one"]),
      nextDraft: draft(["new-one"]),
    });
    expect(summary.line).toBe("+ new-one · − old-one");
    expect(summary.countLine).toBe("2 stages · 1 file");
  });

  it("falls back to the pipeline when no stage is named", () => {
    const summary = proposalChangeSummary({
      artifacts: [{ path: "p.pipeline.yaml", kind: "modified", before: "a", after: "b" }],
      affectedStageIds: [],
    });
    expect(summary.line).toBe("~ pipeline");
    expect(summary.countLine).toBe("0 stages · 1 file");
  });

  it("derives stage labels from paths", () => {
    expect(stageLabelFromPath("stages/review.yaml")).toBe("review");
    expect(stageLabelFromPath("./a/b/plan.stage.yml")).toBe("plan");
  });
});

describe("toolResultView", () => {
  it("maps statuses to the can tool-row results", () => {
    expect(toolResultView({ name: "edit_stage", status: "complete" })).toEqual({
      tone: "applied",
      label: "applied",
    });
    expect(toolResultView({ name: "read_draft", status: "complete" })).toEqual({
      tone: "done",
      label: "done",
    });
    expect(toolResultView({ name: "validate_draft", status: "error", errorMessage: "1 error" })).toEqual({
      tone: "error",
      label: "1 error",
    });
    expect(toolResultView({ name: "validate_draft", status: "error" }).label).toBe("error");
    expect(toolResultView({ name: "edit_stage", status: "running" }).tone).toBe("running");
  });
});

describe("small helpers", () => {
  it("builds the Ask to change prefill", () => {
    expect(askToChangePrefill("Add security scan")).toBe('Change to "Add security scan": ');
    expect(askToChangePrefill("  ")).toBe("Change this: ");
  });

  it("shortens model ids", () => {
    expect(modelTail("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelTail("openrouter/x/y:free")).toBe("y");
  });
});
