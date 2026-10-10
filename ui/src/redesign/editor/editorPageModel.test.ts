import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, DraftValidationResult, ValidationFinding } from "../../api";
import { cloneDraft } from "./draftMutators";
import {
  EDITOR_INSPECTOR_MAX_WIDTH,
  EDITOR_INSPECTOR_MIN_WIDTH,
  EDITOR_YAML_MAX_WIDTH,
  EDITOR_YAML_MIN_WIDTH,
  clampEditorInspectorWidth,
  clampEditorYamlWidth,
  draftSchemaCount,
  editorDirtyPaths,
  editorFindingTarget,
  editorHeaderPills,
  editorPanelFindings,
  editorStageFindings,
  normalizeFindingPath,
  parseErrorFinding,
} from "./editorPageModel";
import type { EditorFinding } from "./editorProblemsModel";

const PIPELINE = "pipelines/feature-ship.pipeline.yaml";
const STAGE = "pipelines/stages/implement.yaml";

function draft(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      stages: [
        { id: "implement", uses: "./stages/implement.yaml" },
        { id: "review", needs: ["implement"] },
      ],
    },
    stages: [{ path: STAGE, body: { id: "implement", system_prompt: "Build it" } }],
  };
}

function finding(overrides: Partial<ValidationFinding>): ValidationFinding {
  return {
    severity: "warning",
    code: "rule/x",
    path: PIPELINE,
    message: "Something",
    category: "stage",
    ...overrides,
  };
}

describe("normalizeFindingPath", () => {
  it("maps suffix and basename matches to the editor's own paths", () => {
    expect(normalizeFindingPath("/abs/repo/pipelines/feature-ship.pipeline.yaml", PIPELINE, [STAGE])).toBe(
      PIPELINE,
    );
    expect(normalizeFindingPath("feature-ship.pipeline.yaml", PIPELINE, [STAGE])).toBe(PIPELINE);
    expect(normalizeFindingPath("other/implement.yaml", PIPELINE, [STAGE])).toBe(STAGE);
    expect(normalizeFindingPath("stageflow.yaml", PIPELINE, [STAGE])).toBe("stageflow.yaml");
  });
});

describe("editorPanelFindings", () => {
  it("puts the parse error first, backend next, info hints last, with normalized paths", () => {
    const rows = editorPanelFindings(
      draft(),
      PIPELINE,
      [finding({ path: "feature-ship.pipeline.yaml", stageId: "review", line: 7 })],
      { path: STAGE, message: "Bad indent", line: 3, column: 2 },
    );
    expect(rows[0]).toMatchObject({
      severity: "error",
      code: "yaml/parse",
      category: "yaml",
      path: STAGE,
      line: 3,
      column: 2,
    });
    expect(rows[1]).toMatchObject({ path: PIPELINE, line: 7, stageId: "review" });
    expect(rows.slice(2).every((row) => row.severity === "info")).toBe(true);
  });

  it("resolves a line for backend findings without one", () => {
    const rows = editorPanelFindings(
      draft(),
      PIPELINE,
      [finding({ path: "/x/feature-ship.pipeline.yaml", stageId: "review" })],
      null,
    );
    expect(rows[0]!.path).toBe(PIPELINE);
    expect(typeof rows[0]!.line).toBe("number");
  });
});

describe("parseErrorFinding", () => {
  it("builds a yaml/parse error finding", () => {
    expect(parseErrorFinding({ path: PIPELINE, message: "oops", line: 2, column: 5 })).toEqual({
      severity: "error",
      code: "yaml/parse",
      category: "yaml",
      path: PIPELINE,
      message: "oops",
      line: 2,
      column: 5,
    });
  });
});

