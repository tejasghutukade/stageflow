import { describe, expect, it } from "vitest";
import type {
  DraftPackagePayload,
  DraftValidationResult,
} from "../../api";
import { headerPills, unsavedChangeCount } from "./editorHeaderModel";

function draft(
  pipelinePrompt: string,
  stages?: DraftPackagePayload["stages"],
): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      stages: [{ id: "decide", system_prompt: pipelinePrompt }],
    },
    ...(stages !== undefined ? { stages } : {}),
  };
}

function validation(
  errors: number,
  warnings: number,
): DraftValidationResult {
  return {
    scope: "full",
    ok: errors === 0,
    summary: { errors, warnings },
    findings: [],
  };
}

describe("unsavedChangeCount", () => {
  it("returns zero when draft matches baseline", () => {
    const baseline = draft("ship it");
    expect(unsavedChangeCount(draft("ship it"), baseline)).toBe(0);
  });

  it("returns zero when draft or baseline is missing", () => {
    expect(unsavedChangeCount(null, draft("x"))).toBe(0);
    expect(unsavedChangeCount(draft("x"), null)).toBe(0);
  });

  it("counts one when the pipeline document changes", () => {
    const baseline = draft("ship it");
    expect(unsavedChangeCount(draft("hold"), baseline)).toBe(1);
  });

  it("ignores pipeline key order when comparing the pipeline document", () => {
    const baseline = draft("ship it");
    const reordered: DraftPackagePayload = {
      pipeline: {
        stages: [{ system_prompt: "ship it", id: "decide" }],
        id: "feature-ship",
      },
    };
    expect(unsavedChangeCount(reordered, baseline)).toBe(0);
  });

  it("counts each changed stage file separately", () => {
    const baseline = draft("same", [
      { path: "stages/a.yaml", body: { id: "a" } },
      { path: "stages/b.yaml", body: { id: "b" } },
    ]);
    const next = draft("same", [
      { path: "stages/a.yaml", body: { id: "a", skill: "lint" } },
      { path: "stages/b.yaml", body: { id: "b" } },
    ]);
    expect(unsavedChangeCount(next, baseline)).toBe(1);
  });

  it("counts added and removed stage files", () => {
    const baseline = draft("same", [
      { path: "stages/a.yaml", body: { id: "a" } },
    ]);
    const added = draft("same", [
      { path: "stages/a.yaml", body: { id: "a" } },
      { path: "stages/b.yaml", body: { id: "b" } },
    ]);
    expect(unsavedChangeCount(added, baseline)).toBe(1);

    const removed = draft("same", []);
    expect(unsavedChangeCount(removed, baseline)).toBe(1);
  });

  it("sums pipeline and stage file changes", () => {
    const baseline = draft("same", [
      { path: "stages/a.yaml", body: { id: "a" } },
    ]);
    const next = draft("changed", [
      { path: "stages/a.yaml", body: { id: "a", model: "gpt" } },
    ]);
    expect(unsavedChangeCount(next, baseline)).toBe(2);
  });
});

describe("headerPills", () => {
  it("returns null before a validation result", () => {
    expect(headerPills(null)).toBeNull();
  });

  it("labels a clean strict result with zero errors", () => {
    expect(headerPills(validation(0, 0))).toEqual({
      strictLabel: "Valid · strict",
      strictOk: true,
      warningLabel: "0 warnings",
      warningCount: 0,
      errorCount: 0,
    });
  });

  it("labels errors with singular or plural counts", () => {
    expect(headerPills(validation(1, 0))).toMatchObject({
      strictLabel: "1 error",
      strictOk: false,
      errorCount: 1,
    });
    expect(headerPills(validation(2, 0))?.strictLabel).toBe("2 errors");
  });

  it("labels warnings with singular or plural counts", () => {
    expect(headerPills(validation(0, 1))?.warningLabel).toBe("1 warning");
    expect(headerPills(validation(0, 2))?.warningLabel).toBe("2 warnings");
  });
});
