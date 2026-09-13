import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipeline } from "../src/config/loadPipeline.js";
import { resolvePipelineDag } from "../src/config/resolvePipelineDag.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const ctx = (pipelineId: string) => ({
  pipelineId,
  path: path.join(fixtures, "pipelines/test.pipeline.yaml"),
});

const loopPolicy = {
  max_replays: 2,
  on_max_replays: "require_continue" as const,
  replay_session: "resume" as const,
};

describe("resolvePipelineDag: route loop entries (ticket 03)", () => {
  it("a basic loop entry synthesizes the same feedback_loop shape as today's feedback_loop field, with no forward edge", () => {
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
        { id: "submit", replay_safe: false },
      ],
      ctx("route-loop-basic-ref"),
    );

    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("review")?.feedback_loop).toEqual({
      target: "implement",
      max_replays: 2,
      on_max_replays: "require_continue",
      replay_session: "resume",
    });
    // Loop entry contributes no forward DAG edge: review's only child is submit.
    expect(dag.childrenOf.review).toEqual(["submit"]);
    expect(dag.childrenOf.implement).toEqual(["review"]);
  });

  it("mixes a forward entry and a loop entry in the same route list", () => {
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
      ctx("route-loop-mixed-ref"),
    );
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("submit")?.needsEdges).toEqual([{ id: "review", on: ["succeeded"] }]);
    expect(byId.get("review")?.feedback_loop?.target).toBe("implement");
  });

  it("loop entries are excluded from forward-cycle detection", () => {
    // implement -> review is a forward edge; review -> implement is a *loop*
    // entry, not a forward edge, so this must not trip cycle detection.
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", route: [{ to: "review" }] },
          {
            id: "review",
            route: [{ type: "loop", to: "implement", ...loopPolicy }],
          },
        ],
        ctx("route-loop-cycle-exclusion"),
      ),
    ).not.toThrow();
  });

  it.each(["require_continue", "wait_for_human"] as const)(
    "supports on_max_replays: %s",
    (on_max_replays) => {
      const { dag } = resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [
              {
                type: "loop",
                to: "plan",
                max_replays: 1,
                on_max_replays,
                replay_session: "resume",
              },
            ],
          },
        ],
        ctx(`route-loop-on-max-replays-${on_max_replays}`),
      );
      const byId = new Map(dag.nodes.map((node) => [node.id, node]));
      expect(byId.get("implement")?.feedback_loop?.on_max_replays).toBe(on_max_replays);
    },
  );

  it.each(["resume", "new_session"] as const)(
    "supports replay_session: %s",
    (replay_session) => {
      const { dag } = resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [
              {
                type: "loop",
                to: "plan",
                max_replays: 1,
                on_max_replays: "require_continue",
                replay_session,
              },
            ],
          },
        ],
        ctx(`route-loop-replay-session-${replay_session}`),
      );
      const byId = new Map(dag.nodes.map((node) => [node.id, node]));
      expect(byId.get("implement")?.feedback_loop?.replay_session).toBe(replay_session);
    },
  );

  it("rejects a loop entry whose to is not a declared ancestor of the source stage", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }, { to: "sibling" }] },
          {
            id: "implement",
            route: [{ type: "loop", to: "sibling", ...loopPolicy }],
          },
          { id: "sibling" },
        ],
        ctx("route-loop-non-ancestor-ref"),
      ),
    ).toThrow(/earlier ancestor/i);
  });

  it("rejects a loop entry whose to is not declared anywhere in the pipeline", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [{ type: "loop", to: "missing-stage", ...loopPolicy }],
          },
        ],
        ctx("route-loop-unknown-target-ref"),
      ),
    ).toThrow(/not declared/i);
  });

  it("rejects a loop entry whose replay route includes a replay_safe: false stage", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "implement", replay_safe: false, route: [{ to: "review" }] },
          {
            id: "review",
            route: [{ type: "loop", to: "plan", ...loopPolicy }],
          },
        ],
        ctx("route-loop-replay-unsafe-ref"),
      ),
    ).toThrow(/replay_safe: false/i);
  });

  it("rejects more than one loop entry on the same stage's route", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          { id: "middle", route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [
              { type: "loop", to: "plan", ...loopPolicy },
              { type: "loop", to: "middle", ...loopPolicy },
            ],
          },
        ],
        ctx("route-loop-multi-loop-ref"),
      ),
    ).toThrow(/at most one loop/i);
  });

  it("rejects malformed loop policy fields", () => {
    const badMaxReplays = [
      { id: "plan", entry: true, route: [{ to: "implement" }] },
      {
        id: "implement",
        route: [{ type: "loop", to: "plan", ...loopPolicy, max_replays: 0 }],
      },
    ];
    expect(() => resolvePipelineDag(badMaxReplays, ctx("route-loop-bad-max-replays"))).toThrow(
      /max_replays must be a positive integer/i,
    );

    const badOnMaxReplays = [
      { id: "plan", entry: true, route: [{ to: "implement" }] },
      {
        id: "implement",
        route: [{ type: "loop", to: "plan", ...loopPolicy, on_max_replays: "continue" }],
      },
    ];
    expect(() =>
      resolvePipelineDag(badOnMaxReplays as never, ctx("route-loop-bad-on-max-replays")),
    ).toThrow(/on_max_replays/i);

    const badReplaySession = [
      { id: "plan", entry: true, route: [{ to: "implement" }] },
      {
        id: "implement",
        route: [{ type: "loop", to: "plan", ...loopPolicy, replay_session: "fresh" }],
      },
    ];
    expect(() =>
      resolvePipelineDag(badReplaySession as never, ctx("route-loop-bad-replay-session")),
    ).toThrow(/replay_session/i);
  });

  it("rejects unknown keys on a loop route item", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [{ type: "loop", to: "plan", ...loopPolicy, label: "x" }],
          },
        ] as never,
        ctx("route-loop-unknown-key"),
      ),
    ).toThrow(/unknown key "label"/i);
  });

  it("rejects duplicate targets across a forward and loop entry in the same route", () => {
    expect(() =>
      resolvePipelineDag(
        [
          { id: "plan", entry: true, route: [{ to: "implement" }] },
          {
            id: "implement",
            route: [{ to: "plan" }, { type: "loop", to: "plan", ...loopPolicy }],
          },
        ],
        ctx("route-loop-dup-target"),
      ),
    ).toThrow(/duplicate target "plan"/i);
  });

  it("pipelines with no loop route entries at all are unaffected (no feedback_loop synthesized)", () => {
    const { dag } = resolvePipelineDag(
      [
        { id: "plan", entry: true, route: [{ to: "implement" }] },
        { id: "implement", route: [{ to: "review" }] },
        { id: "review", route: [{ to: "submit" }] },
        { id: "submit" },
      ],
      ctx("route-loop-unused"),
    );
    for (const node of dag.nodes) {
      expect(node.feedback_loop).toBeUndefined();
    }
  });
});

