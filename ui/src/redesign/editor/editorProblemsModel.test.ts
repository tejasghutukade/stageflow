import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { draftFileYaml } from "./draftYaml";
import {
  editorFindingKey,
  editorInfoFindings,
  formatEditorLocation,
  formatRelativeAgo,
  quickFixLabel,
  resolveFindingLine,
  type EditorFinding,
} from "./editorProblemsModel";

const PIPELINE = "pipelines/feature-ship.pipeline.yaml";

function forkDraft(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      stages: [
        { id: "implement", uses: "./stages/implement.yaml" },
        { id: "review", needs: ["implement"] },
        { id: "test", needs: ["implement"] },
        { id: "ship", needs: ["review", "test"] },
      ],
    },
  };
}

function linesOf(draft: DraftPackagePayload, path: string): string[] {
  return draftFileYaml(draft, path, PIPELINE).split("\n");
}

describe("editorInfoFindings", () => {
  it("describes a fork/merge needs edge and the parallel lane", () => {
    const draft = forkDraft();
    const findings = editorInfoFindings(draft, PIPELINE);
    const lines = linesOf(draft, PIPELINE);

    expect(findings.map((finding) => finding.code)).toEqual(["graph/needs", "graph/parallel"]);
    expect(findings[0]).toMatchObject({
      severity: "info",
      category: "graph",
      stageId: "ship",
      path: PIPELINE,
      message: "ship needs [review, test]: ship runs only after both finish",
      line: 12,
    });
    expect(lines[11]).toMatch(/^\s*needs:/);
    expect(findings[1]).toMatchObject({
      severity: "info",
      category: "graph",
      path: PIPELINE,
      message: "review and test run in parallel and hold 2 agent slots at once",
      line: 5,
      lineEnd: 10,
    });
    expect(lines[4]).toContain("id: review");
    expect(lines[9]).toContain("implement");
    expect(lines[10]).toContain("id: ship");
  });

  it("uses all-finish and oxford-free names when more than two stages meet", () => {
    const draft: DraftPackagePayload = {
      pipeline: {
        id: "fan",
        stages: [
          { id: "a", entry: true, route: [{ to: "b" }, { to: "c" }, { to: "d" }] },
          { id: "b" },
          { id: "c" },
          { id: "d" },
          { id: "join", needs: ["b", "c", "d"] },
        ],
      },
    };
    const findings = editorInfoFindings(draft, PIPELINE);
    expect(findings.map((finding) => finding.message)).toEqual([
      "join needs [b, c, d]: join runs only after all 3 finish",
      "b, c and d run in parallel and hold 3 agent slots at once",
    ]);
    const parallel = findings[1]!;
    expect(parallel.line).toBeLessThan(parallel.lineEnd!);
  });

  it("skips loop nodes and does not treat a feedback chip as a parallel stage", () => {
    const draft: DraftPackagePayload = {
      pipeline: {
        id: "feature-loop",
        stages: [
          { id: "decompose", entry: true, route: [{ to: "feature-plan" }] },
          { id: "feature-plan", route: [{ to: "align" }] },
          { id: "align", route: [{ to: "feature-implement" }] },
          { id: "feature-implement", route: [{ to: "verify" }] },
          { id: "verify", route: [{ to: "feature-review" }] },
          { id: "feature-review", route: [{ to: "address-feedback" }] },
          {
            id: "address-feedback",
            route: [
              { to: "publish" },
              { type: "loop", to: "feature-review", max_replays: 2 },
            ],
          },
          { id: "publish" },
        ],
      },
    };
    expect(editorInfoFindings(draft, PIPELINE)).toEqual([]);
  });
});

