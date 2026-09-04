import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, pipelinePath, SAMPLE_TASK, SINGLE_PIPELINE, DOCS_ONLY_PIPELINE, LINEAR_EXPLICIT_PIPELINE, BROKEN_PIPELINE, CYCLE_PIPELINE } from "./helpers/fixturePaths.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listStages } from "../src/config/listConfig.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  areResolvedDagsEquivalent,
  extractPipelineStageIds,
  parsePipelineStageEntries,
  resolvePipelineDag,
} from "../src/config/resolvePipelineDag.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned");
const stagesDir = path.join(fixtures, "stages");

const ctx = (pipelineId: string, relPath = "pipelines/test.pipeline.yaml") => ({
  pipelineId,
  path: path.join(fixtures, relPath),
});

describe("resolvePipelineDag", () => {
  it("builds explicit linear chain", () => {
    const { stages, dag } = resolvePipelineDag(
      [
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
        { id: "implementation-plan", needs: "design-doc" },
      ],
      ctx("docs-only", "pipelines/docs-only.pipeline.yaml"),
    );

    expect(stages).toEqual(["clarify", "design-doc", "implementation-plan"]);
    expect(dag.roots).toEqual(["clarify"]);
    expect(dag.nodes.map((node) => node.id)).toEqual([
      "clarify",
      "design-doc",
      "implementation-plan",
    ]);

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")).toMatchObject({ needs: null, ancestors: [] });
    expect(byId.get("design-doc")).toMatchObject({
      needs: "clarify",
      ancestors: ["clarify"],
    });
    expect(byId.get("implementation-plan")).toMatchObject({
      needs: "design-doc",
      ancestors: ["clarify", "design-doc"],
    });
  });

  it("builds fan-out fork (AE2)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
        { id: "implementation-plan", needs: "clarify" },
      ],
      ctx("parallel-after-clarify"),
    );

    expect(dag.roots).toEqual(["clarify"]);
    expect(dag.childrenOf.clarify).toEqual(["design-doc", "implementation-plan"]);

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")).toMatchObject({
      needs: "clarify",
      ancestors: ["clarify"],
    });
    expect(byId.get("implementation-plan")).toMatchObject({
      needs: "clarify",
      ancestors: ["clarify"],
    });
  });

  it("rejects bare string stage refs (AE7)", () => {
    expect(() =>
      resolvePipelineDag(["decide", "branch-a"], ctx("string-refs")),
    ).toThrow(/bare string stage refs/i);
  });

  it("rejects dependency cycles (AE3)", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", needs: "design-doc" },
          { id: "design-doc", needs: "clarify" },
        ],
        ctx("cycle"),
      ),
    ).toThrow(/cycle/i);
  });

  it("rejects unknown needs targets (AE4)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify" }, { id: "design-doc", needs: "missing-stage" }],
        ctx("unknown-needs"),
      ),
    ).toThrow(/unknown needs "missing-stage"/i);
  });

  it("rejects duplicate stage ids (AE5)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify" }, { id: "design-doc" }, { id: "clarify" }],
        ctx("duplicate-stage.pipeline"),
      ),
    ).toThrow(/duplicate stage "clarify"/i);
  });

  it("rejects fan-in needs arrays (R10)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "join", needs: ["clarify", "design-doc"] as unknown as string }],
        ctx("fan-in"),
      ),
    ).toThrow(/fan-in not supported/i);
  });

  it("rejects one-element needs arrays (AS3)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "design-doc", needs: ["clarify"] as unknown as string }],
        ctx("needs-array"),
      ),
    ).toThrow(/needs must be a string, not an array/i);
  });

  it("rejects malformed stage entries", () => {
    expect(() => resolvePipelineDag([], ctx("empty"))).toThrow(/non-empty/i);
    expect(() => resolvePipelineDag([""], ctx("blank-id"))).toThrow(/bare string stage refs/i);
    expect(() => resolvePipelineDag([{ needs: "clarify" }], ctx("missing-id"))).toThrow(
      /id must be a non-empty string/i,
    );
    expect(() =>
      resolvePipelineDag([{ id: "clarify", needs: 42 }], ctx("bad-needs")),
    ).toThrow(/needs must be a non-empty string/i);
    expect(() =>
      resolvePipelineDag([{ id: "clarify", label: "x" }], ctx("unknown-key")),
    ).toThrow(/unknown key "label"/i);
  });

  it("accepts pre_emit_checks as a body key on a stage entry", () => {
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            pre_emit_checks: [
              { id: "gate-1", type: "gate", kind: "confirm" },
            ],
          } as unknown as { id: string },
        ],
        ctx("pre-emit-checks"),
      ),
    ).not.toThrow();
  });

  it("AE1: fork select:one on a two-child stage sets fork on resolved node", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "decide", fork: { select: "one" } },
        { id: "branch-a", needs: "decide" },
        { id: "branch-b", needs: "decide" },
      ],
      ctx("fork-one"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("decide")?.fork).toEqual({ select: "one", allow_none: false });
    expect(byId.get("branch-a")?.fork).toBeUndefined();
  });

  it("AE2: fork select:subset with allow_none:true sets fork on resolved node", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "decide", fork: { select: "subset", allow_none: true } },
        { id: "b", needs: "decide" },
        { id: "c", needs: "decide" },
        { id: "d", needs: "decide" },
      ],
      ctx("fork-subset"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("decide")?.fork).toEqual({ select: "subset", allow_none: true });
  });

  it("AE3: fork on a leaf stage is rejected", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "decide", fork: { select: "one" } }],
        ctx("fork-leaf"),
      ),
    ).toThrow(/fork on stage "decide": no children/i);
  });

  it("AE4: fork without select is rejected", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "decide", fork: { allow_none: false } as { select: "one" | "subset"; allow_none?: boolean } },
          { id: "branch-a", needs: "decide" },
        ],
        ctx("fork-no-select"),
      ),
    ).toThrow(/select/i);
  });

  it("AE5: fork with unknown key is rejected", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "decide", fork: { select: "one", mode: "exclusive" } as unknown as { select: "one" | "subset" } },
          { id: "branch-a", needs: "decide" },
        ],
        ctx("fork-unknown-key"),
      ),
    ).toThrow(/fork: unknown key "mode"/i);
  });

  it("AE6: existing fan-out pipeline without fork field is unaffected", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
        { id: "implementation-plan", needs: "clarify" },
      ],
      ctx("no-fork"),
    );
    for (const node of dag.nodes) {
      expect(node.fork).toBeUndefined();
    }
  });

  it("extractPipelineStageIds rejects string entries", () => {
    expect(extractPipelineStageIds(["clarify", "design-doc"])).toBeNull();
    expect(
      extractPipelineStageIds([
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
      ]),
    ).toEqual(["clarify", "design-doc"]);
    expect(extractPipelineStageIds([{ id: "clarify", extra: true }])).toBeNull();
    expect(extractPipelineStageIds([])).toBeNull();
  });

  it("parsePipelineStageEntries preserves declaration order for object refs", () => {
    const entries = parsePipelineStageEntries(
      [{ id: "clarify" }, { id: "design-doc", needs: "clarify" }],
      ctx("object-form"),
    );
    expect(entries).toEqual([
      { id: "clarify" },
      { id: "design-doc", needs: "clarify" },
    ]);
  });

  it("parsePipelineStageEntries copies clonable and clone_cap when present", () => {
    const entries = parsePipelineStageEntries(
      [{ id: "author", clonable: true, clone_cap: 3 }],
      ctx("clonable-parse"),
    );
    expect(entries).toEqual([{ id: "author", clonable: true, clone_cap: 3 }]);
  });

  it("extractPipelineStageIds accepts clonable keys on object entries", () => {
    expect(
      extractPipelineStageIds([
        { id: "detect" },
        { id: "author", needs: "detect", clonable: true },
        { id: "collect", needs: "author" },
      ]),
    ).toEqual(["detect", "author", "collect"]);
  });

  it("AE1: clonable without clone_cap defaults to 5; siblings omit fields", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "detect" },
        { id: "author", needs: "detect", clonable: true },
        { id: "collect", needs: "author" },
      ],
      ctx("clonable-default"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("author")).toMatchObject({ clonable: true, clone_cap: 5 });
    expect(byId.get("detect")?.clonable).toBeUndefined();
    expect(byId.get("detect")?.clone_cap).toBeUndefined();
    expect(byId.get("collect")?.clonable).toBeUndefined();
    expect(byId.get("collect")?.clone_cap).toBeUndefined();
  });

  it("AE2: explicit clone_cap 3 is stored on the clonable node", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "detect" },
        { id: "author", needs: "detect", clonable: true, clone_cap: 3 },
        { id: "collect", needs: "author" },
      ],
      ctx("clonable-cap-3"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("author")).toMatchObject({ clonable: true, clone_cap: 3 });
  });

  it("AE4: clone_cap without clonable is rejected", () => {
    const run = () =>
      resolvePipelineDag(
        [
          { id: "detect" },
          { id: "author", needs: "detect", clone_cap: 5 },
          { id: "collect", needs: "author" },
        ],
        ctx("cap-without-flag"),
      );
    expect(run).toThrow(/clone_cap/);
    expect(run).toThrow(/clonable/);
  });

  it.each([1, 6.5, 0])("AE5: clone_cap %s is rejected", (cloneCap) => {
    const run = () =>
      resolvePipelineDag(
        [
          { id: "detect" },
          { id: "author", needs: "detect", clonable: true, clone_cap: cloneCap },
          { id: "collect", needs: "author" },
        ],
        ctx("bad-clone-cap"),
      );
    expect(run).toThrow(/clone_cap/);
    expect(run).toThrow(/2/);
  });

  it("AE6: clonable on a leaf stage is rejected", () => {
    expect(() =>
      resolvePipelineDag([{ id: "leaf", clonable: true }], ctx("clonable-leaf")),
    ).toThrow(/clonable.*leaf.*no children/i);
  });

  it("clonable: false on a non-leaf omits resolved clonable fields", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "detect" },
        { id: "author", needs: "detect", clonable: false },
        { id: "collect", needs: "author" },
      ],
      ctx("clonable-false"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("author")?.clonable).toBeUndefined();
    expect(byId.get("author")?.clone_cap).toBeUndefined();
  });

  it("clone_cap with clonable: false is rejected", () => {
    const run = () =>
      resolvePipelineDag(
        [
          { id: "detect" },
          { id: "author", needs: "detect", clonable: false, clone_cap: 5 },
          { id: "collect", needs: "author" },
        ],
        ctx("cap-with-flag-false"),
      );
    expect(run).toThrow(/clone_cap/);
    expect(run).toThrow(/clonable/);
  });

  it("allows fork and clonable on the same entry", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "detect" },
        { id: "author", needs: "detect", clonable: true, fork: { select: "one" } },
        { id: "collect", needs: "author" },
      ],
      ctx("fork-and-clonable"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("author")?.clonable).toBe(true);
    expect(byId.get("author")?.clone_cap).toBe(5);
    expect(byId.get("author")?.fork).toEqual({ select: "one", allow_none: false });
  });
});

