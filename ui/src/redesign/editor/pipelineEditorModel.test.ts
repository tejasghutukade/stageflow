import { describe, expect, it } from "vitest";
import type {
  DraftPackagePayload,
  DraftValidationResult,
  PipelineListing,
  ValidationFinding,
} from "../../api";
import {
  editorTabSpecs,
  editorValidationPills,
  filterEditorPipelineRuns,
  findingDedupeKey,
  focusEditorFinding,
  isDraftDirty,
  isEditorTabId,
  lastValidatedFooter,
  mergeEditorFindings,
  problemCounts,
  stageUsedByCount,
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

describe("stageUsedByCount", () => {
  const shared: PipelineListing[] = [
    {
      path: "pipelines/a.pipeline.yaml",
      id: "pipe-a",
      project_root: "/repo",
      stages: [
        { id: "lint", uses_path: "stages/lint.yaml" },
        { id: "ship" },
      ],
    },
    {
      path: "pipelines/b.pipeline.yaml",
      id: "pipe-b",
      project_root: "/repo",
      stages: [{ id: "review", uses_path: "./stages/lint.yaml" }],
    },
    {
      path: "pipelines/c.pipeline.yaml",
      id: "pipe-c",
      project_root: "/other",
      stages: [{ id: "lint", uses_path: "stages/lint.yaml" }],
    },
  ];

  it("returns null when the catalog list is absent", () => {
    expect(
      stageUsedByCount(null, { id: "lint", path: "stages/lint.yaml" }),
    ).toBeNull();
    expect(
      stageUsedByCount(undefined, { id: "lint", path: null }),
    ).toBeNull();
  });

  it("counts pipelines that list the same stage id or file in one project", () => {
    expect(
      stageUsedByCount(shared, {
        id: "lint",
        path: "stages/lint.yaml",
        projectRoot: "/repo",
      }),
    ).toBe(2);
    expect(
      stageUsedByCount(shared, {
        id: "ship",
        path: null,
        projectRoot: "/repo",
      }),
    ).toBe(1);
  });

  it("does not count the same stage id in a different project root", () => {
    expect(
      stageUsedByCount(shared, {
        id: "lint",
        path: "stages/lint.yaml",
        projectRoot: "/other",
      }),
    ).toBe(1);
  });
});

describe("filterEditorPipelineRuns", () => {
  const runs = [
    { run_id: "a", pipeline_id: "feature-loop", project_root: "/repo" },
    { run_id: "b", pipeline_id: "feature-loop", project_root: "/other" },
    { run_id: "c", pipeline_id: "other", project_root: "/repo" },
    { run_id: "d", pipeline_id: "feature-loop", project_root: "/repo/" },
    { run_id: "e", pipeline_id: "feature-loop", project_root: "\\repo" },
    { run_id: "f", pipeline_id: "solo" },
  ];

  it("keeps runs for this pipeline id and project root", () => {
    expect(
      filterEditorPipelineRuns(runs, {
        id: "feature-loop",
        project_root: "/repo",
      }).map((run) => run.run_id),
    ).toEqual(["a", "d", "e"]);
  });

  it("drops the same pipeline id in another project root", () => {
    expect(
      filterEditorPipelineRuns(runs, {
        id: "feature-loop",
        project_root: "/missing",
      }),
    ).toEqual([]);
  });

  it("matches when neither side has a project root", () => {
    expect(
      filterEditorPipelineRuns(runs, { id: "solo" }).map((run) => run.run_id),
    ).toEqual(["f"]);
  });

  it("does not match a rooted pipeline to a run with no root", () => {
    expect(
      filterEditorPipelineRuns(
        [{ run_id: "z", pipeline_id: "solo" }],
        { id: "solo", project_root: "/repo" },
      ),
    ).toEqual([]);
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

function finding(
  partial: Partial<ValidationFinding> & Pick<ValidationFinding, "code" | "message">,
): ValidationFinding {
  return {
    severity: "error",
    path: "pipelines/feature-ship.pipeline.yaml",
    category: "pipeline",
    ...partial,
  };
}

describe("mergeEditorFindings", () => {
  const draftError = finding({
    code: "stage.missing_model",
    path: "stages/plan.yaml",
    message: 'Stage "plan": model is required',
    category: "stage",
    stageId: "plan",
  });
  const catalogWarning = finding({
    severity: "warning",
    code: "pipeline.model_applies",
    path: "pipelines/feature-ship.pipeline.yaml",
    message: "model applies to every stage",
  });
  const catalogDuplicate = finding({
    ...draftError,
    severity: "warning",
  });

  it("keeps live draft findings and disk findings that are not the same problem", () => {
    expect(mergeEditorFindings([draftError], [catalogWarning])).toEqual([
      draftError,
      catalogWarning,
    ]);
  });

  it("drops a disk finding that matches a draft finding on code, path, and message", () => {
    expect(mergeEditorFindings([draftError], [catalogDuplicate, catalogWarning])).toEqual([
      draftError,
      catalogWarning,
    ]);
    expect(findingDedupeKey(draftError)).toBe(findingDedupeKey(catalogDuplicate));
  });

  it("does not invent info findings", () => {
    const merged = mergeEditorFindings([draftError], [catalogWarning]);
    expect(merged.map((row) => row.severity)).toEqual(["error", "warning"]);
    expect(problemCounts(merged)).toEqual({ errors: 1, warnings: 1 });
  });
});

describe("focusEditorFinding", () => {
  const draft: DraftPackagePayload = {
    pipeline: {
      id: "feature-ship",
      stages: [{ id: "plan", uses: "./stages/plan.yaml" }],
    },
    stages: [
      {
        path: "stages/plan.yaml",
        body: { id: "plan", system_prompt: "Plan it." },
      },
    ],
  };

  it("selects the stage field locateFindingField resolves", () => {
    expect(
      focusEditorFinding(
        finding({
          code: "stage.missing_model",
          path: "stages/plan.yaml",
          category: "stage",
          stageId: "plan",
          message: 'Stage "plan": model is required',
        }),
        draft,
      ),
    ).toEqual({ kind: "stage", stageId: "plan", field: "model" });
  });

  it("leaves pipeline and catalog findings that do not locate a stage on the row", () => {
    expect(
      focusEditorFinding(
        finding({
          code: "catalog.duplicate_pipeline_id",
          category: "catalog",
          message: "Duplicate pipeline id feature-ship",
        }),
        draft,
      ),
    ).toEqual({ kind: "row" });
  });
});

describe("lastValidatedFooter", () => {
  it("names strict validate and the client duration", () => {
    expect(lastValidatedFooter(null)).toBe(
      "Last validated · sf validate --strict · —",
    );
    expect(lastValidatedFooter(18.4)).toBe(
      "Last validated · sf validate --strict · 18ms",
    );
  });
});