describe("resolveFindingLine", () => {
  const draft: DraftPackagePayload = {
    pipeline: {
      id: "feature-ship",
      stages: [
        { id: "plan", uses: "./stages/plan.yaml" },
        { id: "implement", uses: "./stages/implement.yaml", model: "opus" },
      ],
    },
    stages: [
      {
        path: "stages/plan.yaml",
        body: { id: "plan", system_prompt: "Plan it.", model: "anthropic/claude" },
      },
    ],
  };

  function finding(
    partial: Partial<EditorFinding> & Pick<EditorFinding, "code" | "path" | "message">,
  ): EditorFinding {
    return {
      severity: "error",
      category: "stage",
      ...partial,
    };
  }

  it("resolves a stage-file finding to the field key line", () => {
    const resolved = resolveFindingLine(
      draft,
      PIPELINE,
      finding({
        code: "stage.missing_model",
        path: "stages/plan.yaml",
        stageId: "plan",
        message: 'Stage "plan": model is required',
      }),
    );
    const lines = linesOf(draft, "stages/plan.yaml");
    expect(resolved).toEqual({ path: "stages/plan.yaml", line: 3, column: 1 });
    expect(lines[2]).toMatch(/^model:/);
  });

  it("resolves a pipeline entry field and falls back to the stage entry line", () => {
    const onEntry = resolveFindingLine(
      draft,
      PIPELINE,
      finding({
        code: "stage.missing_model",
        path: PIPELINE,
        stageId: "implement",
        message: 'Stage "implement": model is required',
      }),
    );
    const lines = linesOf(draft, PIPELINE);
    expect(onEntry.line).toBe(7);
    expect(lines[onEntry.line! - 1]).toMatch(/^\s*model:/);

    const fallback = resolveFindingLine(
      draft,
      PIPELINE,
      finding({
        code: "stage.missing_model",
        path: PIPELINE,
        stageId: "plan",
        message: 'Stage "plan": model is required',
      }),
    );
    expect(fallback).toEqual({ path: PIPELINE, line: 3 });
    expect(lines[2]).toContain("id: plan");
  });

  it("keeps a backend line, range, and column", () => {
    expect(
      resolveFindingLine(
        draft,
        PIPELINE,
        finding({
          code: "stage.missing_model",
          path: "stages/plan.yaml",
          stageId: "plan",
          message: 'Stage "plan": model is required',
          line: 42,
          lineEnd: 44,
          column: 7,
        }),
      ),
    ).toEqual({ path: "stages/plan.yaml", line: 42, lineEnd: 44, column: 7 });
  });
});

describe("formatEditorLocation", () => {
  it("uses the file basename, a line, or an en-dash range", () => {
    expect(formatEditorLocation("pipelines/feature-ship.yaml")).toBe("feature-ship.yaml");
    expect(formatEditorLocation("pipelines/feature-ship.yaml", 12)).toBe("feature-ship.yaml:12");
    expect(formatEditorLocation("pipelines/feature-ship.yaml", 10, 14)).toBe(
      "feature-ship.yaml:10\u201314",
    );
    expect(formatEditorLocation("pipelines/feature-ship.yaml", 10, 10)).toBe("feature-ship.yaml:10");
    expect(formatEditorLocation("")).toBe("—");
  });
});

describe("formatRelativeAgo", () => {
  it("formats just now, seconds, and minutes", () => {
    expect(formatRelativeAgo(0)).toBe("just now");
    expect(formatRelativeAgo(1_500)).toBe("just now");
    expect(formatRelativeAgo(3_000)).toBe("3s ago");
    expect(formatRelativeAgo(2 * 60_000)).toBe("2m ago");
    expect(formatRelativeAgo(3_600_000)).toBe("1h ago");
    expect(formatRelativeAgo(2 * 86_400_000)).toBe("2d ago");
  });
});

describe("quickFixLabel", () => {
  const draft = forkDraft();

  it("names the stage field focusEditorFinding resolves", () => {
    const draftWithModel: DraftPackagePayload = {
      ...forkDraft(),
      stages: [{ path: "stages/plan.yaml", body: { id: "plan", model: "opus" } }],
      pipeline: {
        id: "feature-ship",
        stages: [{ id: "plan", uses: "./stages/plan.yaml" }],
      },
    };
    expect(
      quickFixLabel(
        {
          severity: "error",
          code: "stage.missing_model",
          path: "stages/plan.yaml",
          message: 'Stage "plan": model is required',
          category: "stage",
          stageId: "plan",
        },
        draftWithModel,
      ),
    ).toBe("Go to model in plan");
  });

  it("is empty when the finding does not focus a stage", () => {
    expect(
      quickFixLabel(
        {
          severity: "warning",
          code: "catalog.duplicate_pipeline_id",
          path: PIPELINE,
          message: "Duplicate pipeline id feature-ship",
          category: "catalog",
        },
        draft,
      ),
    ).toBeUndefined();
    const parallel = editorInfoFindings(draft, PIPELINE).find((finding) => finding.code === "graph/parallel");
    expect(quickFixLabel(parallel!, draft)).toBeUndefined();
  });
});

describe("editorFindingKey", () => {
  it("keeps info hints unique by code, line, and lineEnd", () => {
    const [needs, parallel] = editorInfoFindings(forkDraft(), PIPELINE);
    expect(editorFindingKey(needs!)).not.toBe(editorFindingKey(parallel!));
    expect(editorFindingKey(parallel!)).toContain("graph/parallel");
    expect(editorFindingKey(parallel!)).not.toBe(
      editorFindingKey({ ...parallel!, lineEnd: (parallel!.lineEnd ?? 0) + 1 }),
    );
    expect(editorFindingKey({ ...needs!, severity: "info" })).toContain("graph/needs");
  });
});