describe("listPipelineUsageByStage with object-form pipelines", () => {
  it("listStages returns empty in pipeline-owned model", async () => {
    const stages = await listStages();
    expect(stages).toEqual([]);
  });
});

describe("loadPipeline negative DAG fixtures", () => {
  it("rejects cycle via pipeline-owned temp fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-dag-cycle-"));
    await writeFile(
      path.join(dir, "cycle.pipeline.yaml"),
      [
        "id: cycle",
        "stages:",
        "  - id: a",
        "    needs: b",
        "    system_prompt: x",
        "    model: m",
        "  - id: b",
        "    needs: a",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(path.join(dir, "cycle.pipeline.yaml"))).rejects.toThrow(
      /cycle/i,
    );
  });

  it("rejects unknown-needs via pipeline-owned temp fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-dag-unknown-"));
    await writeFile(
      path.join(dir, "unknown.pipeline.yaml"),
      [
        "id: unknown",
        "stages:",
        "  - id: clarify",
        "    system_prompt: x",
        "    model: m",
        "  - id: design-doc",
        "    needs: missing-stage",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(path.join(dir, "unknown.pipeline.yaml"))).rejects.toThrow(
      /unknown needs/i,
    );
  });

  it("rejects duplicate-stage via pipeline-owned temp fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-dag-dup-"));
    await writeFile(
      path.join(dir, "dup.pipeline.yaml"),
      [
        "id: dup",
        "stages:",
        "  - id: clarify",
        "    system_prompt: x",
        "    model: m",
        "  - id: design-doc",
        "    system_prompt: x",
        "    model: m",
        "  - id: clarify",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(path.join(dir, "dup.pipeline.yaml"))).rejects.toThrow(
      /duplicate stage/i,
    );
  });
});

