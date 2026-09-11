import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { normalizePipelineStageEntries } from "../src/config/normalizePipelineStageEntry.js";

const ctx = { pipelineId: "feedback", path: "/tmp/feedback.pipeline.yaml" };
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Expected shape of the resolved node's synthesized `feedback_loop` field
// (ResolvedPipelineStageNode.feedback_loop is unchanged by the route-based
// rewrite: a `type: "loop"` route entry synthesizes this exact shape).
const policy = {
  target: "implement",
  max_replays: 2,
  on_max_replays: "require_continue" as const,
  replay_session: "resume" as const,
};

// Loop route-entry input shape (docs/tickets/route-based-pipeline-wiring/03):
// same replay-policy fields as `policy` above, minus `target` (supplied via
// `to` inline at each use site).
const loopPolicy = {
  max_replays: 2,
  on_max_replays: "require_continue" as const,
  replay_session: "resume" as const,
};

describe("feedback_loop pipeline wiring (route type: loop entries)", () => {
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
        { id: "plan", entry: true, route: [{ to: "implement" }] },
        { id: "implement", route: [{ to: "review" }] },
        {
          id: "review",
          route: [
            { to: "submit" },
            { type: "loop", to: "implement", ...loopPolicy },
          ],
        },
        { id: "submit" },
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
          { id: "implement", entry: true, route: [{ to: "review-work" }] },
          {
            id: "review-work",
            route_select: "subset",
            route: [{ to: "persona-a" }, { to: "persona-b" }],
          },
          { id: "persona-a", route: [{ to: "accumulate" }] },
          { id: "persona-b" },
          {
            id: "accumulate",
            route: [{ type: "loop", to: "review-work", ...loopPolicy }],
          },
        ],
        ctx,
      ),
    ).not.toThrow();
  });

  it.each([
    [{ to: "", ...loopPolicy }, /non-empty "to" stage id/i],
    [{ to: ["implement"], ...loopPolicy }, /non-empty "to" stage id/i],
    [{ to: "implement", ...loopPolicy, max_replays: 0 }, /max_replays must be a positive integer/i],
    [{ to: "implement", ...loopPolicy, on_max_replays: "continue" }, /on_max_replays/i],
    [{ to: "implement", ...loopPolicy, replay_session: "fresh" }, /replay_session/i],
  ])("rejects malformed policy %#", (loopEntry, message) => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", ...loopEntry }] },
        ],
        ctx,
      ),
    ).toThrow(message);
  });

  it("rejects targets that are undeclared, not ancestors, or clonable", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", to: "missing", ...loopPolicy }] },
        ],
        ctx,
      ),
    ).toThrow(/not declared/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", to: "review", ...loopPolicy }] },
        ],
        ctx,
      ),
    ).toThrow(/earlier ancestor/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "prepare", entry: true, route: [{ to: "implement" }] },
          { id: "implement", clonable: true, route: [{ to: "review" }] },
          {
            id: "review",
            route: [{ to: "submit" }, { type: "loop", to: "implement", ...loopPolicy }],
          },
          { id: "submit" },
        ],
        ctx,
      ),
    ).toThrow(/cannot be clonable/i);
  });

  it("rejects replay paths with replay_safe: false", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", replay_safe: false, route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", to: "implement", ...loopPolicy }] },
        ],
        ctx,
      ),
    ).toThrow(/replay_safe: false/i);
  });

  it("treats omitted replay_safe as safe and rejects a non-boolean value", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", to: "implement", ...loopPolicy }] },
        ],
        ctx,
      ),
    ).not.toThrow();
    expect(() =>
      resolvePipelineDag(
        [
          { id: "implement", replay_safe: "false", entry: true, route: [{ to: "review" }] },
          { id: "review", route: [{ type: "loop", to: "implement", ...loopPolicy }] },
        ],
        ctx,
      ),
    ).toThrow(/replay_safe must be a boolean/i);
  });

  it("rejects unknown policy keys and clonable feedback sources", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          {
            id: "review",
            route: [{ type: "loop", to: "implement", ...loopPolicy, unknown: true }],
          },
        ],
        ctx,
      ),
    ).toThrow(/unknown key "unknown"/i);
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          {
            id: "review",
            clonable: true,
            route: [{ to: "submit" }, { type: "loop", to: "implement", ...loopPolicy }],
          },
          { id: "submit" },
        ],
        ctx,
      ),
    ).toThrow(/source cannot be clonable/i);
  });

  it("uses the same route-loop and replay_safe validation while normalizing YAML entries", () => {
    const unknownPolicy = normalizePipelineStageEntries(
      [
        {
          raw: {
            id: "review",
            system_prompt: "review",
            model: "x",
            route: [{ type: "loop", to: "implement", ...loopPolicy, unknown: true }],
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
