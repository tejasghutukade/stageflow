import { describe, expect, it } from "vitest";
import type { DraftPackagePayload } from "../../api";
import { draftFileYaml } from "./draftYaml";
import {
  applyYamlEdit,
  centerLineScrollTop,
  cursorLineCol,
  findingTokenIndex,
  isYamlPathDirty,
  revealColumnScrollLeft,
  revealLineScrollTop,
  stageEntryLineRange,
  yamlEditChangesDraft,
  yamlFooterCounts,
  yamlLineTop,
  yamlTabLabel,
  yamlTabPaths,
  yamlTextMatchesDraft,
} from "./yamlEditorModel";
import { highlightYamlLine } from "./yamlHighlight";

const PIPELINE_PATH = "examples/feature-ship/feature-ship.pipeline.yaml";

function sampleDraft(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      model: "anthropic/claude-sonnet-4-5",
      stages: [
        { id: "plan" },
        { id: "implement", needs: ["plan"] },
        { id: "review", uses: "./stages/review.yaml", needs: ["implement"] },
      ],
    },
    stages: [{ path: "stages/review.yaml", body: { id: "review", gate_kinds: ["confirm"] } }],
  };
}

describe("applyYamlEdit", () => {
  it("replaces the pipeline document on a valid pipeline edit", () => {
    const draft = sampleDraft();
    const before = JSON.stringify(draft);
    const result = applyYamlEdit(
      draft,
      PIPELINE_PATH,
      PIPELINE_PATH,
      "id: feature-ship\nstages:\n  - id: plan\n  - id: ship\n    needs: [plan]\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.pipeline).toEqual({
      id: "feature-ship",
      stages: [{ id: "plan" }, { id: "ship", needs: ["plan"] }],
    });
    expect(result.draft.stages).toBe(draft.stages);
    expect(JSON.stringify(draft)).toBe(before);
  });

  it("replaces only the matching stage file body", () => {
    const draft = sampleDraft();
    const result = applyYamlEdit(
      draft,
      "./stages/review.yaml",
      PIPELINE_PATH,
      "id: review\ngate_kinds: [confirm, artifact_backed]\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.stages?.[0]?.body).toEqual({
      id: "review",
      gate_kinds: ["confirm", "artifact_backed"],
    });
    expect(result.draft.pipeline).toBe(draft.pipeline);
    expect(draft.stages?.[0]?.body.gate_kinds).toEqual(["confirm"]);
  });

  it("reports a syntax error with a 1-based line and column", () => {
    const result = applyYamlEdit(
      sampleDraft(),
      PIPELINE_PATH,
      PIPELINE_PATH,
      "id: feature-ship\nstages: [plan\nmodel: x\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.length).toBeGreaterThan(0);
    expect(result.error.line).toBeGreaterThanOrEqual(2);
    expect(result.error.column).toBeGreaterThanOrEqual(1);
  });

  it("rejects a non-mapping root", () => {
    const result = applyYamlEdit(sampleDraft(), PIPELINE_PATH, PIPELINE_PATH, "- plan\n- ship\n");
    expect(result).toEqual({
      ok: false,
      error: { message: "Expected a mapping at the document root", line: 1, column: 1 },
    });
    const empty = applyYamlEdit(sampleDraft(), "stages/review.yaml", PIPELINE_PATH, "");
    expect(empty.ok).toBe(false);
  });

  it("requires a stages list and a string id on the pipeline file", () => {
    const missing = applyYamlEdit(sampleDraft(), PIPELINE_PATH, PIPELINE_PATH, "id: p\n");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toBe("Pipeline needs a stages list");
    const badStages = applyYamlEdit(
      sampleDraft(),
      PIPELINE_PATH,
      PIPELINE_PATH,
      "id: p\nstages: nope\n",
    );
    expect(badStages.ok).toBe(false);
    if (!badStages.ok) expect(badStages.error).toMatchObject({ line: 2, column: 9 });
    const badId = applyYamlEdit(sampleDraft(), PIPELINE_PATH, PIPELINE_PATH, "id: 3\nstages: []\n");
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.message).toBe("Pipeline needs a string id");
  });

  it("rejects an unknown stage file", () => {
    const result = applyYamlEdit(sampleDraft(), "stages/nope.yaml", PIPELINE_PATH, "id: x\n");
    expect(result.ok).toBe(false);
  });
});

describe("yamlTextMatchesDraft", () => {
  it("keeps user formatting that parses to the same document", () => {
    const draft = sampleDraft();
    const canonical = draftFileYaml(draft, "stages/review.yaml", PIPELINE_PATH);
    expect(yamlTextMatchesDraft(draft, "stages/review.yaml", PIPELINE_PATH, canonical)).toBe(
      true,
    );
    expect(
      yamlTextMatchesDraft(
        draft,
        "stages/review.yaml",
        PIPELINE_PATH,
        "# note\nid:   review\ngate_kinds: [ confirm ]\n",
      ),
    ).toBe(true);
  });

  it("detects an outside draft change", () => {
    const draft = sampleDraft();
    const text = draftFileYaml(draft, PIPELINE_PATH, PIPELINE_PATH);
    const next: DraftPackagePayload = {
      ...draft,
      pipeline: { ...draft.pipeline, model: "openai/gpt-5" },
    };
    expect(yamlTextMatchesDraft(next, PIPELINE_PATH, PIPELINE_PATH, text)).toBe(false);
    expect(yamlTextMatchesDraft(next, PIPELINE_PATH, PIPELINE_PATH, "id: [\n")).toBe(false);
  });

  it("detects whether an edit changed the draft", () => {
    const draft = sampleDraft();
    expect(yamlEditChangesDraft(draft, { ...draft })).toBe(false);
    expect(
      yamlEditChangesDraft(draft, { ...draft, pipeline: { ...draft.pipeline, id: "x" } }),
    ).toBe(true);
  });
});

