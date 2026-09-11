import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ctx = (pipelineId: string) => ({
  pipelineId,
  path: path.join(fixtures, "pipelines/test.pipeline.yaml"),
});

describe("resolvePipelineDag: route (ticket 01, forward routing only)", () => {
  it("a stage can declare route: [{to}] and the target becomes reachable without declaring needs", () => {
    const { stages, dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc" },
      ],
      ctx("route-basic"),
    );

    expect(stages).toEqual(["clarify", "design-doc"]);
    expect(dag.roots).toEqual(["clarify"]);
    expect(dag.childrenOf.clarify).toEqual(["design-doc"]);

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")).toMatchObject({
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
      ancestors: ["clarify"],
    });
    expect(byId.get("clarify")).toMatchObject({ needs: null, needsEdges: [], entry: true });
  });

  it("builds a linear route chain across three stages", () => {
    const { stages, dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc", route: [{ to: "implementation-plan" }] },
        { id: "implementation-plan" },
      ],
      ctx("route-linear"),
    );

    expect(stages).toEqual(["clarify", "design-doc", "implementation-plan"]);
    expect(dag.roots).toEqual(["clarify"]);
    expect(dag.childrenOf).toEqual({
      clarify: ["design-doc"],
      "design-doc": ["implementation-plan"],
      "implementation-plan": [],
    });

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("implementation-plan")).toMatchObject({
      needs: "design-doc",
      needsEdges: [{ id: "design-doc", on: ["succeeded"] }],
      ancestors: ["clarify", "design-doc"],
    });
  });

  it("a route entry's on gate is evaluated against the declaring stage's own terminal state", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route: [{ to: "design-doc", on: ["failed", "skipped"] }],
        },
        { id: "design-doc" },
      ],
      ctx("route-on-gate"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")?.needsEdges).toEqual([
      { id: "clarify", on: ["failed", "skipped"] },
    ]);
  });

  it("route on defaults to succeeded-only when omitted", () => {
    const { dag } = resolvePipelineDag(
      [{ id: "clarify", entry: true, route: [{ to: "design-doc" }] }, { id: "design-doc" }],
      ctx("route-default-on"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")?.needsEdges).toEqual([{ id: "clarify", on: ["succeeded"] }]);
  });

  it("a stage with multiple route entries to distinct targets resolves all as forward edges (fan-out)", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route: [{ to: "design-doc" }, { to: "implementation-plan" }],
        },
        { id: "design-doc" },
        { id: "implementation-plan" },
      ],
      ctx("route-fan-out"),
    );
    expect(dag.childrenOf.clarify).toEqual(["design-doc", "implementation-plan"]);
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")?.ancestors).toEqual(["clarify"]);
    expect(byId.get("implementation-plan")?.ancestors).toEqual(["clarify"]);
  });

  it("multiple stages routing to the same target join it (implicit AND, any terminal state per source)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "research" }, { to: "validation" }] },
        { id: "research", route: [{ to: "synthesize" }] },
        { id: "validation", route: [{ to: "synthesize", on: "failed" }] },
        { id: "synthesize" },
      ],
      ctx("route-fan-in"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("synthesize")).toMatchObject({
      needs: null,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["failed"] },
      ],
      ancestors: ["clarify", "research", "validation"],
    });
    expect(dag.childrenOf.research).toEqual(["synthesize"]);
    expect(dag.childrenOf.validation).toEqual(["synthesize"]);
  });

  it("an explicit multi-entry declaration marks more than one stage as entry: true", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "implementation-plan" }] },
        { id: "design-doc", entry: true, route: [{ to: "implementation-plan" }] },
        { id: "implementation-plan" },
      ],
      ctx("route-multi-entry"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.entry).toBe(true);
    expect(byId.get("design-doc")?.entry).toBe(true);
    expect(byId.get("implementation-plan")?.entry).toBeUndefined();
    expect(dag.roots.sort()).toEqual(["clarify", "design-doc"]);
  });

  it("rejects a route entry naming an unknown stage id", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify", entry: true, route: [{ to: "missing-stage" }] }],
        ctx("route-unknown-target"),
      ),
    ).toThrow(/unknown route target "missing-stage"/i);
  });

  it("rejects a pipeline using route with no stage marked entry: true", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", route: [{ to: "design-doc" }] },
          { id: "design-doc" },
        ],
        ctx("route-missing-entry"),
      ),
    ).toThrow(/no stage is marked entry: true/i);
  });

  it("rejects a stage that is neither entry: true nor the target of any route entry", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
          { id: "design-doc" },
          { id: "implementation-plan" },
        ],
        ctx("route-unreachable"),
      ),
    ).toThrow(/stage "implementation-plan" is unreachable/i);
  });

  it("rejects a cycle formed purely from forward route entries", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
          { id: "design-doc", route: [{ to: "clarify" }] },
        ],
        ctx("route-cycle"),
      ),
    ).toThrow(/cycle/i);
  });

  it("rejects bare string items inside route (route entries must be structured objects)", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: ["design-doc"] as unknown as { to: string }[] },
          { id: "design-doc" },
        ],
        ctx("route-bare-string"),
      ),
    ).toThrow(/route item must be an object/i);
  });

  it("rejects an empty route array", () => {
    expect(() =>
      resolvePipelineDag([{ id: "clarify", route: [] }], ctx("route-empty")),
    ).toThrow(/route array must contain at least one item/i);
  });

  it("rejects duplicate targets within the same stage's route", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            route: [{ to: "design-doc" }, { to: "design-doc", on: "failed" }],
          },
          { id: "design-doc" },
        ],
        ctx("route-dup-target"),
      ),
    ).toThrow(/duplicate target "design-doc"/i);
  });

  it("rejects unknown keys on a route item", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            route: [{ to: "design-doc", label: "x" } as unknown as { to: string }],
          },
          { id: "design-doc" },
        ],
        ctx("route-unknown-key"),
      ),
    ).toThrow(/route item: unknown key "label"/i);
  });

  it("rejects entry: <non-boolean>", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify", entry: "yes" as unknown as boolean }],
        ctx("route-bad-entry"),
      ),
    ).toThrow(/entry must be a boolean/i);
  });

  it("needs, fork, and feedback_loop pipelines that never use route/entry are unaffected (no entry-stage requirement)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
        { id: "implementation-plan", needs: "clarify" },
      ],
      ctx("route-unused"),
    );
    expect(dag.roots).toEqual(["clarify"]);
    for (const node of dag.nodes) {
      expect(node.entry).toBeUndefined();
    }
  });
});

