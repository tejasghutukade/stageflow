import { describe, expect, it } from "vitest";
import {
  buildEditorLiveGraph,
  editorGateChips,
  editorGraphSummary,
} from "./editorLiveGraph";

describe("editorGraphSummary", () => {
  it("counts stages and the widest parallel lane", () => {
    expect(editorGraphSummary(1, 1)).toBe("1 stage · 1 parallel");
    expect(editorGraphSummary(8, 2)).toBe("8 stages · 2 parallel");
  });
});

describe("editorGateChips", () => {
  it("uses verify, on_fail, and ask labels", () => {
    expect(
      editorGateChips(
        { on_verify_fail: { mode: "repair", max_attempts: 3, retry_safety: "idempotent" } },
        {
          verify: [{ id: "tests", type: "command", command: "npm test" }],
          gate_kinds: ["confirm", "free_text"],
        },
      ),
    ).toEqual([
      { kind: "verify", label: "verify" },
      { kind: "on_fail", label: "on_fail: retry" },
      { kind: "ask", label: "ask: confirm +1" },
    ]);
  });

  it("marks verify without a failure policy or ask as no gate", () => {
    expect(editorGateChips(undefined, { verify: [{ id: "tests", type: "command", command: "npm test" }] })).toEqual([
      { kind: "verify", label: "verify" },
      { kind: "no_gate", label: "no gate" },
    ]);
  });

  it("reads on_verify_fail from the pipeline ref and ask kinds from the stage body", () => {
    expect(
      editorGateChips(
        { on_verify_fail: { mode: "manual", retry_safety: "side_effecting" } },
        { gate_kinds: ["artifact_backed"] },
      ),
    ).toEqual([
      { kind: "on_fail", label: "on_fail: ask" },
      { kind: "ask", label: "ask: artifact_backed" },
    ]);
  });
});

describe("buildEditorLiveGraph", () => {
  it("keeps an implicit chain in one lane", () => {
    const graph = buildEditorLiveGraph({
      pipeline: { id: "p", stages: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    });
    expect(graph.useDag).toBe(false);
    expect(graph.lanes).toBe(1);
    expect(graph.summary).toBe("3 stages · 1 parallel");
    expect(graph.layers.map((layer) => layer.map((node) => node.stageId))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("places route fan-out side by side", () => {
    const graph = buildEditorLiveGraph({
      pipeline: {
        id: "fan",
        stages: [
          { id: "clarify", entry: true, route: [{ to: "research" }, { to: "validation" }] },
          { id: "research", route: [{ to: "synthesize" }] },
          { id: "validation", route: [{ to: "synthesize" }] },
          { id: "synthesize" },
        ],
      },
    });
    expect(graph.useDag).toBe(true);
    expect(graph.lanes).toBe(2);
    expect(graph.summary).toBe("4 stages · 2 parallel");
    expect(graph.layers.map((layer) => layer.map((node) => node.stageId))).toEqual([
      ["clarify"],
      ["research", "validation"],
      ["synthesize"],
    ]);
  });

  it("places a feature-loop send-back beside the forward target", () => {
    const graph = buildEditorLiveGraph({
      pipeline: {
        id: "feature-loop",
        stages: [
          { id: "decompose", entry: true, route: [{ to: "feature-plan" }] },
          { id: "feature-plan", route: [{ to: "align" }] },
          { id: "align", route: [{ to: "feature-implement" }] },
          { id: "feature-implement", route: [{ to: "verify" }] },
          { id: "verify", route: [{ to: "feature-review" }] },
          { id: "feature-review", route: [{ to: "address-feedback" }] },
          {
            id: "address-feedback",
            route: [
              { to: "publish" },
              { type: "loop", to: "feature-review", max_replays: 2 },
            ],
          },
          {
            id: "publish",
            on_verify_fail: { mode: "manual", retry_safety: "side_effecting" },
          },
        ],
      },
      stages: [
        {
          path: "./publish.yaml",
          body: { id: "publish", verify: [{ id: "ship", type: "command", command: "true" }], gate_kinds: ["artifact_backed"] },
        },
      ],
    });
    expect(graph.useDag).toBe(true);
    expect(graph.stageCount).toBe(8);
    expect(graph.lanes).toBe(2);
    expect(graph.summary).toBe("8 stages · 2 parallel");
    expect(graph.layers.map((layer) => layer.map((node) => (node.loop ? `${node.stageId}*` : node.stageId)))).toEqual([
      ["decompose"],
      ["feature-plan"],
      ["align"],
      ["feature-implement"],
      ["verify"],
      ["feature-review"],
      ["address-feedback"],
      ["publish", "feature-review*"],
    ]);
    expect(graph.layers[7]!.map((node) => node.key)).toEqual([
      "publish",
      "loop:address-feedback>feature-review",
    ]);
    const publish = graph.layers[7]![0]!;
    expect(publish.chips).toEqual([
      { kind: "verify", label: "verify" },
      { kind: "on_fail", label: "on_fail: ask" },
      { kind: "ask", label: "ask: artifact_backed" },
    ]);
    expect(graph.layers[7]![1]!.chips).toEqual([]);
  });

  it("survives a needs cycle", () => {
    const graph = buildEditorLiveGraph({
      pipeline: { id: "p", stages: [{ id: "a", needs: "b" }, { id: "b", needs: "a" }] },
    });
    expect(graph.stageCount).toBe(2);
    expect(graph.layers.flat().map((node) => node.stageId).sort()).toEqual(["a", "b"]);
  });
});
