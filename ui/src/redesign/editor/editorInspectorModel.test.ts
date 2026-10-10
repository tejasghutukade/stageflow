import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, PipelineListing } from "../../api";
import { GATE_KINDS } from "../workshop/inspector/stageFields";
import {
  INSPECTOR_GATE_ORDER,
  applyGateKindToggle,
  formatPromptTokens,
  inspectorFocusTarget,
  inspectorGateOrderCoversCatalog,
  isStageIdValid,
  otherPipelinesUsingStage,
  payloadSchemaLabel,
  readStageSkill,
  sharedStageNotice,
  toggleGateKind,
  usedByPipelinesLabel,
  warnedGateKinds,
  writeStageSkill,
} from "./editorInspectorModel";

function listing(
  id: string,
  stages: PipelineListing["stages"],
  projectRoot = "/repo",
): PipelineListing {
  return {
    id,
    path: `${id}.pipeline.yaml`,
    project_root: projectRoot,
    stages,
  };
}

function stageDraft(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      stages: [{ id: "review", uses: "stages/review.yaml", skill: "from-pipeline" }],
    },
    stages: [
      {
        path: "stages/review.yaml",
        body: {
          id: "review",
          skill: "from-file",
          system_prompt: "Read the diff.",
          gate_kinds: ["free_text"],
          io: {
            output: {
              schema: {
                type: "object",
                properties: { verdict: { type: "string" } },
              },
            },
          },
        },
      },
    ],
  };
}

describe("formatPromptTokens", () => {
  it("rounds character length up to a quarter and formats en-US", () => {
    expect(formatPromptTokens("")).toBe("0 tok");
    expect(formatPromptTokens("abcd")).toBe("1 tok");
    expect(formatPromptTokens("abcde")).toBe("2 tok");
    expect(formatPromptTokens("x".repeat(4960))).toBe("1,240 tok");
  });
});

describe("otherPipelinesUsingStage", () => {
  const stage = {
    id: "review",
    path: "stages/review.yaml",
    projectRoot: "/repo",
  };
  const pipelines = [
    listing("feature-ship", [{ id: "review", uses_path: "stages/review.yaml" }]),
    listing("bugfix-loop", [{ id: "review", uses_path: "./stages/review.yaml" }]),
    listing("spec-review", [{ id: "other", uses_path: "pkg/stages/review.yaml" }]),
    listing("notes", [{ id: "draft" }]),
    listing("elsewhere", [{ id: "review" }], "/other"),
  ];

  it("lists other pipelines that share the stage id or path in the same catalog", () => {
    expect(otherPipelinesUsingStage(pipelines, stage, "feature-ship")).toEqual([
      "bugfix-loop",
      "spec-review",
    ]);
  });

  it("keeps the current pipeline when its id is unknown", () => {
    expect(otherPipelinesUsingStage(pipelines, stage, undefined)).toEqual([
      "feature-ship",
      "bugfix-loop",
      "spec-review",
    ]);
  });

  it("returns nothing without a catalog", () => {
    expect(otherPipelinesUsingStage(null, stage, "feature-ship")).toEqual([]);
  });
});

describe("sharedStageNotice", () => {
  it("joins other pipeline ids with a comma and and", () => {
    expect(sharedStageNotice([])).toBeNull();
    expect(sharedStageNotice(["bugfix-loop"])).toBe(
      "Edits here also change bugfix-loop.",
    );
    expect(sharedStageNotice(["bugfix-loop", "spec-review"])).toBe(
      "Edits here also change bugfix-loop and spec-review.",
    );
    expect(sharedStageNotice(["a", "b", "c"])).toBe("Edits here also change a, b and c.");
    expect(sharedStageNotice(["a", "b", "c", "d"])).toBe(
      "Edits here also change a, b, c and 1 more.",
    );
    expect(sharedStageNotice(["a", "b", "c", "d", "e"])).toBe(
      "Edits here also change a, b, c and 2 more.",
    );
  });
});

describe("usedByPipelinesLabel", () => {
  it("pluralizes pipeline", () => {
    expect(usedByPipelinesLabel(1)).toBe("Used by 1 pipeline");
    expect(usedByPipelinesLabel(3)).toBe("Used by 3 pipelines");
  });
});

