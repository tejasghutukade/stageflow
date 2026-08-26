import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPipeline,
  loadPipelineOutcome,
  loadPipelineValidated,
} from "../src/config/loadPipeline.js";

const owned = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/pipeline-owned",
);

describe("pipeline-owned loader", () => {
  it("AE1: fork-uses loads 3 stages with fork dag", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(loaded.pipeline.stages).toEqual(["decide", "branch-a", "branch-b"]);
    expect(loaded.stages.map((s) => s.id)).toEqual(["decide", "branch-a", "branch-b"]);
    const decide = loaded.dag.nodes.find((n) => n.id === "decide");
    expect(decide?.fork).toEqual({ select: "one", allow_none: false });
  });

  it("AE2: inline-leaf materializes inline branch-b", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "inline-leaf/inline.pipeline.yaml"),
    );
    const branchB = loaded.stages.find((s) => s.id === "branch-b");
    expect(branchB?.system_prompt).toMatch(/Inline branch-b/);
    expect(loaded.stageSources?.["branch-b"]).toEqual({ kind: "inline" });
    expect(loaded.stageSources?.["branch-a"]).toEqual({
      kind: "file",
      path: path.join(owned, "inline-leaf/branch-a.yaml"),
    });
  });

  it("AE3: id-mismatch returns stage_id_mismatch finding", async () => {
    const result = await loadPipelineValidated(
      path.join(owned, "negative/id-mismatch.pipeline.yaml"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.findings.some((f) => f.code === "pipeline.stage_id_mismatch"),
    ).toBe(true);
  });

  it("AE4: include-merge builds gate → finish DAG", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "include-merge/main.pipeline.yaml"),
    );
    expect(loaded.pipeline.stages).toEqual(["gate", "finish"]);
    const finish = loaded.dag.nodes.find((n) => n.id === "finish");
    expect(finish?.needs).toBe("gate");
  });

  it("AE5: duplicate-include fails", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(owned, "negative/duplicate-include/main.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((i) => i.code === "pipeline.include_duplicate_stage")).toBe(
      true,
    );
  });

  it("AE6: include-cycle fails with stack", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(owned, "negative/include-cycle/a.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.include_cycle");
    expect(outcome.issues[0]?.message).toMatch(/→/);
  });

  it("AE7: string-refs fails with string_stage_ref", async () => {
    const outcome = await loadPipelineOutcome(
      path.join(owned, "negative/string-refs.pipeline.yaml"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe("pipeline.string_stage_ref");
    expect(outcome.issues[0]?.message).toMatch(/bare string stage refs/i);
  });

  it("AE8: infer-id loads with inferred decide id", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "infer-id/infer.pipeline.yaml"),
    );
    expect(loaded.pipeline.stages).toEqual(["decide"]);
    expect(loaded.stages[0]?.id).toBe("decide");
  });

  it("AE11: loads without global stagesDir", async () => {
    const loaded = await loadPipeline(
      path.join(owned, "fork-uses/fork-demo.pipeline.yaml"),
    );
    expect(loaded.stages.length).toBe(3);
  });

  it("sets pipelinePath on LoadedPipeline", async () => {
    const pipelinePath = path.join(owned, "fork-uses/fork-demo.pipeline.yaml");
    const loaded = await loadPipeline(pipelinePath);
    expect(loaded.pipelinePath).toBe(path.normalize(path.resolve(pipelinePath)));
    expect(loaded.pipelinePath.endsWith("fork-demo.pipeline.yaml")).toBe(true);
  });
});
