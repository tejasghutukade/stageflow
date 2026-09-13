import { describe, expect, it } from "vitest";
import {
  applyCloneChains,
  detectCloneChains,
} from "../src/config/cloneChain.js";
import { resolvePipelineDagFromRefs } from "../src/config/resolvePipelineDag.js";
import type { PipelineStageRef } from "../src/types/pipeline.js";
import type { StageConfig } from "../src/types/stage.js";

const ISSUE_REF = "#/schemas/Issue";
const PIPELINE_ID = "kernel";
const DAG_CTX = { pipelineId: PIPELINE_ID, path: "kernel.pipeline.yaml" };

function objectSchema(): Record<string, unknown> {
  return { type: "object" };
}

function emitterOutput(field = "items"): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [field]: { type: "array", items: { $ref: ISSUE_REF } },
      summary: { type: "string" },
    },
  };
}

function stage(id: string, extra: Partial<StageConfig> = {}): StageConfig {
  return {
    id,
    system_prompt: "work",
    payload_schema: objectSchema(),
    clone_input_schema: objectSchema(),
    ...extra,
  };
}

function legalStages(): StageConfig[] {
  return [
    stage("emit-items", { payload_schema: emitterOutput() }),
    stage("handle-item", { clone_input_schema: { $ref: ISSUE_REF } }),
    stage("gather"),
  ];
}

function legalRefs(extra?: {
  clone_cap?: number;
  clone_mode?: "parallel" | "sequential";
}): PipelineStageRef[] {
  return [
    {
      id: "emit-items",
      entry: true,
      route: [{ to: "handle-item" }],
      ...(extra?.clone_cap !== undefined ? { clone_cap: extra.clone_cap } : {}),
      ...(extra?.clone_mode !== undefined ? { clone_mode: extra.clone_mode } : {}),
    },
    { id: "handle-item", route: [{ to: "gather" }] },
    { id: "gather" },
  ];
}

describe("detectCloneChains", () => {
  it("detects a sealed emitter → clone child → Join chain from schema and route shape", () => {
    const outcome = detectCloneChains(legalStages(), legalRefs(), PIPELINE_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([
      {
        emitterId: "emit-items",
        cloneChildId: "handle-item",
        joinId: "gather",
        arrayField: "items",
        ref: ISSUE_REF,
      },
    ]);
  });

  it("does not detect ordinary object-to-object sequential stages", () => {
    const stages = [
      stage("a", { payload_schema: objectSchema() }),
      stage("b", { clone_input_schema: objectSchema() }),
      stage("c"),
    ];
    const refs: PipelineStageRef[] = [
      { id: "a", entry: true, route: [{ to: "b" }] },
      { id: "b", route: [{ to: "c" }] },
      { id: "c" },
    ];
    const outcome = detectCloneChains(stages, refs, PIPELINE_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([]);
  });

  it("fails when the emitter output has two named-$ref array fields", () => {
    const stages = [
      stage("emit-items", {
        payload_schema: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: ISSUE_REF } },
            notes: { type: "array", items: { $ref: "#/schemas/Note" } },
          },
        },
      }),
      stage("handle-item", { clone_input_schema: { $ref: ISSUE_REF } }),
      stage("gather"),
    ];
    const outcome = detectCloneChains(stages, legalRefs(), PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/named \$ref Clone Array/);
  });

  it("fails a sealed root-level-array lookalike", () => {
    const stages = [
      stage("emit-items", {
        payload_schema: { type: "array", items: { $ref: ISSUE_REF } },
      }),
      stage("handle-item", { clone_input_schema: { $ref: ISSUE_REF } }),
      stage("gather"),
    ];
    const outcome = detectCloneChains(stages, legalRefs(), PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/root-level array/);
  });

  it("fails when Clone Array items are inline instead of a named $ref", () => {
    const stages = [
      stage("emit-items", {
        payload_schema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "object" } },
          },
        },
      }),
      stage("handle-item", { clone_input_schema: { $ref: ISSUE_REF } }),
      stage("gather"),
    ];
    const outcome = detectCloneChains(stages, legalRefs(), PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/named \$ref/);
  });

  it("fails when the clone child input is not the named $ref of the Clone Array", () => {
    const stages = [
      stage("emit-items", { payload_schema: emitterOutput() }),
      stage("handle-item", { clone_input_schema: objectSchema() }),
      stage("gather"),
    ];
    const outcome = detectCloneChains(
      stages,
      legalRefs({ clone_cap: 4, clone_mode: "parallel" }),
      PIPELINE_ID,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/named \$ref/);
  });

  it("fails when the emitter has a second forward Route", () => {
    const refs: PipelineStageRef[] = [
      {
        id: "emit-items",
        entry: true,
        clone_cap: 4,
        clone_mode: "parallel",
        route: [{ to: "handle-item" }, { to: "sidecar" }],
      },
      { id: "handle-item", route: [{ to: "gather" }] },
      { id: "sidecar" },
      { id: "gather" },
    ];
    const stages = [
      ...legalStages(),
      stage("sidecar"),
    ];
    const outcome = detectCloneChains(stages, refs, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/forward Route|clone child/);
  });

  it("fails when the Join has an extra parent", () => {
    const refs: PipelineStageRef[] = [
      {
        id: "emit-items",
        entry: true,
        route: [{ to: "handle-item" }],
      },
      { id: "handle-item", route: [{ to: "gather" }] },
      { id: "extra", entry: true, route: [{ to: "gather" }] },
      { id: "gather" },
    ];
    const stages = [...legalStages(), stage("extra")];
    const outcome = detectCloneChains(stages, refs, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/Join/);
    expect(outcome.issues[0]?.message).toMatch(/parent/);
  });

  it("fails when the clone child output is itself a Clone Array", () => {
    const stages = [
      stage("emit-items", { payload_schema: emitterOutput() }),
      stage("handle-item", {
        clone_input_schema: { $ref: ISSUE_REF },
        payload_schema: emitterOutput("more"),
      }),
      stage("gather"),
    ];
    const outcome = detectCloneChains(stages, legalRefs(), PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/clone child/);
    expect(outcome.issues[0]?.message).toMatch(/Clone Array/);
  });

  it("fails when if is on the emitter inbound edge", () => {
    const refs: PipelineStageRef[] = [
      {
        id: "emit-items",
        entry: true,
        route: [{ to: "handle-item", if: { field: "ok", op: "eq", value: true } }],
      },
      { id: "handle-item", route: [{ to: "gather" }] },
      { id: "gather" },
    ];
    const outcome = detectCloneChains(legalStages(), refs, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(/\bif\b/);
  });
});

