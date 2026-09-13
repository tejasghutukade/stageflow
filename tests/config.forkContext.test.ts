import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  resolveCloneEmitContext,
  resolveForkEmitContext,
} from "../src/config/resolveForkEmitContext.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import type { ResolvedPipelineDag } from "../src/types/pipeline.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const ctx = (pipelineId: string) => ({
  pipelineId,
  path: path.join(FIXTURES_ROOT, "pipelines/test.pipeline.yaml"),
});

describe("resolveForkEmitContext", () => {
  it("C1: stage without fork field returns undefined", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "clarify", entry: true, route: [{ to: "design-doc" }] },
        { id: "design-doc" },
      ],
      ctx("linear"),
    );
    expect(resolveForkEmitContext(dag, "clarify")).toBeUndefined();
    expect(resolveForkEmitContext(dag, "design-doc")).toBeUndefined();
  });

  it("C2: YAML fan-out stage returns undefined fork context", async () => {
    const { dag } = await loadPipeline(
      path.join(FIXTURES_ROOT, "pipelines/fork-one-of-two.pipeline.yaml"),
      { cwd: FIXTURES_ROOT },
    );
    expect(resolveForkEmitContext(dag, "clarify")).toBeUndefined();
  });

  it("C3: programmatic fork stage with allow_none true sets allowNone on shape", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "clarify",
          needs: null,
          needsEdges: [],
          ancestors: [],
          stageIndex: 0,
          fork: { select: "subset", allow_none: true },
        },
        {
          id: "design-doc",
          needs: "clarify",
          needsEdges: [{ id: "clarify", on: ["succeeded"] }],
          ancestors: ["clarify"],
          stageIndex: 1,
        },
        {
          id: "implementation-plan",
          needs: "clarify",
          needsEdges: [{ id: "clarify", on: ["succeeded"] }],
          ancestors: ["clarify"],
          stageIndex: 2,
        },
      ],
      roots: ["clarify"],
      childrenOf: {
        clarify: ["design-doc", "implementation-plan"],
        "design-doc": [],
        "implementation-plan": [],
      },
    };
    expect(resolveForkEmitContext(dag, "clarify")).toEqual({
      immediateSuccessorIds: ["design-doc", "implementation-plan"],
      forkShape: { cardinality: "subset", allowNone: true },
    });
  });

  it("C4: single-child fork stage returns one successor ID", () => {
    // Catalog YAML cannot produce node.fork. This exercises
    // resolveForkEmitContext's own handling of that resolved-DAG shape
    // directly, the same way the hand-built-DAG tests below this describe
    // block do.
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "decide",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          fork: { select: "one", allow_none: false },
        },
        { id: "only-branch", needs: "decide", ancestors: ["decide"], stageIndex: 1 },
      ],
      roots: ["decide"],
      childrenOf: { decide: ["only-branch"], "only-branch": [] },
    };
    expect(resolveForkEmitContext(dag, "decide")).toEqual({
      immediateSuccessorIds: ["only-branch"],
      forkShape: { cardinality: "one", allowNone: false },
    });
  });
});

describe("resolveCloneEmitContext", () => {
  it("returns undefined when no child is a clone emitter", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        { id: "detect-changes", needs: null, ancestors: [], stageIndex: 0 },
        { id: "collect", needs: "detect-changes", ancestors: ["detect-changes"], stageIndex: 1 },
      ],
      roots: ["detect-changes"],
      childrenOf: { "detect-changes": ["collect"], collect: [] },
    };
    expect(resolveCloneEmitContext(dag, "detect-changes")).toBeUndefined();
    expect(resolveForkEmitContext(dag, "detect-changes")).toBeUndefined();
  });
});
