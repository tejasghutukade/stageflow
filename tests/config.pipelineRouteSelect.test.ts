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

describe("resolvePipelineDag: route_select / allow_none rejected", () => {
  it("rejects route_select", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            route_select: "one",
            route: [{ to: "branch-a" }, { to: "branch-b" }],
          },
          { id: "branch-a" },
          { id: "branch-b" },
        ],
        ctx("route-select-one"),
      ),
    ).toThrow(
      /stage "clarify": "route_select" is no longer supported — listed route targets always run/,
    );
  });

  it("rejects allow_none", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            allow_none: true,
            route: [{ to: "branch-a" }, { to: "branch-b" }],
          },
          { id: "branch-a" },
          { id: "branch-b" },
        ],
        ctx("allow-none-without-route-select"),
      ),
    ).toThrow(
      /stage "clarify": "allow_none" is no longer supported — listed route targets always run/,
    );
  });

  it("rejects route_select on a leaf", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route_select: "one", route: [{ to: "design-doc" }] },
          { id: "design-doc" },
        ],
        ctx("route-select-leaf"),
      ),
    ).toThrow(
      /stage "clarify": "route_select" is no longer supported — listed route targets always run/,
    );
  });

  it("a plain multi-entry route stays an unconditional fan-out (no node.fork)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "branch-a" }, { to: "branch-b" }] },
        { id: "branch-a" },
        { id: "branch-b" },
      ],
      ctx("route-select-unused"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toBeUndefined();
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b"]);
  });

  it("multiple stages routing to the same target join it", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route: [{ to: "branch-a" }, { to: "branch-b" }],
        },
        { id: "branch-a", route: [{ to: "join-doc" }] },
        { id: "branch-b", route: [{ to: "join-doc" }] },
        { id: "join-doc" },
      ],
      ctx("route-fan-in"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("join-doc")).toMatchObject({
      needs: null,
      needsEdges: [
        { id: "branch-a", on: ["succeeded"] },
        { id: "branch-b", on: ["succeeded"] },
      ],
      ancestors: ["clarify", "branch-a", "branch-b"],
    });
    expect(byId.get("clarify")?.fork).toBeUndefined();
  });

  it("pipelines with no route_select at all are unaffected (no fork synthesized)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }, { to: "implementation-plan" }] },
        { id: "design-doc" },
        { id: "implementation-plan" },
      ],
      ctx("route-select-unused"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toBeUndefined();
  });
});

describe("loadPipeline: route YAML fixtures", () => {
  it("loads a multi-entry route as fan-out with node.fork undefined", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-one"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({
      entry: true,
    });
    expect(byId.get("clarify")?.fork).toBeUndefined();
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b"]);
    expect(byId.get("join-doc")?.needsEdges).toEqual([
      { id: "branch-a", on: ["succeeded"] },
      { id: "branch-b", on: ["succeeded"] },
    ]);
  });

  it("loads a three-target route as fan-out with node.fork undefined", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-subset"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toBeUndefined();
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b", "branch-c"]);
  });

  it("loads the former allow_none fixture as fan-out", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-allow-none"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toBeUndefined();
  });

  it("rejects the leaf-rejection fixture via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-select-leaf-rejection"))).rejects.toThrow(
      /stage "clarify": "route_select" is no longer supported — listed route targets always run/,
    );
  });
});
