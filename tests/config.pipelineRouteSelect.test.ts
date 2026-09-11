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

describe("resolvePipelineDag: route_select / allow_none (ticket 02, branch selection)", () => {
  it("route_select: 'one' with >=2 forward entries populates node.fork with select 'one' and allow_none false by default", () => {
    const { dag } = resolvePipelineDag(
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
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toEqual({ select: "one", allow_none: false });
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b"]);
  });

  it("route_select: 'subset' populates node.fork with select 'subset'", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route_select: "subset",
          route: [{ to: "branch-a" }, { to: "branch-b" }, { to: "branch-c" }],
        },
        { id: "branch-a" },
        { id: "branch-b" },
        { id: "branch-c" },
      ],
      ctx("route-select-subset"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toEqual({ select: "subset", allow_none: false });
  });

  it("allow_none: true is reflected on node.fork.allow_none", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route_select: "subset",
          allow_none: true,
          route: [{ to: "branch-a" }, { to: "branch-b" }],
        },
        { id: "branch-a" },
        { id: "branch-b" },
      ],
      ctx("route-select-allow-none-true"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toEqual({ select: "subset", allow_none: true });
  });

  it("allow_none: false (explicit) still resolves allow_none false", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route_select: "one",
          allow_none: false,
          route: [{ to: "branch-a" }, { to: "branch-b" }],
        },
        { id: "branch-a" },
        { id: "branch-b" },
      ],
      ctx("route-select-allow-none-false"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toEqual({ select: "one", allow_none: false });
  });

  it("a plain multi-entry route without route_select stays an unconditional fan-out (no node.fork)", () => {
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
  });

  it("multiple stages routing to the same target join it, unaffected by an upstream route_select", () => {
    const { dag } = resolvePipelineDag(
      [
        {
          id: "clarify",
          entry: true,
          route_select: "one",
          route: [{ to: "branch-a" }, { to: "branch-b" }],
        },
        { id: "branch-a", route: [{ to: "join-doc" }] },
        { id: "branch-b", route: [{ to: "join-doc" }] },
        { id: "join-doc" },
      ],
      ctx("route-select-fan-in"),
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
  });

  it("rejects route_select on a stage with exactly one forward route entry (leaf rejection)", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route_select: "one", route: [{ to: "design-doc" }] },
          { id: "design-doc" },
        ],
        ctx("route-select-leaf"),
      ),
    ).toThrow(/route_select requires at least two forward route entries/i);
  });

  it("rejects route_select on a stage with no route entries at all", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify", route_select: "one" }],
        ctx("route-select-no-route"),
      ),
    ).toThrow(/route_select requires at least two forward route entries/i);
  });

  it("rejects an invalid route_select value", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            route_select: "all" as unknown as "one" | "subset",
            route: [{ to: "branch-a" }, { to: "branch-b" }],
          },
          { id: "branch-a" },
          { id: "branch-b" },
        ],
        ctx("route-select-invalid-value"),
      ),
    ).toThrow(/route_select must be "one" or "subset"/i);
  });

  it("rejects allow_none set without route_select, instead of silently dropping it", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            allow_none: true,
            route: [{ to: "design-doc" }, { to: "implementation-plan" }],
          },
          { id: "design-doc" },
          { id: "implementation-plan" },
        ],
        ctx("allow-none-without-route-select"),
      ),
    ).toThrow(/allow_none requires route_select/i);
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

describe("loadPipeline: route_select YAML fixtures (ticket 02)", () => {
  it("loads route_select: 'one' end to end with node.fork populated", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-one"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({
      entry: true,
      fork: { select: "one", allow_none: false },
    });
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b"]);
    expect(byId.get("join-doc")?.needsEdges).toEqual([
      { id: "branch-a", on: ["succeeded"] },
      { id: "branch-b", on: ["succeeded"] },
    ]);
  });

  it("loads route_select: 'subset' end to end with node.fork populated", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-subset"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({
      fork: { select: "subset", allow_none: false },
    });
    expect(dag.childrenOf.clarify).toEqual(["branch-a", "branch-b", "branch-c"]);
  });

  it("loads allow_none: true end to end", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-select-allow-none"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({
      fork: { select: "subset", allow_none: true },
    });
  });

  it("rejects the leaf-rejection fixture (route_select with one forward route entry) via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-select-leaf-rejection"))).rejects.toThrow(
      /route_select requires at least two forward route entries/i,
    );
  });
});