describe("toggleGateKind", () => {
  it("covers every catalog gate kind in inspector order", () => {
    expect(inspectorGateOrderCoversCatalog()).toBe(true);
    expect([...INSPECTOR_GATE_ORDER].sort()).toEqual([...GATE_KINDS].sort());
    expect(INSPECTOR_GATE_ORDER).toEqual([
      "confirm",
      "artifact_backed",
      "free_text",
      "multi_question",
    ]);
  });

  it("inserts and removes kinds in canonical order and keeps unknown kinds", () => {
    expect(toggleGateKind([], "confirm")).toEqual(["confirm"]);
    expect(toggleGateKind(["free_text"], "confirm")).toEqual(["confirm", "free_text"]);
    expect(toggleGateKind(["confirm", "artifact_backed", "free_text"], "artifact_backed")).toEqual([
      "confirm",
      "free_text",
    ]);
    expect(toggleGateKind(["custom", "confirm"], "free_text")).toEqual([
      "confirm",
      "free_text",
      "custom",
    ]);
    expect(toggleGateKind(["confirm"], "confirm")).toEqual([]);
  });

  it("writes the ordered array onto the stage body and drops the key when empty", () => {
    const turnedOn = applyGateKindToggle(stageDraft(), "review", "confirm");
    expect(turnedOn.stages?.[0]?.body.gate_kinds).toEqual(["confirm", "free_text"]);
    const cleared = applyGateKindToggle(
      applyGateKindToggle(turnedOn, "review", "confirm"),
      "review",
      "free_text",
    );
    expect(cleared.stages?.[0]?.body.gate_kinds).toBeUndefined();
  });
});

describe("readStageSkill / writeStageSkill", () => {
  it("prefers the pipeline entry skill over the stage file", () => {
    expect(readStageSkill(stageDraft(), "review")).toBe("from-pipeline");
    const fileOnly: DraftPackagePayload = {
      ...stageDraft(),
      pipeline: {
        id: "feature-ship",
        stages: [{ id: "review", uses: "stages/review.yaml" }],
      },
    };
    expect(readStageSkill(fileOnly, "review")).toBe("from-file");
  });

  it("writes skill on the pipeline entry and clears both sides for none", () => {
    const next = writeStageSkill(stageDraft(), "review", "code-review");
    expect(next.pipeline.stages[0]?.skill).toBe("code-review");
    expect(next.stages?.[0]?.body.skill).toBe("from-file");
    expect(readStageSkill(next, "review")).toBe("code-review");
    const cleared = writeStageSkill(next, "review", "");
    expect(cleared.pipeline.stages[0]?.skill).toBeUndefined();
    expect(cleared.stages?.[0]?.body.skill).toBeUndefined();
    expect(readStageSkill(cleared, "review")).toBe("");
  });
});

describe("payloadSchemaLabel", () => {
  it("uses a schema ref, otherwise an inline field count, otherwise none", () => {
    expect(
      payloadSchemaLabel({ outputsRef: "schemas/review-verdict.json", outputFields: [] }),
    ).toBe("schemas/review-verdict.json");
    expect(payloadSchemaLabel({ outputsRef: "ReviewVerdict", outputFields: [{ name: "x" }] })).toBe(
      "ReviewVerdict",
    );
    expect(payloadSchemaLabel({ outputsRef: null, outputFields: [{ name: "verdict" }] })).toBe(
      "inline · 1 field",
    );
    expect(
      payloadSchemaLabel({
        outputsRef: null,
        outputFields: [{ name: "verdict" }, { name: "notes" }],
      }),
    ).toBe("inline · 2 fields");
    expect(payloadSchemaLabel({ outputsRef: null, outputFields: [] })).toBe("none");
  });
});

describe("isStageIdValid", () => {
  it("accepts the stage id pattern", () => {
    expect(isStageIdValid("review")).toBe(true);
    expect(isStageIdValid("Review_2")).toBe(true);
    expect(isStageIdValid("a-b")).toBe(true);
    expect(isStageIdValid("")).toBe(false);
    expect(isStageIdValid("-nope")).toBe(false);
    expect(isStageIdValid("has space")).toBe(false);
  });
});

describe("inspectorFocusTarget", () => {
  it("maps inspector fields and stage field keys", () => {
    expect(inspectorFocusTarget("id")).toBe("id");
    expect(inspectorFocusTarget("model")).toBe("model");
    expect(inspectorFocusTarget("system_prompt")).toBe("system_prompt");
    expect(inspectorFocusTarget("prompt")).toBe("system_prompt");
    expect(inspectorFocusTarget("gate_kinds")).toBe("gate_kinds");
    expect(inspectorFocusTarget("ask_operator")).toBe("gate_kinds");
    expect(inspectorFocusTarget("payload")).toBe("payload");
    expect(inspectorFocusTarget("payload_schema")).toBe("payload");
    expect(inspectorFocusTarget("io")).toBe("payload");
    expect(inspectorFocusTarget("io.outputs")).toBe("payload");
    expect(inspectorFocusTarget("verify")).toBe("header");
  });
});

describe("warnedGateKinds", () => {
  it("flags kinds named in a finding for this stage", () => {
    expect(
      warnedGateKinds(
        [
          { stageId: "review", message: "artifact_backed needs a schema" },
          { stageId: "plan", message: "confirm is unused" },
          { message: 'stage "review" gate confirm is missing' },
        ],
        "review",
      ),
    ).toEqual(["confirm", "artifact_backed"]);
  });
});
