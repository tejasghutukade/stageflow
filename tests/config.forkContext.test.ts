import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveForkEmitContext } from "../src/config/resolveForkEmitContext.js";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
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