describe("loadPipeline fork fixtures", () => {
  it("fork-uses pipeline loads and sets fork on the deciding node", async () => {
    const { dag } = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("decide")?.fork).toEqual({ select: "one", allow_none: false });
    expect(byId.get("branch-a")?.fork).toBeUndefined();
    expect(byId.get("branch-b")?.fork).toBeUndefined();
  });
});

describe("loadPipeline clonable fixtures", () => {
  it("AE1: clonable-default-cap loads with default clone_cap 5", async () => {
    const { dag } = await loadPipeline(pipelinePath("clonable-default-cap"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("design-doc")).toMatchObject({ clonable: true, clone_cap: 5 });
    expect(byId.get("clarify")?.clonable).toBeUndefined();
    expect(byId.get("clarify")?.clone_cap).toBeUndefined();
    expect(byId.get("implementation-plan")?.clonable).toBeUndefined();
    expect(byId.get("implementation-plan")?.clone_cap).toBeUndefined();
  });

  it("AE7: fork-one-of-two leaves clonable fields absent on every node", async () => {
    const { dag } = await loadPipeline(pipelinePath("fork-one-of-two"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("clarify")?.fork).toEqual({ select: "one", allow_none: false });
    for (const node of dag.nodes) {
      expect(node.clonable).toBeUndefined();
      expect(node.clone_cap).toBeUndefined();
    }
  });
});
