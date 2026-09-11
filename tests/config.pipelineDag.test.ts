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
  it("treats feedback-loop and replay-safety policy changes as inequivalent", () => {
    const { dag: baseline } = resolvePipelineDag(
      [
        { id: "plan" },
        { id: "implement", needs: "plan" },
        {
          id: "review",
          needs: "implement",
          feedback_loop: {
            target: "implement",
            max_replays: 2,
            on_max_replays: "require_continue",
            replay_session: "resume",
          },
        },
        { id: "submit", needs: "review" },
      ],
      ctx("feedback-equivalence-baseline"),
    );
    const { dag: changedPolicy } = resolvePipelineDag(
      [
        { id: "plan" },
        { id: "implement", needs: "plan" },
        {
          id: "review",
          needs: "implement",
          feedback_loop: {
            target: "plan",
            max_replays: 3,
            on_max_replays: "wait_for_human",
            replay_session: "new_session",
          },
        },
        { id: "submit", needs: "review", replay_safe: false },
      ],
      ctx("feedback-equivalence-changed"),
    );

    expect(areResolvedDagsEquivalent(baseline, changedPolicy)).toBe(false);
  });

  it("builds explicit linear chain via route/entry", () => {
    const { stages, dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc", route: [{ to: "implementation-plan" }] },
        { id: "implementation-plan" },
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
    expect(byId.get("clarify")).toMatchObject({
      needs: null,
      needsEdges: [],
      ancestors: [],
    });
    expect(byId.get("design-doc")).toMatchObject({
      needs: "clarify",
      needsEdges: [{ id: "clarify", on: ["succeeded"] }],
      ancestors: ["clarify"],
    });
    expect(byId.get("implementation-plan")).toMatchObject({
      needs: "design-doc",
      needsEdges: [{ id: "design-doc", on: ["succeeded"] }],
      ancestors: ["clarify", "design-doc"],
    });
  });

  it("builds fan-out via route (AE2)", () => {
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

  it("rejects dependency cycles formed via route (AE3)", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
          { id: "design-doc", route: [{ to: "clarify" }] },
        ],
        ctx("cycle"),
      ),
    ).toThrow(/cycle/i);
  });

  it("rejects unknown route targets (AE4)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify", entry: true, route: [{ to: "missing-stage" }] }],
        ctx("unknown-route-target"),
      ),
    ).toThrow(/unknown route target "missing-stage"/i);
  });

  it("rejects duplicate stage ids (AE5)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify" }, { id: "design-doc" }, { id: "clarify" }],
        ctx("duplicate-stage.pipeline"),
      ),
    ).toThrow(/duplicate stage "clarify"/i);
  });

  it("accepts multiple route entries into the same target and normalizes on gates", () => {
    // Migrated from a `needs`-side fan-in test (`synthesize` listing two
    // parents, one with an explicit multi-state `on`). Under `route` the same
    // per-edge gate is achievable, just declared outbound by each source
    // stage instead of inbound by the target — see the `route-fan-in` case in
    // tests/config.pipelineRoute.test.ts for the ticket-01 equivalent.
    const { dag } = resolvePipelineDag(
      [
        { id: "research", entry: true, route: [{ to: "synthesize" }] },
        {
          id: "validation",
          entry: true,
          route: [{ to: "synthesize", on: ["succeeded", "failed", "skipped"] }],
        },
        { id: "synthesize" },
      ],
      ctx("mixed-route-on"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("synthesize")).toMatchObject({
      needs: null,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded", "failed", "skipped"] },
      ],
      ancestors: ["research", "validation"],
    });
    expect(dag.childrenOf.research).toEqual(["synthesize"]);
    expect(dag.childrenOf.validation).toEqual(["synthesize"]);
  });

  it("rejects invalid route on values", () => {
    // Migrated from "rejects empty or invalid needs on sets" — `on`
    // validation is shared logic (parseRouteOn mirrors parsePipelineNeeds'
    // on-parsing) so the same three failure modes apply.
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc", on: [] }] },
          { id: "design-doc" },
        ],
        ctx("empty-on"),
      ),
    ).toThrow(/on must be a non-empty unique subset/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc", on: ["running"] }] },
          { id: "design-doc" },
        ],
        ctx("bad-on"),
      ),
    ).toThrow(/on must be a non-empty unique subset/i);
    expect(() =>
      resolvePipelineDag(
        [
          {
            id: "clarify",
            entry: true,
            route: [{ to: "design-doc", on: ["succeeded", "succeeded"] }],
          },
          { id: "design-doc" },
        ],
        ctx("dup-on"),
      ),
    ).toThrow(/on must be a non-empty unique subset/i);
  });

  it("rejects an unknown route target reached via fan-out", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "research" }, { to: "missing-stage" }] },
          { id: "research" },
        ],
        ctx("unknown-multi-route"),
      ),
    ).toThrow(/unknown route target "missing-stage"/i);
  });

  it("rejects a cycle reached via a fan-in edge", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "a", entry: true, route: [{ to: "c" }] },
          { id: "b", entry: true, route: [{ to: "c" }] },
          { id: "c", route: [{ to: "a" }] },
        ],
        ctx("multi-parent-loop"),
      ),
    ).toThrow(/cycle/i);
  });

  it("resolves a diamond DAG with two inbound edges into synthesize", () => {
    const { stages, dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "research" }, { to: "validation" }] },
        { id: "research", route: [{ to: "synthesize" }] },
        { id: "validation", route: [{ to: "synthesize" }] },
        { id: "synthesize" },
      ],
      ctx("diamond"),
    );

    expect(stages).toEqual(["clarify", "research", "validation", "synthesize"]);
    expect(dag.roots).toEqual(["clarify"]);
    expect(dag.nodes.map((node) => node.id)).toEqual([
      "clarify",
      "research",
      "validation",
      "synthesize",
    ]);
    expect(dag.childrenOf.clarify).toEqual(["research", "validation"]);
    expect(dag.childrenOf.research).toEqual(["synthesize"]);
    expect(dag.childrenOf.validation).toEqual(["synthesize"]);
    expect(dag.childrenOf.synthesize).toEqual([]);

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("synthesize")).toMatchObject({
      needs: null,
      needsEdges: [
        { id: "research", on: ["succeeded"] },
        { id: "validation", on: ["succeeded"] },
      ],
      ancestors: ["clarify", "research", "validation"],
    });
  });

  it("treats DAGs with matching multi-parent edges as equivalent", () => {
    const diamond = [
      { id: "clarify", entry: true, route: [{ to: "research" }, { to: "validation" }] },
      { id: "research", route: [{ to: "synthesize" }] },
      { id: "validation", route: [{ to: "synthesize" }] },
      { id: "synthesize" },
    ];
    const { dag: a } = resolvePipelineDag(diamond, ctx("equiv-a"));
    const { dag: b } = resolvePipelineDag(diamond, ctx("equiv-b"));
    expect(areResolvedDagsEquivalent(a, b)).toBe(true);

    const { dag: differentOn } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "research" }, { to: "validation" }] },
        { id: "research", route: [{ to: "synthesize" }] },
        { id: "validation", route: [{ to: "synthesize", on: ["succeeded", "failed"] }] },
        { id: "synthesize" },
      ],
      ctx("equiv-on"),
    );
    expect(areResolvedDagsEquivalent(a, differentOn)).toBe(false);
  });

  it("rejects malformed stage entries", () => {
    expect(() => resolvePipelineDag([], ctx("empty"))).toThrow(/non-empty/i);
    expect(() => resolvePipelineDag([""], ctx("blank-id"))).toThrow(/bare string stage refs/i);
    expect(() =>
      resolvePipelineDag([{ route: [{ to: "clarify" }] }], ctx("missing-id")),
    ).toThrow(/id must be a non-empty string/i);
    expect(() =>
      resolvePipelineDag([{ id: "clarify", route: 42 }], ctx("bad-route")),
    ).toThrow(/route must be a non-empty array/i);
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
        {
          id: "clarify",
          entry: true,
          route: [{ to: "design-doc" }, { to: "implementation-plan" }],
        },
        { id: "design-doc" },
        { id: "implementation-plan" },
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
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc" },
      ]),
    ).toEqual(["clarify", "design-doc"]);
    expect(extractPipelineStageIds([{ id: "clarify", extra: true }])).toBeNull();
    expect(extractPipelineStageIds([])).toBeNull();
  });

  it("parsePipelineStageEntries preserves declaration order for object refs", () => {
    const entries = parsePipelineStageEntries(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc" },
      ],
      ctx("object-form"),
    );
    expect(entries).toEqual([
      { id: "clarify", entry: true, route: [{ to: "design-doc", on: ["succeeded"] }] },
      { id: "design-doc" },
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
        { id: "detect", entry: true, route: [{ to: "author" }] },
        { id: "author", clonable: true, route: [{ to: "collect" }] },
        { id: "collect" },
      ]),
    ).toEqual(["detect", "author", "collect"]);
  });

  it("extractPipelineStageIds accepts route entries fanning into a shared target", () => {
    expect(
      extractPipelineStageIds([
        { id: "research", entry: true, route: [{ to: "synthesize" }] },
        { id: "validation", entry: true, route: [{ to: "synthesize" }] },
        { id: "synthesize" },
      ]),
    ).toEqual(["research", "validation", "synthesize"]);
    expect(
      extractPipelineStageIds([{ id: "design-doc", route: [{ to: "clarify" }] }]),
    ).toEqual(["design-doc"]);
  });

  it("parsePipelineStageEntries normalizes route on gates", () => {
    const entries = parsePipelineStageEntries(
      [
        { id: "research", entry: true, route: [{ to: "synthesize" }] },
        {
          id: "validation",
          entry: true,
          route: [{ to: "synthesize", on: ["failed", "skipped"] }],
        },
        { id: "synthesize" },
      ],
      ctx("parse-mixed-route"),
    );
    expect(entries).toEqual([
      { id: "research", entry: true, route: [{ to: "synthesize", on: ["succeeded"] }] },
      { id: "validation", entry: true, route: [{ to: "synthesize", on: ["failed", "skipped"] }] },
      { id: "synthesize" },
    ]);
  });

  it("AE1: clonable without clone_cap defaults to 5; siblings omit fields", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "detect", entry: true, route: [{ to: "author" }] },
        { id: "author", clonable: true, route: [{ to: "collect" }] },
        { id: "collect" },
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
        { id: "detect", entry: true, route: [{ to: "author" }] },
        { id: "author", clonable: true, clone_cap: 3, route: [{ to: "collect" }] },
        { id: "collect" },
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
          { id: "detect", entry: true, route: [{ to: "author" }] },
          { id: "author", clone_cap: 5, route: [{ to: "collect" }] },
          { id: "collect" },
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
          { id: "detect", entry: true, route: [{ to: "author" }] },
          { id: "author", clonable: true, clone_cap: cloneCap, route: [{ to: "collect" }] },
          { id: "collect" },
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
        { id: "detect", entry: true, route: [{ to: "author" }] },
        { id: "author", clonable: false, route: [{ to: "collect" }] },
        { id: "collect" },
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
          { id: "detect", entry: true, route: [{ to: "author" }] },
          { id: "author", clonable: false, clone_cap: 5, route: [{ to: "collect" }] },
          { id: "collect" },
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
        "    entry: true",
        "    route:",
        "      - to: b",
        "    system_prompt: x",
        "    model: m",
        "  - id: b",
        "    route:",
        "      - to: a",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(path.join(dir, "cycle.pipeline.yaml"))).rejects.toThrow(
      /cycle/i,
    );
  });

  it("loads a fan-in with per-source on gates via pipeline-owned temp fixture", async () => {
    // Migrated from a `needs`-side per-parent-gating fixture ("wait for
    // research succeeded AND validation on [succeeded, failed, skipped]").
    // Under `route` the same per-edge gate is declared outbound by each
    // source stage instead of inbound by the target; the resulting
    // needsEdges are identical, so no coverage is lost — see the
    // `route-fan-in` fixture in tests/config.pipelineRoute.test.ts.
    const dir = await mkdtemp(path.join(tmpdir(), "sf-dag-mixed-"));
    await writeFile(
      path.join(dir, "mixed.pipeline.yaml"),
      [
        "id: mixed",
        "stages:",
        "  - id: research",
        "    entry: true",
        "    route:",
        "      - to: synthesize",
        "    system_prompt: x",
        "    model: m",
        "  - id: validation",
        "    entry: true",
        "    route:",
        "      - to: synthesize",
        "        on: [succeeded, failed, skipped]",
        "    system_prompt: x",
        "    model: m",
        "  - id: synthesize",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    const { dag } = await loadPipeline(path.join(dir, "mixed.pipeline.yaml"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("synthesize")?.needsEdges).toEqual([
      { id: "research", on: ["succeeded"] },
      { id: "validation", on: ["succeeded", "failed", "skipped"] },
    ]);
  });

  it("rejects an unknown route target via pipeline-owned temp fixture", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-dag-unknown-"));
    await writeFile(
      path.join(dir, "unknown.pipeline.yaml"),
      [
        "id: unknown",
        "stages:",
        "  - id: clarify",
        "    entry: true",
        "    route:",
        "      - to: missing-stage",
        "    system_prompt: x",
        "    model: m",
        "",
      ].join("\n"),
    );
    await expect(loadPipeline(path.join(dir, "unknown.pipeline.yaml"))).rejects.toThrow(
      /unknown route target/i,
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
