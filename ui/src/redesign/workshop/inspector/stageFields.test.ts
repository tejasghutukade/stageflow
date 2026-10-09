import { describe, expect, it } from "vitest";
import type { DraftPackagePayload, ValidationFinding } from "../../../api";
import {
  addStageIoField,
  deleteIn,
  errorChipValues,
  findingsForField,
  findingsForPipelineField,
  getPipelineForm,
  getStageForm,
  isUntitledPipelineId,
  locateFindingField,
  movePipelineStage,
  normalizeStageFieldKey,
  pipelineChanged,
  promptStats,
  removeStageIoField,
  renameStageIoField,
  resolvedStageModel,
  setStageIoFieldRequired,
  setStageIoFieldType,
  setPipelineModel,
  setPipelineStageNeeds,
  setStageBodyValue,
  setStageGateKind,
  setStageHitl,
  setStageIoFields,
  setStageMaxAttempts,
  setStageModel,
  setStageOnVerifyFail,
  setStageRetrySafety,
  setStageSystemPrompt,
  setStageVerifyCommand,
  stageChangeKind,
  stageFieldForFinding,
  stageNeeds,
} from "./stageFields";

function sampleDraft(): DraftPackagePayload {
  return {
    pipeline: {
      id: "feature-ship",
      model: "anthropic/claude-sonnet-4-5",
      stages: [
        { id: "plan", uses: "./stages/plan.yaml", entry: true, route: [{ to: "implement" }] },
        {
          id: "implement",
          uses: "./stages/implement.yaml",
          route: [{ to: "review" }],
          on_verify_fail: {
            mode: "repair",
            max_attempts: 3,
            retry_safety: "idempotent",
            include_failed_checks: false,
          },
        },
        {
          id: "review",
          system_prompt: "Review it.",
          gate_kinds: ["confirm", "free_text"],
          io: {
            input: { schema: { $ref: "#/schemas/work" } },
            output: { schema: { type: "object" } },
          },
          route: [{ type: "loop", to: "implement", max_replays: 2 }],
        },
      ],
    },
    stages: [
      {
        path: "stages/plan.yaml",
        body: {
          id: "plan",
          system_prompt: "Plan the change.\nWrite plan.md.\n",
          io: {
            input: { schema: { type: "object" } },
            output: {
              schema: {
                type: "object",
                required: ["plan_artifact"],
                properties: {
                  plan_artifact: { type: "string" },
                  files: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          verify: [
            { id: "plan-declared", type: "artifact", basename: "plan.md", when: ["emit"] },
            { id: "tests", type: "command", run: "npm test" },
          ],
        },
      },
      {
        path: "stages/implement.yaml",
        body: {
          id: "implement",
          model: "openai/gpt-5",
          system_prompt: "Implement.",
          io: {
            input: { schema: { type: "object", required: ["plan_artifact"], properties: { plan_artifact: { type: "string" } } } },
            output: { schema: { type: "object" } },
          },
        },
      },
    ],
  };
}

function finding(partial: Partial<ValidationFinding>): ValidationFinding {
  return {
    severity: "error",
    code: "pipeline.invalid_shape",
    path: "workshop/feature-ship/feature-ship.pipeline.yaml",
    message: "",
    category: "pipeline",
    ...partial,
  };
}

describe("getStageForm", () => {
  it("reads body fields from the uses file and wiring from the pipeline entry", () => {
    const form = getStageForm(sampleDraft(), "plan")!;
    expect(form.path).toBe("stages/plan.yaml");
    expect(form.inline).toBe(false);
    expect(form.model).toBeNull();
    expect(form.systemPrompt).toBe("Plan the change.\nWrite plan.md.\n");
    expect(form.inputs).toEqual([]);
    expect(form.outputs).toEqual(["plan_artifact", "files"]);
    expect(form.verifyCommand).toBe("npm test");
    expect(form.onVerifyFail).toBeNull();
    expect(form.hitl).toBe(false);
    expect(form.envelope).toEqual({
      artifacts: ["plan.md"],
      payload: ["plan_artifact", "files[]"],
      status: "success | failure",
    });
  });

  it("maps on_verify_fail repair to retry with max attempts", () => {
    const form = getStageForm(sampleDraft(), "implement")!;
    expect(form.onVerifyFail).toBe("retry");
    expect(form.maxAttempts).toBe(3);
    expect(form.model).toBe("openai/gpt-5");
    expect(form.inputs).toEqual(["plan_artifact"]);
  });

  it("reads inline stages, $ref schemas, and gate kinds", () => {
    const form = getStageForm(sampleDraft(), "review")!;
    expect(form.inline).toBe(true);
    expect(form.path).toBeNull();
    expect(form.inputsRef).toBe("work");
    expect(form.inputs).toEqual([]);
    expect(form.hitl).toBe(true);
    expect(form.gateKind).toBe("confirm");
    expect(form.gateKinds).toEqual(["confirm", "free_text"]);
  });

  it("returns null for unknown stages", () => {
    expect(getStageForm(sampleDraft(), "nope")).toBeNull();
  });

  it("resolves the effective model stage > pipeline > default", () => {
    const draft = sampleDraft();
    expect(resolvedStageModel(draft, { model: null }, "x/default")).toBe("anthropic/claude-sonnet-4-5");
    expect(resolvedStageModel(draft, { model: "a/b" }, null)).toBe("a/b");
    const noPipelineModel = setPipelineModel(draft, null);
    expect(resolvedStageModel(noPipelineModel, { model: null }, "x/default")).toBe("x/default");
    expect(resolvedStageModel(noPipelineModel, { model: null }, null)).toBeNull();
  });
});

describe("stage setters", () => {
  it("writes body fields to the stage file, never the uses wrapper", () => {
    const draft = sampleDraft();
    const next = setStageSystemPrompt(setStageModel(draft, "plan", "a/b"), "plan", "New prompt");
    expect(next.stages![0]!.body.model).toBe("a/b");
    expect(next.stages![0]!.body.system_prompt).toBe("New prompt");
    expect(next.pipeline.stages[0]!.model).toBeUndefined();
    expect(next.pipeline.stages[0]!.system_prompt).toBeUndefined();
    expect(draft.stages![0]!.body.model).toBeUndefined();
  });

  it("deletes model when cleared", () => {
    const next = setStageModel(sampleDraft(), "implement", null);
    expect("model" in next.stages![1]!.body).toBe(false);
  });

  it("writes inline stage fields onto the pipeline entry", () => {
    const next = setStageSystemPrompt(sampleDraft(), "review", "Look closely.");
    expect(next.pipeline.stages[2]!.system_prompt).toBe("Look closely.");
  });

  it("adds and removes io fields, keeping required in sync", () => {
    let draft = addStageIoField(sampleDraft(), "plan", "input", "topic");
    let body = draft.stages![0]!.body;
    expect(getStageForm(draft, "plan")!.inputs).toEqual(["topic"]);
    expect((body.io as any).input.schema).toEqual({
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    });
    draft = removeStageIoField(draft, "plan", "output", "plan_artifact");
    body = draft.stages![0]!.body;
    expect((body.io as any).output.schema).toEqual({
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
    });
    draft = removeStageIoField(draft, "plan", "input", "topic");
    expect((draft.stages![0]!.body.io as any).input.schema).toEqual({ type: "object" });
  });

  it("creates both io sides when io is missing", () => {
    const draft = setStageBodyValue(sampleDraft(), "plan", ["io"], undefined);
    const next = setStageIoFields(draft, "plan", "output", ["summary", "summary", " "]);
    expect(next.stages![0]!.body.io).toEqual({
      output: { schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
      input: { schema: { type: "object" } },
    });
  });

  it("reads field type and required, and writes them back", () => {
    const form = getStageForm(sampleDraft(), "plan")!;
    expect(form.outputFields).toEqual([
      { name: "plan_artifact", type: "string", required: true },
      { name: "files", type: "string[]", required: false },
    ]);
    let draft = setStageIoFieldType(sampleDraft(), "plan", "output", "plan_artifact", "number");
    draft = setStageIoFieldRequired(draft, "plan", "output", "files", true);
    draft = renameStageIoField(draft, "plan", "output", "files", "paths");
    const schema = (draft.stages![0]!.body.io as any).output.schema;
    expect(schema.properties.plan_artifact).toEqual({ type: "number" });
    expect(schema.properties.paths).toEqual({ type: "array", items: { type: "string" } });
    expect(schema.required).toEqual(["plan_artifact", "paths"]);
    expect(getStageForm(draft, "plan")!.outputFields.map((field) => field.name)).toEqual([
      "plan_artifact",
      "paths",
    ]);
  });

  it("keeps an integer property until the type is changed", () => {
    const draft = sampleDraft();
    (draft.stages![0]!.body.io as any).output.schema.properties.plan_artifact = { type: "integer" };
    expect(getStageForm(draft, "plan")!.outputFields[0]).toMatchObject({ type: "number" });
    const next = setStageIoFieldRequired(draft, "plan", "output", "plan_artifact", true);
    expect((next.stages![0]!.body.io as any).output.schema.properties.plan_artifact).toEqual({
      type: "integer",
    });
  });

  it("does not edit $ref io schemas", () => {
    const draft = sampleDraft();
    const next = addStageIoField(draft, "review", "input", "extra");
    expect((next.pipeline.stages[2]!.io as any).input.schema).toEqual({ $ref: "#/schemas/work" });
  });

  it("updates, creates, and removes the verify command check", () => {
    let draft = setStageVerifyCommand(sampleDraft(), "plan", "npm run lint ");
    expect((draft.stages![0]!.body.verify as any[])[1]).toEqual({ id: "tests", type: "command", run: "npm run lint" });
    draft = setStageVerifyCommand(draft, "plan", "");
    expect(draft.stages![0]!.body.verify).toHaveLength(1);
    draft = setStageVerifyCommand(draft, "implement", "semgrep --error");
    expect(draft.stages![1]!.body.verify).toEqual([{ id: "command", type: "command", run: "semgrep --error" }]);
    draft = setStageVerifyCommand(draft, "implement", "  ");
    expect("verify" in draft.stages![1]!.body).toBe(false);
  });

  it("writes on_verify_fail on the pipeline entry", () => {
    let draft = setStageOnVerifyFail(sampleDraft(), "plan", "retry");
    expect(draft.pipeline.stages[0]!.on_verify_fail).toEqual({
      mode: "repair",
      max_attempts: 2,
      retry_safety: "idempotent",
      include_failed_checks: true,
    });
    expect(draft.stages![0]!.body.on_verify_fail).toBeUndefined();
    draft = setStageMaxAttempts(draft, "plan", 4);
    expect((draft.pipeline.stages[0]!.on_verify_fail as any).max_attempts).toBe(4);
    draft = setStageOnVerifyFail(draft, "plan", "ask_operator");
    expect(draft.pipeline.stages[0]!.on_verify_fail).toEqual({ mode: "manual", retry_safety: "side_effecting" });
    draft = setStageRetrySafety(draft, "plan", "idempotent");
    expect(getStageForm(draft, "plan")!.retrySafety).toBe("idempotent");
    draft = setStageOnVerifyFail(draft, "plan", "fail");
    expect("on_verify_fail" in draft.pipeline.stages[0]!).toBe(false);
  });

  it("keeps include_failed_checks and max attempts when re-selecting retry", () => {
    const draft = setStageOnVerifyFail(sampleDraft(), "implement", "retry");
    expect(draft.pipeline.stages[1]!.on_verify_fail).toEqual({
      mode: "repair",
      max_attempts: 3,
      retry_safety: "idempotent",
      include_failed_checks: false,
    });
  });

  it("toggles HITL through gate_kinds and retargets gate checks", () => {
    let draft = setStageBodyValue(sampleDraft(), "plan", ["verify"], [
      { id: "accepted", type: "gate", kind: "artifact_backed" },
    ]);
    draft = setStageHitl(draft, "plan", true);
    expect(draft.stages![0]!.body.gate_kinds).toEqual(["confirm"]);
    expect((draft.stages![0]!.body.verify as any[])[0].kind).toBe("confirm");
    draft = setStageGateKind(draft, "plan", "artifact_backed");
    expect(getStageForm(draft, "plan")!.gateKind).toBe("artifact_backed");
    draft = setStageHitl(draft, "plan", false);
    expect("gate_kinds" in draft.stages![0]!.body).toBe(false);
    expect(getStageForm(draft, "plan")!.hitl).toBe(false);
  });

  it("deleteIn prunes empty parents", () => {
    const target = { a: { b: { c: 1 } }, d: 2 };
    deleteIn(target, ["a", "b", "c"]);
    expect(target).toEqual({ d: 2 });
  });
});

describe("promptStats", () => {
  it("counts lines and chars", () => {
    expect(promptStats("")).toEqual({ lines: 0, chars: 0 });
    expect(promptStats("a\nb\n")).toEqual({ lines: 2, chars: 4 });
    expect(promptStats("one")).toEqual({ lines: 1, chars: 3 });
  });
});

describe("pipeline form", () => {
  it("derives needs from route and ignores loop entries", () => {
    const form = getPipelineForm(sampleDraft());
    expect(form.id).toBe("feature-ship");
    expect(form.model).toBe("anthropic/claude-sonnet-4-5");
    expect(form.stages.map((s) => [s.id, s.needs, s.entry])).toEqual([
      ["plan", [], true],
      ["implement", ["plan"], false],
      ["review", ["implement"], false],
    ]);
  });

  it("rewrites parent routes when needs change and normalizes entry", () => {
    let draft = setPipelineStageNeeds(sampleDraft(), "review", ["plan"]);
    expect(stageNeeds(draft, "review")).toEqual(["plan"]);
    expect(draft.pipeline.stages[0]!.route).toEqual([{ to: "implement" }, { to: "review" }]);
    expect("route" in draft.pipeline.stages[1]!).toBe(false);
    expect(draft.pipeline.stages[2]!.route).toEqual([{ type: "loop", to: "implement", max_replays: 2 }]);
    draft = setPipelineStageNeeds(draft, "implement", []);
    expect(draft.pipeline.stages[1]!.entry).toBe(true);
    expect(stageNeeds(draft, "implement")).toEqual([]);
  });

  it("reorders stages", () => {
    const next = movePipelineStage(sampleDraft(), "review", -1);
    expect(getPipelineForm(next).stages.map((s) => s.id)).toEqual(["plan", "review", "implement"]);
    expect(movePipelineStage(next, "plan", -1)).toBe(next);
  });

  it("detects untitled ids", () => {
    expect(isUntitledPipelineId("untitled")).toBe(true);
    expect(isUntitledPipelineId("  ")).toBe(true);
    expect(isUntitledPipelineId("feature-ship")).toBe(false);
  });
});

describe("change status", () => {
  it("is new without a baseline or when missing from it", () => {
    const draft = sampleDraft();
    expect(stageChangeKind(draft, null, "plan")).toBe("new");
    const base = sampleDraft();
    base.pipeline.stages = base.pipeline.stages.slice(0, 2);
    expect(stageChangeKind(draft, base, "review")).toBe("new");
  });

  it("is edited when the body or entry differs, unchanged otherwise", () => {
    const base = sampleDraft();
    expect(stageChangeKind(sampleDraft(), base, "plan")).toBe("unchanged");
    expect(stageChangeKind(setStageModel(sampleDraft(), "plan", "a/b"), base, "plan")).toBe("edited");
    expect(stageChangeKind(setStageOnVerifyFail(sampleDraft(), "plan", "retry"), base, "plan")).toBe("edited");
    expect(stageChangeKind(setPipelineStageNeeds(sampleDraft(), "review", ["plan"]), base, "plan")).toBe("unchanged");
    expect(pipelineChanged(sampleDraft(), base)).toBe(false);
    expect(pipelineChanged(setPipelineModel(sampleDraft(), "x/y"), base)).toBe(true);
  });
});

describe("findings → fields", () => {
  it("maps io_incompatible to the child inputs and parent outputs", () => {
    const f = finding({
      code: "pipeline.io_incompatible",
      message: 'Pipeline feature-ship: stage "implement" io.input is not a structural subset of "plan" io.output',
    });
    expect(stageFieldForFinding(f, "implement")).toBe("io.inputs");
    expect(stageFieldForFinding(f, "plan")).toBe("io.outputs");
    expect(stageFieldForFinding(f, "review")).toBeNull();
  });

  it("maps codes and messages to fields", () => {
    const list = [
      finding({ code: "stage.missing_model", message: 'Stage "plan" in pipeline "feature-ship": model is required' }),
      finding({ code: "pipeline.invalid_verify", message: 'Stage "plan" verify: [1].run must be a non-empty string' }),
      finding({ code: "pipeline.invalid_recovery", message: 'Stage "plan" recovery: requires a completion contract' }),
      finding({ code: "stage.invalid_gate_kinds", category: "stage", stageId: "plan", message: "Invalid stage file stages/plan.yaml: unsupported gate kind" }),
      finding({ code: "stage.invalid_io", category: "stage", stageId: "plan", message: "Invalid stage file stages/plan.yaml: io.output.schema is required" }),
      finding({ code: "stage.invalid_shape", category: "stage", message: "Invalid stage /tmp/x/stages/plan.yaml: system_prompt is a required string" }),
      finding({ code: "stage.id_filename_mismatch", category: "stage", stageId: "plan", message: 'Stage id "plan" does not match filename stem "planning"' }),
      finding({ code: "pipeline.invalid_verify", message: 'Stage "review" verify: bad' }),
    ];
    const map = findingsForField(list, "plan", "stages/plan.yaml");
    expect(map.model).toHaveLength(1);
    expect(map["verify.command"]).toHaveLength(1);
    expect(map.on_verify_fail).toHaveLength(1);
    expect(map.ask_operator).toHaveLength(1);
    expect(map["io.outputs"]).toHaveLength(1);
    expect(map.system_prompt).toHaveLength(1);
    expect(map.id).toHaveLength(1);
    expect(map.general).toHaveLength(0);
  });

  it("does not match a stage through a quoted pipeline id", () => {
    const f = finding({ code: "stage.missing_model", message: 'Stage "plan" in pipeline "review": model is required' });
    expect(stageFieldForFinding(f, "review")).toBeNull();
    expect(stageFieldForFinding(f, "plan")).toBe("model");
  });

  it("locates the stage and field for a finding", () => {
    const draft = sampleDraft();
    const f = finding({ code: "pipeline.invalid_recovery", message: 'Stage "implement" recovery: bad' });
    expect(locateFindingField(f, draft)).toEqual({ stageId: "implement", field: "on_verify_fail" });
    expect(locateFindingField(finding({ code: "catalog.duplicate_pipeline_id", category: "catalog", message: "dup" }), draft)).toBeNull();
  });

  it("groups pipeline-level findings", () => {
    const draft = sampleDraft();
    const map = findingsForPipelineField(
      [
        finding({ code: "catalog.duplicate_pipeline_id", category: "catalog", message: "Duplicate pipeline id feature-ship" }),
        finding({ code: "pipeline.dag_error", message: "cycle detected" }),
        finding({ code: "stage.missing_model", message: 'Stage "plan" in pipeline "feature-ship": model is required' }),
      ],
      draft,
    );
    expect(map.id).toHaveLength(1);
    expect(map.stages).toHaveLength(1);
    expect(map.model).toHaveLength(0);
  });

  it("marks chips named in errors, or all chips when none are named", () => {
    const named = finding({ message: "implement does not declare diff.patch in io.outputs" });
    expect(errorChipValues(["diff.patch", "plan.md"], [named])).toEqual(["diff.patch"]);
    expect(errorChipValues(["a", "b"], [finding({ message: "io.input is not a subset" })])).toEqual(["a", "b"]);
    expect(errorChipValues(["a"], [finding({ severity: "warning", message: "a" })])).toEqual([]);
  });

  it("normalizes focus field aliases", () => {
    expect(normalizeStageFieldKey("io")).toBe("io.inputs");
    expect(normalizeStageFieldKey("gate_kinds")).toBe("ask_operator");
    expect(normalizeStageFieldKey("verify")).toBe("verify.command");
    expect(normalizeStageFieldKey("whatever")).toBe("general");
  });
});
