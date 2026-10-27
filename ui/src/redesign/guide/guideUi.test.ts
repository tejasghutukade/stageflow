import { describe, expect, it } from "vitest";
import type { GuidePipelineStage } from "./api";
import { orderStages, readGuideUi, resourceSignal, toolActivityLabel } from "./guideUi";

function stage(id: string, needs: string[] = []): GuidePipelineStage {
  return { id, needs, gates: [], channels: [], hasVerify: false };
}

describe("orderStages", () => {
  it("puts every stage after the stages it needs, keeping authored order for ties", () => {
    const ordered = orderStages([stage("c", ["a", "b"]), stage("a"), stage("b", ["a"]), stage("d")]);
    expect(ordered.map((s) => s.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("ignores needs on unknown stages and survives cycles", () => {
    expect(orderStages([stage("a", ["missing"]), stage("b")]).map((s) => s.id)).toEqual(["a", "b"]);
    expect(orderStages([stage("a", ["b"]), stage("b", ["a"])]).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("readGuideUi", () => {
  it("accepts known components", () => {
    const ui = { component: "plan", title: "P", steps: [] };
    expect(readGuideUi({ ui })).toBe(ui);
  });

  it("rejects anything it cannot draw", () => {
    expect(readGuideUi(null)).toBeNull();
    expect(readGuideUi({ ui: { component: "chart" } })).toBeNull();
    expect(readGuideUi({ ui: { component: "plan" } })).toBeNull();
    expect(readGuideUi({ ui: { component: "pipeline", pipeline: { stages: [{}] }, validation: {}, link: {} } })).toBeNull();
  });
});

describe("toolActivityLabel", () => {
  it("maps tool names to plain verbs", () => {
    expect(toolActivityLabel("create_pipeline", false)).toBe("Created pipeline");
    expect(toolActivityLabel("create_pipeline", true)).toBe("Creating pipeline");
    expect(toolActivityLabel("list_runs", false)).toBe("Listed runs");
    expect(toolActivityLabel("get_eval_run", false)).toBe("Read eval run");
    expect(toolActivityLabel("start_run", false)).toBe("Started a run");
    expect(toolActivityLabel("validate", false)).toBe("validate");
  });
});

describe("resourceSignal", () => {
  it("maps free-form statuses to a status signal", () => {
    expect(resourceSignal("enabled")).toBe("ok");
    expect(resourceSignal("disabled")).toBe("skipped");
    expect(resourceSignal("invalid")).toBe("fail");
    expect(resourceSignal("running")).toBe("running");
    expect(resourceSignal("waiting_for_input")).toBe("needs");
    expect(resourceSignal("draft")).toBe("queued");
  });
});
