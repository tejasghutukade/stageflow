import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { normalizePipelineStageEntries } from "../src/config/normalizePipelineStageEntry.js";

const ctx = { pipelineId: "feedback", path: "/tmp/feedback.pipeline.yaml" };
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const policy = {
  target: "implement",
  max_replays: 2,
  on_max_replays: "require_continue" as const,
  replay_session: "resume" as const,
};

describe("feedback_loop pipeline wiring", () => {
  it("loads the canonical pipeline YAML fixture", async () => {
    const loaded = await loadPipeline(
      path.join(fixtures, "pipelines", "feedback-loop.pipeline.yaml"),
    );
    const review = loaded.dag.nodes.find((node) => node.id === "review");
    const submit = loaded.dag.nodes.find((node) => node.id === "submit");
    expect(review?.feedback_loop).toEqual(policy);
    expect(submit?.replay_safe).toBe(false);
  });

  it("preserves a valid source-owned policy without adding a reverse DAG edge", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "plan" },
        { id: "implement", needs: "plan" },
        { id: "review", needs: "implement", feedback_loop: policy },
        { id: "submit", needs: "review" },
      ],
      ctx,
    );

    expect(dag.childrenOf).toEqual({
      plan: ["implement"],
      implement: ["review"],
      review: ["submit"],
      submit: [],
    });
    expect(dag.nodes.find((node) => node.id === "review")?.feedback_loop).toEqual(policy);
  });

  it("permits a persistent fork parent as a target", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          { id: "review-work", needs: "implement", fork: { select: "subset" } },
          { id: "persona-a", needs: "review-work" },
          { id: "persona-b", needs: "review-work" },
          {
            id: "accumulate",
            needs: "persona-a",
            feedback_loop: { ...policy, target: "review-work" },
          },
        ],
        ctx,
      ),
    ).not.toThrow();
  });

  it.each([
    [{ ...policy, target: "" }, /target must be a non-empty/i],
    [{ ...policy, target: ["implement"] }, /must be a single stage id string, not an array/i],
    [{ ...policy, max_replays: 0 }, /max_replays must be a positive integer/i],
    [{ ...policy, on_max_replays: "continue" }, /on_max_replays/i],
    [{ ...policy, replay_session: "fresh" }, /replay_session/i],
  ])("rejects malformed policy %#", (feedback_loop, message) => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          { id: "review", needs: "implement", feedback_loop },
        ],
        ctx,
      ),
    ).toThrow(message);
  });

  it("rejects targets that are undeclared, not ancestors, or clonable", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          { id: "review", needs: "implement", feedback_loop: { ...policy, target: "missing" } },
        ],
        ctx,
      ),
    ).toThrow(/not declared/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          { id: "review", needs: "implement", feedback_loop: { ...policy, target: "review" } },
        ],
        ctx,
      ),
    ).toThrow(/earlier ancestor/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "prepare" },
          { id: "implement", needs: "prepare", clonable: true },
          { id: "review", needs: "implement", feedback_loop: policy },
          { id: "submit", needs: "review" },
        ],
        ctx,
      ),
    ).toThrow(/cannot be clonable/i);
  });

  it("rejects replay paths with replay_safe: false", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan" },
          { id: "implement", needs: "plan", replay_safe: false },
          { id: "review", needs: "implement", feedback_loop: policy },
        ],
        ctx,
      ),
    ).toThrow(/replay_safe: false/i);
  });

  it("treats omitted replay_safe as safe and rejects a non-boolean value", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan" },
          { id: "implement", needs: "plan" },
          { id: "review", needs: "implement", feedback_loop: policy },
        ],
        ctx,
      ),
    ).not.toThrow();
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement", replay_safe: "false" },
          { id: "review", needs: "implement", feedback_loop: policy },
        ],
        ctx,
      ),
    ).toThrow(/replay_safe must be a boolean/i);
  });

  it("rejects unknown policy keys and clonable feedback sources", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          {
            id: "review",
            needs: "implement",
            feedback_loop: { ...policy, unknown: true },
          },
        ],
        ctx,
      ),
    ).toThrow(/unknown key "unknown"/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement" },
          {
            id: "review",
            needs: "implement",
            clonable: true,
            feedback_loop: policy,
          },
          { id: "submit", needs: "review" },
        ],
        ctx,
      ),
    ).toThrow(/source cannot be clonable/i);
  });

  it("uses the same feedback_loop and replay_safe validation while normalizing YAML entries", () => {
    const unknownPolicy = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "review",
            system_prompt: "review",
            model: "x",
            feedback_loop: { ...policy, unknown: true },
          },
          declaringPath: ctx.path,
        },
      ],
      ctx,
    );
    expect(unknownPolicy.ok).toBe(false);
    if (!unknownPolicy.ok) {
      expect(unknownPolicy.issues[0]?.message).toMatch(/unknown key "unknown"/i);
    }

    const invalidSafety = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "review",
            system_prompt: "review",
            model: "x",
            replay_safe: "false",
          },
          declaringPath: ctx.path,
        },
      ],
      ctx,
    );
    expect(invalidSafety.ok).toBe(false);
    if (!invalidSafety.ok) {
      expect(invalidSafety.issues[0]?.message).toMatch(/replay_safe must be a boolean/i);
    }
  });
});