describe("editorDirtyPaths", () => {
  it("is empty when nothing changed", () => {
    const base = draft();
    expect(editorDirtyPaths(cloneDraft(base), base, PIPELINE).size).toBe(0);
  });

  it("flags the pipeline file and changed or added stage files", () => {
    const base = draft();
    const next = cloneDraft(base);
    next.pipeline.stages.push({ id: "ship", needs: ["review"] });
    next.stages![0]!.body = { id: "implement", system_prompt: "Build it well" };
    next.stages!.push({ path: "pipelines/stages/ship.yaml", body: { id: "ship" } });
    expect([...editorDirtyPaths(next, base, PIPELINE)].sort()).toEqual(
      [PIPELINE, STAGE, "pipelines/stages/ship.yaml"].sort(),
    );
  });

  it("is empty without a baseline", () => {
    expect(editorDirtyPaths(draft(), null, PIPELINE).size).toBe(0);
  });
});

describe("editorStageFindings", () => {
  it("prefers errors over warnings and ignores info", () => {
    const rows: EditorFinding[] = [
      { ...finding({ stageId: "a" }) },
      { ...finding({ stageId: "a", severity: "error" }) },
      { ...finding({ stageId: "a" }) },
      { ...finding({ stageId: "b" }) },
      { ...finding({ stageId: "c" }), severity: "info" },
      { ...finding({}) },
    ];
    expect([...editorStageFindings(rows)]).toEqual([
      ["a", "error"],
      ["b", "warning"],
    ]);
  });
});

describe("editorFindingTarget", () => {
  it("falls back to the finding stage id without a field", () => {
    const target = editorFindingTarget(
      { ...finding({ stageId: "review", code: "graph/needs" }), severity: "info" },
      draft(),
    );
    expect(target?.stageId).toBe("review");
  });

  it("returns null when no stage is involved", () => {
    expect(editorFindingTarget({ ...finding({ code: "graph/parallel" }), severity: "info" }, draft())).toBeNull();
  });
});

describe("editorHeaderPills", () => {
  const result: DraftValidationResult = {
    scope: "full",
    ok: true,
    summary: { errors: 0, warnings: 2 },
    findings: [],
  };

  it("passes validation through without a parse error", () => {
    expect(editorHeaderPills(result, false)).toMatchObject({ strictOk: true, errorCount: 0 });
    expect(editorHeaderPills(null, false)).toBeNull();
  });

  it("counts the parse error as an extra error", () => {
    expect(editorHeaderPills(result, true)).toMatchObject({
      strictOk: false,
      errorCount: 1,
      strictLabel: "1 error",
      warningCount: 2,
    });
    expect(editorHeaderPills(null, true)).toMatchObject({ strictOk: false, errorCount: 1 });
  });
});

describe("draftSchemaCount", () => {
  it("counts schema keys when schemas is an object", () => {
    const next = draft();
    expect(draftSchemaCount(next)).toBe(0);
    next.pipeline.schemas = { a: {}, b: {} };
    expect(draftSchemaCount(next)).toBe(2);
    expect(draftSchemaCount(null)).toBe(0);
  });
});

describe("editor column width clamps", () => {
  it("clamps yaml width to the allowed range", () => {
    expect(clampEditorYamlWidth(EDITOR_YAML_MIN_WIDTH - 40)).toBe(EDITOR_YAML_MIN_WIDTH);
    expect(clampEditorYamlWidth(EDITOR_YAML_MAX_WIDTH + 40)).toBe(EDITOR_YAML_MAX_WIDTH);
    expect(clampEditorYamlWidth(500)).toBe(500);
  });

  it("clamps inspector width to the allowed range", () => {
    expect(clampEditorInspectorWidth(EDITOR_INSPECTOR_MIN_WIDTH - 40)).toBe(
      EDITOR_INSPECTOR_MIN_WIDTH,
    );
    expect(clampEditorInspectorWidth(EDITOR_INSPECTOR_MAX_WIDTH + 40)).toBe(
      EDITOR_INSPECTOR_MAX_WIDTH,
    );
    expect(clampEditorInspectorWidth(320)).toBe(320);
  });
});