describe("loadPipeline: route loop YAML fixtures (ticket 03)", () => {
  it("loads a basic loop (mixed forward + loop route) end to end", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-loop-basic"));
    const byId = new Map(dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("review")?.feedback_loop).toEqual({
      target: "implement",
      max_replays: 2,
      on_max_replays: "require_continue",
      replay_session: "resume",
    });
    expect(dag.childrenOf.review).toEqual(["submit"]);
  });

  it("loads on_max_replays: wait_for_human via YAML fixture", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-loop-wait-human"));
    const review = dag.nodes.find((node) => node.id === "review");
    expect(review?.feedback_loop?.on_max_replays).toBe("wait_for_human");
  });

  it("loads replay_session: new_session via YAML fixture", async () => {
    const { dag } = await loadPipeline(pipelinePath("route-loop-new-session"));
    const review = dag.nodes.find((node) => node.id === "review");
    expect(review?.feedback_loop?.replay_session).toBe("new_session");
  });

  it("rejects a non-ancestor loop target via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-loop-non-ancestor"))).rejects.toThrow(
      /earlier ancestor/i,
    );
  });

  it("rejects a replay_safe: false stage on the loop route via YAML fixture", async () => {
    await expect(loadPipeline(pipelinePath("route-loop-replay-unsafe"))).rejects.toThrow(
      /replay_safe: false/i,
    );
  });
});
