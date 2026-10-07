import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import {
  areResolvedDagsEquivalent,
  extractPipelineStageIds,
  resolvePipelineDag,
} from "../src/config/resolvePipelineDag.js";
import {
  normalizePipelineStageEntries,
  toWiringRefs,
} from "../src/config/normalizePipelineStageEntry.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const owned = path.join(fixtures, "pipeline-owned");

const ctx = (pipelineId: string, relPath = "pipelines/test.pipeline.yaml") => ({
  pipelineId,
  path: path.join(fixtures, relPath),
});

describe("resolvePipelineDag", () => {
  const policyBaseline = (loop: Record<string, unknown>, submit: Record<string, unknown> = {}) => [
    { id: "plan", entry: true, route: [{ to: "implement" }] },
    { id: "implement", route: [{ to: "review" }] },
    {
      id: "review",
      route: [
        { to: "submit" },
        {
          type: "loop",
          to: "implement",
          max_replays: 2,
          on_max_replays: "require_continue",
          replay_session: "resume",
          ...loop,
        },
      ],
    },
    { id: "submit", ...submit },
  ];

  it("treats identical feedback-loop policy as equivalent", () => {
    const { dag: a } = resolvePipelineDag(policyBaseline({}), ctx("policy-a"));
    const { dag: b } = resolvePipelineDag(policyBaseline({}), ctx("policy-b"));
    expect(areResolvedDagsEquivalent(a, b)).toBe(true);
  });

  it.each([
    { field: "loop target", loop: { to: "plan" }, submit: {} },
    { field: "max_replays", loop: { max_replays: 3 }, submit: {} },
    { field: "on_max_replays", loop: { on_max_replays: "wait_for_human" }, submit: {} },
    { field: "replay_session", loop: { replay_session: "new_session" }, submit: {} },
    { field: "replay_safe", loop: {}, submit: { replay_safe: false } },
  ])("treats a changed $field as inequivalent", ({ loop, submit }) => {
    const { dag: baseline } = resolvePipelineDag(policyBaseline({}), ctx("policy-base"));
    const { dag: changed } = resolvePipelineDag(policyBaseline(loop, submit), ctx("policy-changed"));
    expect(areResolvedDagsEquivalent(baseline, changed)).toBe(false);
  });

  it("rejects bare string stage refs (AE7)", () => {
    expect(() =>
      resolvePipelineDag(["decide", "branch-a"], ctx("string-refs")),
    ).toThrow(/bare string stage refs/i);
  });

  it("rejects duplicate stage ids (AE5)", () => {
    expect(() =>
      resolvePipelineDag(
        [{ id: "clarify" }, { id: "design-doc" }, { id: "clarify" }],
        ctx("duplicate-stage.pipeline"),
      ),
    ).toThrow(/duplicate stage id "clarify"/i);
  });

  it.each([
    { name: "empty", on: [] },
    { name: "unknown state", on: ["running"] },
    { name: "duplicate", on: ["succeeded", "succeeded"] },
  ])("rejects $name route on values", ({ on }) => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "clarify", entry: true, route: [{ to: "design-doc", on }] },
          { id: "design-doc" },
        ],
        ctx("bad-on"),
      ),
    ).toThrow(/on must be a non-empty unique subset/i);
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

  it("treats matching edge if as equivalent and different if as not (AE2)", () => {
    const gated = [
      {
        id: "triage",
        entry: true,
        route: [{ to: "page", if: { field: "ok", op: "eq", value: true } }],
      },
      { id: "page" },
    ];
    const { dag: matchingA } = resolvePipelineDag(gated, ctx("if-equiv-a"));
    const { dag: matchingB } = resolvePipelineDag(gated, ctx("if-equiv-b"));
    expect(areResolvedDagsEquivalent(matchingA, matchingB)).toBe(true);

    const { dag: differentIf } = resolvePipelineDag(
      [
        {
          id: "triage",
          entry: true,
          route: [{ to: "page", if: { field: "ok", op: "eq", value: false } }],
        },
        { id: "page" },
      ],
      ctx("if-equiv-diff"),
    );
    expect(areResolvedDagsEquivalent(matchingA, differentIf)).toBe(false);

    const { dag: withoutIf } = resolvePipelineDag(
      [
        { id: "triage", entry: true, route: [{ to: "page" }] },
        { id: "page" },
      ],
      ctx("if-equiv-none"),
    );
    expect(areResolvedDagsEquivalent(matchingA, withoutIf)).toBe(false);
  });

  it("rejects malformed stage entries", () => {
    expect(() => resolvePipelineDag([], ctx("empty"))).toThrow(/non-empty/i);
    expect(() => resolvePipelineDag([""], ctx("blank-id"))).toThrow(/bare string stage refs/i);
    expect(() =>
      resolvePipelineDag([{ route: [{ to: "clarify" }] }], ctx("missing-id")),
    ).toThrow(/no uses: path or inline body/i);
    expect(() =>
      resolvePipelineDag([{ id: "clarify", route: 42 }], ctx("bad-route")),
    ).toThrow(/route must be a non-empty array/i);
    expect(() =>
      resolvePipelineDag([{ id: "clarify", label: "x" }], ctx("unknown-key")),
    ).toThrow(/unknown key "label"/i);
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

  it("toWiringRefs preserves declaration order for object refs", () => {
    const dagCtx = ctx("object-form");
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "clarify",
            entry: true,
            route: [{ to: "design-doc" }],
            uses: "./clarify.yaml",
          },
          declaringPath: dagCtx.path,
        },
        {
          raw: { id: "design-doc", uses: "./design-doc.yaml" },
          declaringPath: dagCtx.path,
        },
      ],
      dagCtx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(toWiringRefs(outcome.value)).toEqual([
      { id: "clarify", entry: true, route: [{ to: "design-doc", on: ["succeeded"] }] },
      { id: "design-doc" },
    ]);
  });

  it("rejects authored needs through the shared normalize wiring seam", () => {
    const stages = [
      { id: "clarify", entry: true, route: [{ to: "design-doc" }], uses: "./clarify.yaml" },
      { id: "design-doc", needs: "clarify", uses: "./design-doc.yaml" },
    ];
    const dagCtx = ctx("legacy-needs");
    const outcome = normalizePipelineStageEntries(
      stages.map((raw) => ({ raw, declaringPath: dagCtx.path })),
      dagCtx,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toMatch(
      /stage "design-doc": "needs" is no longer supported — declare the wiring on the source stage's "route" instead/,
    );
    expect(() => resolvePipelineDag(stages, dagCtx)).toThrow(
      /stage "design-doc": "needs" is no longer supported — declare the wiring on the source stage's "route" instead/,
    );
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

  it("toWiringRefs normalizes route on gates", () => {
    const dagCtx = ctx("parse-mixed-route");
    const outcome = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "research",
            entry: true,
            route: [{ to: "synthesize" }],
            uses: "./research.yaml",
          },
          declaringPath: dagCtx.path,
        },
        {
          raw: {
            id: "validation",
            entry: true,
            route: [{ to: "synthesize", on: ["failed", "skipped"] }],
            uses: "./validation.yaml",
          },
          declaringPath: dagCtx.path,
        },
        {
          raw: { id: "synthesize", uses: "./synthesize.yaml" },
          declaringPath: dagCtx.path,
        },
      ],
      dagCtx,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(toWiringRefs(outcome.value)).toEqual([
      { id: "research", entry: true, route: [{ to: "synthesize", on: ["succeeded"] }] },
      { id: "validation", entry: true, route: [{ to: "synthesize", on: ["failed", "skipped"] }] },
      { id: "synthesize" },
    ]);
  });


});

describe("loadPipeline fork fixtures", () => {
  it("fork-uses pipeline loads as fan-out with no node.fork", async () => {
    const { dag } = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("decide")?.fork).toBeUndefined();
    expect(dag.childrenOf.decide).toEqual(["branch-a", "branch-b"]);
    expect(byId.get("branch-a")?.fork).toBeUndefined();
    expect(byId.get("branch-b")?.fork).toBeUndefined();
  });
});
