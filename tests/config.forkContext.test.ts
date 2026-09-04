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
      [{ id: "clarify" }, { id: "design-doc", needs: "clarify" }],
      ctx("linear"),
    );
    expect(resolveForkEmitContext(dag, "clarify")).toBeUndefined();
    expect(resolveForkEmitContext(dag, "design-doc")).toBeUndefined();
  });

  it("C2: fork stage with select one and two children returns full context", async () => {
    const { dag } = await loadPipeline(
      path.join(FIXTURES_ROOT, "pipelines/fork-one-of-two.pipeline.yaml"),
      { cwd: FIXTURES_ROOT },
    );
    expect(resolveForkEmitContext(dag, "clarify")).toEqual({
      immediateSuccessorIds: ["design-doc", "implementation-plan"],
      forkShape: { cardinality: "one", allowNone: false },
    });
  });

  it("C3: fork stage with allow_none true sets allowNone on shape", async () => {
    const { dag } = await loadPipeline(
      path.join(FIXTURES_ROOT, "pipelines/fork-route-allow-none.pipeline.yaml"),
      { cwd: FIXTURES_ROOT },
    );
    expect(resolveForkEmitContext(dag, "clarify")).toEqual({
      immediateSuccessorIds: ["design-doc", "implementation-plan"],
      forkShape: { cardinality: "subset", allowNone: true },
    });
  });

  it("C4: single-child fork stage returns one successor ID", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "decide", fork: { select: "one" } },
        { id: "only-branch", needs: "decide" },
      ],
      ctx("single-child-fork"),
    );
    expect(resolveForkEmitContext(dag, "decide")).toEqual({
      immediateSuccessorIds: ["only-branch"],
      forkShape: { cardinality: "one", allowNone: false },
    });
  });
});

describe("resolveCloneEmitContext", () => {
  it("AE7: no clonable children returns undefined", () => {
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

  it("linear parent with one clonable child returns clone context and no fork context", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        { id: "detect-changes", needs: null, ancestors: [], stageIndex: 0 },
        {
          id: "author-diagrams",
          needs: "detect-changes",
          ancestors: ["detect-changes"],
          stageIndex: 1,
          clonable: true,
          clone_cap: 5,
        },
      ],
      roots: ["detect-changes"],
      childrenOf: { "detect-changes": ["author-diagrams"], "author-diagrams": [] },
    };
    expect(resolveCloneEmitContext(dag, "detect-changes")).toEqual({
      clonableSuccessors: [{ successorId: "author-diagrams", cloneCap: 5 }],
    });
    expect(resolveForkEmitContext(dag, "detect-changes")).toBeUndefined();
  });

  it("AE-mix: fork parent drops clonable ids from fork context", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "detect-changes",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          fork: { select: "one", allow_none: false },
        },
        {
          id: "author-diagrams",
          needs: "detect-changes",
          ancestors: ["detect-changes"],
          stageIndex: 1,
          clonable: true,
          clone_cap: 5,
        },
        {
          id: "notify-slack",
          needs: "detect-changes",
          ancestors: ["detect-changes"],
          stageIndex: 2,
        },
      ],
      roots: ["detect-changes"],
      childrenOf: {
        "detect-changes": ["author-diagrams", "notify-slack"],
        "author-diagrams": [],
        "notify-slack": [],
      },
    };
    expect(resolveForkEmitContext(dag, "detect-changes")).toEqual({
      immediateSuccessorIds: ["notify-slack"],
      forkShape: { cardinality: "one", allowNone: false },
    });
    expect(resolveCloneEmitContext(dag, "detect-changes")).toEqual({
      clonableSuccessors: [{ successorId: "author-diagrams", cloneCap: 5 }],
    });
  });

  it("fork parent whose every child is clonable returns undefined fork context", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        {
          id: "detect-changes",
          needs: null,
          ancestors: [],
          stageIndex: 0,
          fork: { select: "one", allow_none: false },
        },
        {
          id: "author-diagrams",
          needs: "detect-changes",
          ancestors: ["detect-changes"],
          stageIndex: 1,
          clonable: true,
          clone_cap: 5,
        },
      ],
      roots: ["detect-changes"],
      childrenOf: { "detect-changes": ["author-diagrams"], "author-diagrams": [] },
    };
    expect(resolveForkEmitContext(dag, "detect-changes")).toBeUndefined();
    expect(resolveCloneEmitContext(dag, "detect-changes")).toEqual({
      clonableSuccessors: [{ successorId: "author-diagrams", cloneCap: 5 }],
    });
  });

  it("attaches successor assignment schema and parent allowed actions", () => {
    const dag: ResolvedPipelineDag = {
      nodes: [
        { id: "plan", needs: null, ancestors: [], stageIndex: 0 },
        {
          id: "oss-investigate-area",
          needs: "plan",
          ancestors: ["plan"],
          stageIndex: 1,
          clonable: true,
          clone_cap: 4,
        },
      ],
      roots: ["plan"],
      childrenOf: { plan: ["oss-investigate-area"], "oss-investigate-area": [] },
    };
    const schema = {
      type: "object",
      properties: { area_id: { type: "string" } },
      required: ["area_id"],
    };
    expect(
      resolveCloneEmitContext(dag, "plan", {
        allowedActions: ["once", "fanout"],
        successorCloneInputSchemas: { "oss-investigate-area": schema },
      }),
    ).toEqual({
      clonableSuccessors: [
        {
          successorId: "oss-investigate-area",
          cloneCap: 4,
          cloneInputSchema: schema,
        },
      ],
      allowedActions: ["once", "fanout"],
    });
  });
});