describe("loadPipeline: route YAML fixtures (ticket 01)", () => {
  it("loads a linear route chain end to end", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-linear"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({ entry: true, needsEdges: [] });
    expect(byId.get("design-doc")).toMatchObject({
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
    });
    expect(byId.get("implementation-plan")).toMatchObject({
      needs: "design-doc",
      needsEdges: [{ id: "design-doc", on: ["succeeded"] }],
    });
  });

  it("loads a pipeline with two entry: true stages", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-multi-entry"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.entry).toBe(true);
    expect(byId.get("design-doc")?.entry).toBe(true);
    expect(byId.get("implementation-plan")?.needsEdges).toEqual([
      { id: "clarify", on: ["succeeded"] },
      { id: "design-doc", on: ["succeeded"] },
    ]);
  });

  it("rejects an unknown route target via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-unknown-target"))).rejects.toThrow(
      /unknown route target "missing-stage"/i,
    );
  });

  it("rejects a route pipeline with no entry: true stage via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-missing-entry"))).rejects.toThrow(
      /no stage is marked entry: true/i,
    );
  });

  it("rejects an unreachable stage via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-unreachable"))).rejects.toThrow(
      /stage "implementation-plan" is unreachable/i,
    );
  });

  it("rejects a forward route cycle via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-cycle"))).rejects.toThrow(/cycle/i);
  });
});
