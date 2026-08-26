import { describe, expect, it } from "vitest";
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

const ctx = (pipelineId: string, relPath = "pipelines/test.yaml") => ({
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
      ctx("docs-only", "pipelines/docs-only.yaml"),
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
        ctx("duplicate-stage"),
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
});

describe("listPipelineUsageByStage with object-form pipelines", () => {
  it("indexes clarify usage from object-form pipeline yaml", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "sf-dag-usage-"));
    await mkdir(path.join(tmpRoot, "pipelines"), { recursive: true });
    await mkdir(path.join(tmpRoot, "stages"), { recursive: true });
    await writeFile(
      path.join(tmpRoot, "stages", "clarify.yaml"),
      await readFile(path.join(stagesDir, "clarify.yaml"), "utf8"),
    );
    await writeFile(
      path.join(tmpRoot, "pipelines", "parallel-after-clarify.yaml"),
      [
        "id: parallel-after-clarify",
        "stages:",
        "  - id: clarify",
        "  - id: design-doc",
        "    needs: clarify",
        "",
      ].join("\n"),
    );

    const stages = await listStages(tmpRoot);
    const clarify = stages.find((stage) => stage.id === "clarify");
    expect(clarify && "used_by_pipeline_ids" in clarify
      ? clarify.used_by_pipeline_ids
      : undefined,
    ).toEqual(["parallel-after-clarify"]);
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