describe("applyCloneChains Cap/Mode role policy", () => {
  it("stamps Cap, Mode, and Clone Array field on the emitter and compiles minItems/maxItems", () => {
    const refs = legalRefs({ clone_cap: 4, clone_mode: "parallel" });
    const { dag } = resolvePipelineDagFromRefs(refs, DAG_CTX);
    const stages = legalStages();
    const outcome = applyCloneChains(stages, refs, dag, PIPELINE_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBeUndefined();
    const emitter = dag.nodes.find((node) => node.id === "emit-items");
    expect(emitter).toMatchObject({
      clone_cap: 4,
      clone_mode: "parallel",
      clone_array_field: "items",
    });
    const child = dag.nodes.find((node) => node.id === "handle-item");
    expect(child?.clone_cap).toBeUndefined();
    expect(child?.clone_mode).toBeUndefined();
    const items = (
      stages[0]?.payload_schema as { properties?: Record<string, { minItems?: number; maxItems?: number }> }
    ).properties?.items;
    expect(items).toMatchObject({ minItems: 1, maxItems: 4 });
  });

  it("requires clone_cap and clone_mode on a detected emitter", () => {
    const refs = legalRefs();
    const { dag } = resolvePipelineDagFromRefs(refs, DAG_CTX);
    const outcome = applyCloneChains(legalStages(), refs, dag, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /Clone Chain emitter requires clone_cap and clone_mode/,
    );
  });

  it("forbids clone_cap on a non-emitter (the clone child)", () => {
    const refs: PipelineStageRef[] = [
      {
        id: "emit-items",
        entry: true,
        clone_cap: 4,
        clone_mode: "parallel",
        route: [{ to: "handle-item" }],
      },
      { id: "handle-item", clone_cap: 2, route: [{ to: "gather" }] },
      { id: "gather" },
    ];
    const { dag } = resolvePipelineDagFromRefs(refs, DAG_CTX);
    const outcome = applyCloneChains(legalStages(), refs, dag, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "handle-item": "clone_cap" is no longer supported — use a Clone Chain instead/,
    );
  });

  it("forbids clone_mode on a non-emitter (the Join)", () => {
    const refs: PipelineStageRef[] = [
      {
        id: "emit-items",
        entry: true,
        clone_cap: 4,
        clone_mode: "parallel",
        route: [{ to: "handle-item" }],
      },
      { id: "handle-item", route: [{ to: "gather" }] },
      { id: "gather", clone_mode: "sequential" },
    ];
    const { dag } = resolvePipelineDagFromRefs(refs, DAG_CTX);
    const outcome = applyCloneChains(legalStages(), refs, dag, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "gather": "clone_mode" is only valid on a Clone Chain emitter/,
    );
  });

  it("forbids clone_cap on a stage that is not part of a Clone Chain", () => {
    const refs: PipelineStageRef[] = [
      { id: "triage", entry: true, route: [{ to: "implement" }] },
      { id: "implement", clone_cap: 4, route: [{ to: "join-doc" }] },
      { id: "join-doc" },
    ];
    const stages = [stage("triage"), stage("implement"), stage("join-doc")];
    const { dag } = resolvePipelineDagFromRefs(refs, DAG_CTX);
    const outcome = applyCloneChains(stages, refs, dag, PIPELINE_ID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "implement": "clone_cap" is no longer supported — use a Clone Chain instead/,
    );
  });
});