describe("stageEntryLineRange", () => {
  const text = [
    "# plan, build, review + test, ship",
    "id: feature-ship",
    "stages:",
    "  - plan",
    "  - id: implement",
    "    needs: [plan]",
    "  - id: review",
    "    needs: [implement]",
    "    gate_kinds: [confirm]",
    "",
    "  - uses: ./stages/ship.yaml",
    "    id: 'ship'",
    "    # runs last",
    "model: pi",
    "",
  ].join("\n");

  it("covers the list item through the line before the next item", () => {
    expect(stageEntryLineRange(text, "implement")).toEqual({ start: 5, end: 6 });
    expect(stageEntryLineRange(text, "review")).toEqual({ start: 7, end: 9 });
  });

  it("finds an id that is not on the dash line and stops at the next root key", () => {
    expect(stageEntryLineRange(text, "ship")).toEqual({ start: 11, end: 13 });
  });

  it("returns null for an unknown stage or a file without stages", () => {
    expect(stageEntryLineRange(text, "plan")).toBeNull();
    expect(stageEntryLineRange(text, "missing")).toBeNull();
    expect(stageEntryLineRange("id: review\n", "review")).toBeNull();
  });

  it("supports a sequence at the same indent as the stages key", () => {
    expect(stageEntryLineRange("stages:\n- id: a\n- id: b\n  needs: [a]\n", "b")).toEqual({
      start: 3,
      end: 4,
    });
  });
});

describe("cursorLineCol", () => {
  it("maps offsets to 1-based line and column", () => {
    const text = "id: x\nstages:\n  - id: a\n";
    expect(cursorLineCol(text, 0)).toEqual({ line: 1, column: 1 });
    expect(cursorLineCol(text, 5)).toEqual({ line: 1, column: 6 });
    expect(cursorLineCol(text, 6)).toEqual({ line: 2, column: 1 });
    expect(cursorLineCol(text, 16)).toEqual({ line: 3, column: 3 });
    expect(cursorLineCol(text, 999)).toEqual({ line: 4, column: 1 });
  });
});

describe("findingTokenIndex", () => {
  const tokens = highlightYamlLine("    gate_kinds: [confirm, artifact_backed]");

  it("picks the value token under the column", () => {
    const index = findingTokenIndex(tokens, 30);
    expect(tokens[index]?.text).toBe("artifact_backed");
  });

  it("falls back to the first value token", () => {
    expect(tokens[findingTokenIndex(tokens)]?.text).toBe("confirm");
    expect(tokens[findingTokenIndex(tokens, 2)]?.text).toBe("confirm");
    expect(findingTokenIndex(highlightYamlLine("stages:"))).toBe(-1);
  });
});

describe("tabs and footer", () => {
  it("labels the pipeline by basename and stage files relative to it", () => {
    expect(yamlTabLabel(PIPELINE_PATH, PIPELINE_PATH)).toBe("feature-ship.pipeline.yaml");
    expect(yamlTabLabel("examples/feature-ship/stages/review.yaml", PIPELINE_PATH)).toBe(
      "stages/review.yaml",
    );
    expect(yamlTabLabel("./stages/review.yaml", PIPELINE_PATH)).toBe("stages/review.yaml");
  });

  it("keeps the pipeline tab first and dedupes open paths", () => {
    expect(
      yamlTabPaths(PIPELINE_PATH, [
        "stages/review.yaml",
        PIPELINE_PATH,
        null,
        "./stages/review.yaml",
        "stages/ship.yaml",
      ]),
    ).toEqual([PIPELINE_PATH, "stages/review.yaml", "stages/ship.yaml"]);
  });

  it("matches dirty paths after normalization", () => {
    const dirty = new Set(["stages/review.yaml"]);
    expect(isYamlPathDirty(dirty, "./stages/review.yaml")).toBe(true);
    expect(isYamlPathDirty(dirty, "examples/feature-ship/stages/review.yaml")).toBe(true);
    expect(isYamlPathDirty(dirty, "stages/ship.yaml")).toBe(false);
  });

  it("counts lines without the trailing empty line", () => {
    expect(yamlFooterCounts("a: 1\nb: 2\n", 5)).toBe("2 lines · 5 stages");
    expect(yamlFooterCounts("a: 1", 1)).toBe("1 line · 1 stage");
  });
});

describe("line geometry", () => {
  it("places line tops on a 20px grid below 10px of padding", () => {
    expect(yamlLineTop(1)).toBe(10);
    expect(yamlLineTop(12)).toBe(230);
  });

  it("scrolls just enough to reveal a line", () => {
    expect(revealLineScrollTop(5, 0, 200)).toBe(0);
    expect(revealLineScrollTop(20, 0, 200)).toBe(220);
    expect(revealLineScrollTop(2, 100, 200)).toBe(20);
    expect(centerLineScrollTop(1, 400)).toBe(0);
    expect(centerLineScrollTop(30, 200)).toBe(500);
  });

  it("scrolls horizontally to keep the caret column visible", () => {
    expect(revealColumnScrollLeft(10, 7, 40, 0, 400)).toBe(0);
    expect(revealColumnScrollLeft(60, 7, 40, 0, 400)).toBe(67);
    expect(revealColumnScrollLeft(1, 7, 40, 120, 400)).toBe(0);
  });
});
