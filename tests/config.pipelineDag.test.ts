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
const stagesDir = path.join(fixtures, "stages");

const ctx = (pipelineId: string, relPath = "pipelines/test.yaml") => ({
  pipelineId,
  path: path.join(fixtures, relPath),
});

describe("resolvePipelineDag", () => {
  it("normalizes legacy linear chain (AE1)", () => {
    const { stages, dag } = resolvePipelineDag(
      ["clarify", "design-doc", "implementation-plan"],
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

  it("treats explicit linear as equivalent to legacy (AE6)", () => {
    const legacy = resolvePipelineDag(
      ["clarify", "design-doc", "implementation-plan"],
      ctx("docs-only"),
    );
    const explicit = resolvePipelineDag(
      [
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
        { id: "implementation-plan", needs: "design-doc" },
      ],
      ctx("linear-explicit"),
    );

    expect(areResolvedDagsEquivalent(legacy.dag, explicit.dag)).toBe(true);
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
      resolvePipelineDag(["clarify", "design-doc", "clarify"], ctx("duplicate-stage")),
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
    expect(() => resolvePipelineDag([""], ctx("blank-id"))).toThrow(/invalid stage entry/i);
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

  it("extractPipelineStageIds accepts legacy strings and object refs", () => {
    expect(extractPipelineStageIds(["clarify", "design-doc"])).toEqual([
      "clarify",
      "design-doc",
    ]);
    expect(
      extractPipelineStageIds([
        { id: "clarify" },
        { id: "design-doc", needs: "clarify" },
      ]),
    ).toEqual(["clarify", "design-doc"]);
    expect(extractPipelineStageIds([{ id: "clarify", extra: true }])).toBeNull();
    expect(extractPipelineStageIds([])).toBeNull();
  });

  it("parsePipelineStageEntries preserves declaration order indices", () => {
    const entries = parsePipelineStageEntries(
      ["clarify", { id: "design-doc", needs: "clarify" }],
      ctx("mixed"),
    );
    expect(entries).toEqual(["clarify", { id: "design-doc", needs: "clarify" }]);
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
  it("rejects cycle.yaml via loadPipeline", async () => {
    await expect(
      loadPipeline("cycle", { cwd: fixtures, stagesDir }),
    ).rejects.toThrow(/cycle/i);
  });

  it("rejects unknown-needs.yaml via loadPipeline", async () => {
    await expect(
      loadPipeline("unknown-needs", { cwd: fixtures, stagesDir }),
    ).rejects.toThrow(/unknown needs/i);
  });

  it("rejects duplicate-stage.yaml via loadPipeline", async () => {
    await expect(
      loadPipeline("duplicate-stage", { cwd: fixtures, stagesDir }),
    ).rejects.toThrow(/duplicate stage/i);
  });
});
