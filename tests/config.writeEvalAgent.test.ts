import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { previewEvalUpdate, renderEvalCreateYaml, renderEvalYaml } from "../src/config/writeEval.js";
import type { EvalFile } from "../src/evals/types.js";

const base: EvalFile = {
  version: 1,
  id: "support-e",
  target: { kind: "agent", agent: "support" },
  dataset: "../datasets/s.dataset.jsonl",
  defaults: { user_model: "anthropic/claude-haiku-4-5", judge: "anthropic/claude-sonnet-4-5" },
  conversation: { read_only_tools: [], allow_real_tools: false, tools: "mocked", mode: "simulated" },
  graders: [
    { id: "g", type: "goal_reached", guidance: "Be strict." },
    { id: "r", type: "reference", mode: "equals", path: "final_reply", expected: "expected.outcome" },
    { id: "c", type: "conversation_check", final_reply: [{ op: "contains", value: "refund" }], max_turns: 4 },
    {
      id: "t",
      type: "tool_calls",
      must_not_call: ["billing.refund"],
      args: [{ tool: "billing.lookup_invoice", path: "invoice_id", op: "exists" }],
    },
  ],
};

describe("writeEval for agent targets", () => {
  it("writes conversation explicitly with the documented key order and agent defaults", () => {
    const text = renderEvalCreateYaml(base);
    const doc = parse(text) as Record<string, any>;
    expect(Object.keys(doc)).toEqual(["version", "id", "target", "dataset", "defaults", "conversation", "graders"]);
    expect(Object.keys(doc.defaults)).toEqual([
      "repeats",
      "judge",
      "user_model",
      "pass_threshold",
      "max_cost_usd",
      "concurrency",
    ]);
    expect(doc.defaults).toMatchObject({ repeats: 3, pass_threshold: 0.8, max_cost_usd: 1, concurrency: 2 });
    expect(Object.keys(doc.conversation)).toEqual(["mode", "max_turns", "turn_timeout_ms", "tools", "approvals"]);
    expect(doc.conversation).toEqual({
      mode: "simulated",
      max_turns: 8,
      turn_timeout_ms: 120000,
      tools: "mocked",
      approvals: "record_only",
    });
    expect(text).not.toContain("read_only_tools");
    expect(text).not.toContain("allow_real_tools");
  });

  it("keeps non-default read_only_tools and allow_real_tools, in order", () => {
    const text = renderEvalCreateYaml({
      ...base,
      conversation: { allow_real_tools: true, read_only_tools: ["billing.*"], tools: "real" },
    });
    const keys = Object.keys((parse(text) as any).conversation);
    expect(keys).toEqual([
      "mode",
      "max_turns",
      "turn_timeout_ms",
      "tools",
      "approvals",
      "read_only_tools",
      "allow_real_tools",
    ]);
  });

  it("writes grader keys in order with flow style lists", () => {
    const text = renderEvalCreateYaml(base);
    expect(text).toContain("  - id: g\n    type: goal_reached\n    guidance: Be strict.");
    expect(text).toContain("    final_reply:\n      - { op: contains, value: refund }");
    expect(text).toContain("    args:\n      - { tool: billing.lookup_invoice, path: invoice_id, op: exists }");
    expect(text.indexOf("max_turns: 4")).toBeLessThan(text.indexOf("final_reply:"));
  });

  it("elides reference path only when it is the agent default", () => {
    const agent = parse(
      previewEvalUpdate("version: 1\nid: support-e\ntarget:\n  kind: agent\n  agent: support\ndataset: d\ngraders:\n  - id: r\n    type: reference\n    mode: equals\n    expected: expected.outcome\n", {
        ...base,
        graders: [{ id: "r", type: "reference", mode: "equals", path: "final_reply", expected: "expected.outcome" }],
      }),
    ) as any;
    expect(agent.graders[0]).toEqual({ id: "r", type: "reference", mode: "equals", expected: "expected.outcome" });
    const stage = parse(
      previewEvalUpdate("version: 1\nid: s\ntarget:\n  kind: stage\n  file: s.yaml\ndataset: d\ngraders:\n  - id: r\n    type: reference\n    mode: equals\n    expected: e\n", {
        version: 1,
        id: "s",
        target: { kind: "stage", file: "s.yaml" },
        dataset: "d",
        graders: [{ id: "r", type: "reference", mode: "equals", path: "final_reply", expected: "e" }],
      }),
    ) as any;
    expect(stage.graders[0].path).toBe("final_reply");
  });

  it("updates in place, keeping comments, and treats the agent concurrency default as 2", () => {
    const current = [
      "version: 1",
      "id: support-e",
      "target:",
      "  kind: agent",
      "  agent: support  # the agent",
      "dataset: d",
      "defaults:",
      "  repeats: 2",
      "conversation:",
      "  mode: script",
      "graders: []",
      "",
    ].join("\n");
    const next = previewEvalUpdate(current, {
      ...base,
      defaults: { repeats: 2, concurrency: 2, max_cost_usd: 1, pass_threshold: 0.9 },
      conversation: { mode: "script", max_turns: 5 },
      graders: [],
    });
    expect(next).toContain("agent: support # the agent");
    const doc = parse(next) as any;
    expect(doc.defaults).toEqual({ repeats: 2, pass_threshold: 0.9 });
    expect(doc.conversation).toEqual({ mode: "script", max_turns: 5 });
    const kept = parse(previewEvalUpdate(current, { ...base, defaults: { repeats: 2, concurrency: 4 }, graders: [] })) as any;
    expect(kept.defaults.concurrency).toBe(4);
  });

  it("renders stage definitions exactly as before", () => {
    const text = renderEvalYaml({
      version: 1,
      id: "s",
      target: { kind: "stage", file: "s.yaml" },
      dataset: "d",
      defaults: { concurrency: 4 },
      graders: [{ id: "r", type: "reference", mode: "equals", expected: "e" }],
    });
    expect(text).toBe(
      "version: 1\nid: s\ntarget:\n  kind: stage\n  file: s.yaml\ndataset: d\ndefaults:\n  concurrency: 4\ngraders:\n  - id: r\n    type: reference\n    mode: equals\n    expected: e\n",
    );
  });
});
