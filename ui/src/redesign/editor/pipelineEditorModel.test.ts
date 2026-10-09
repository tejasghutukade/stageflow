import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, DraftValidationResult } from "../../api";
import {
  editorTabSpecs,
  editorValidationPills,
  isDraftDirty,
  isEditorTabId,
  type EditorTabId,
} from "./pipelineEditorModel";

function draft(prompt: string): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-loop",
      stages: [{ id: "decide", system_prompt: prompt }],
    },
  };
}

function validation(
  ok: boolean,
  warnings: number,
): DraftValidationResult {
  return {
    scope: "full",
    ok,
    summary: { errors: ok ? 0 : 1, warnings },
    findings: [],
  };
}

describe("isDraftDirty", () => {
  it("is clean when draft matches baseline", () => {
    const baseline = draft("ship it");
    expect(isDraftDirty(draft("ship it"), baseline)).toBe(false);
  });

  it("is dirty when a prompt differs", () => {
    expect(isDraftDirty(draft("hold"), draft("ship it"))).toBe(true);
  });

  it("ignores object key order", () => {
    const baseline = draft("ship it");
    const reordered: DraftPackagePayload = {
      pipeline: {
        stages: [{ system_prompt: "ship it", id: "decide" }],
        id: "feature-loop",
      },
    };
    expect(isDraftDirty(reordered, baseline)).toBe(false);
  });

  it("is clean when draft or baseline is missing", () => {
    expect(isDraftDirty(null, draft("ship it"))).toBe(false);
    expect(isDraftDirty(draft("ship it"), null)).toBe(false);
  });
});

describe("editorValidationPills", () => {
  it("returns null before a validation result", () => {
    expect(editorValidationPills(null)).toBeNull();
  });

  it("labels a clean strict result and a zero warning count", () => {
    expect(editorValidationPills(validation(true, 0))).toEqual({
      strictLabel: "Valid · strict",
      strictSignal: "ok",
      warningLabel: "0 warnings",
      warningCount: 0,
      warningSignal: "ok",
    });
  });

  it("labels warnings with a singular or plural count", () => {
    expect(editorValidationPills(validation(true, 1))?.warningLabel).toBe(
      "1 warning",
    );
    expect(editorValidationPills(validation(true, 2))?.warningLabel).toBe(
      "2 warnings",
    );
    expect(editorValidationPills(validation(true, 2))?.warningSignal).toBe(
      "needs",
    );
  });

  it("labels an invalid strict result", () => {
    const pills = editorValidationPills(validation(false, 0));
    expect(pills?.strictLabel).toBe("Invalid · strict");
    expect(pills?.strictSignal).toBe("fail");
  });
});

describe("editor tabs", () => {
  it("accepts only editor, runs, and history", () => {
    const ids: EditorTabId[] = ["editor", "runs", "history"];
    for (const id of ids) expect(isEditorTabId(id)).toBe(true);
    expect(isEditorTabId("yaml")).toBe(false);
  });

  it("shows Runs with the real count and leaves History uncounted", () => {
    expect(editorTabSpecs(0)).toEqual([
      { id: "editor", label: "Editor" },
      { id: "runs", label: "Runs", count: 0 },
      { id: "history", label: "History" },
    ]);
  });
});
