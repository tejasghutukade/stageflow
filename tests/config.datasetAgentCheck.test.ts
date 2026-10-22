import { describe, expect, it } from "vitest";
import { checkDatasetAgainstAgent } from "../src/config/datasetAgentCheck.js";

const one = (input: Record<string, unknown>, mode?: "script" | "simulated", expected?: unknown) =>
  checkDatasetAgainstAgent([{ id: "c1", input, ...(expected !== undefined ? { expected } : {}) }], mode ? { mode } : {})[0]!;

const SIM = { opening: "Hi", persona: "Calm", goal: "Get help" };

describe("checkDatasetAgainstAgent", () => {
  it("accepts a script scenario and a simulated scenario", () => {
    expect(one({ script: ["Hello", "Thanks"] }).valid).toBe(true);
    expect(one({ ...SIM }, "simulated").valid).toBe(true);
    expect(one({ mode: "simulated", ...SIM }).valid).toBe(true);
    expect(one({ mode: "script", script: ["x"] }, "simulated").valid).toBe(true);
  });

  it.each([
    ["script mode without a script", {}, undefined],
    ["empty script", { script: [] }, undefined],
    ["41 messages", { script: Array.from({ length: 41 }, () => "x") }, undefined],
    ["empty message", { script: ["ok", ""] }, undefined],
    ["message over 4000 chars", { script: ["x".repeat(4001)] }, undefined],
    ["non-string message", { script: [1] }, undefined],
    ["bad mode", { mode: "chatty", script: ["x"] }, undefined],
    ["simulated without opening", { persona: "p", goal: "g" }, "simulated"],
    ["simulated without persona", { opening: "o", goal: "g" }, "simulated"],
    ["simulated without goal", { opening: "o", persona: "p" }, "simulated"],
    ["opening over 2000", { ...SIM, opening: "x".repeat(2001) }, "simulated"],
    ["persona over 1000", { ...SIM, persona: "x".repeat(1001) }, "simulated"],
    ["goal over 1000", { ...SIM, goal: "x".repeat(1001) }, "simulated"],
    ["31 facts", { ...SIM, facts: Array.from({ length: 31 }, () => "f") }, "simulated"],
    ["fact over 300", { ...SIM, facts: ["x".repeat(301)] }, "simulated"],
    ["case mode simulated overrides script default", { mode: "simulated", script: ["x"] }, undefined],
    ["tool_mocks not an object", { script: ["x"], tool_mocks: [] }, undefined],
    ["tool_mocks with both result and error", { script: ["x"], tool_mocks: { a: { result: 1, error: "e" } } }, undefined],
    ["tool_mocks with neither", { script: ["x"], tool_mocks: { a: {} } }, undefined],
    ["tool_mocks key with whitespace", { script: ["x"], tool_mocks: { "a b": { result: 1 } } }, undefined],
    ["tool_mocks error not text", { script: ["x"], tool_mocks: { a: { error: 3 } } }, undefined],
    ["tool_mocks error over 1000", { script: ["x"], tool_mocks: { a: { error: "x".repeat(1001) } } }, undefined],
    ["tool_mocks over 20 KB", { script: ["x"], tool_mocks: { a: { result: "x".repeat(21 * 1024) } } }, undefined],
    ["51 tool_mocks", { script: ["x"], tool_mocks: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`t${i}`, { result: 1 }])) }, undefined],
  ] as const)("skips: %s", (_name, input, mode) => {
    const result = one(input as Record<string, unknown>, mode);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/^scenario /);
  });

  it("accepts exactly one of result or error per mock", () => {
    expect(one({ script: ["x"], tool_mocks: { "a.b": { result: { ok: true } }, c: { error: "boom" } } }).valid).toBe(true);
  });

  it("script mode ignores opening, persona, goal and facts", () => {
    expect(one({ script: ["x"], opening: 1, persona: 2, goal: 3, facts: "nope" }).valid).toBe(true);
  });

  it("an unknown input field is a note and does not skip the case", () => {
    const result = one({ script: ["x"], persone: "typo" });
    expect(result.valid).toBe(true);
    expect(result.notes.map((n) => n.code)).toEqual(["dataset.scenario_unknown_field"]);
    expect(result.notes[0]?.message).toContain("persone");
  });

  it("expected keys of the wrong type are notes and do not skip the case", () => {
    const result = one({ script: ["x"] }, undefined, { outcome: 1, tools: "a", forbidden_tools: [2] });
    expect(result.valid).toBe(true);
    expect(result.notes.map((n) => n.code)).toEqual([
      "dataset.expected_invalid",
      "dataset.expected_invalid",
      "dataset.expected_invalid",
    ]);
  });

  it("correct expected keys and free-form expected are quiet", () => {
    expect(one({ script: ["x"] }, undefined, { outcome: "ok", tools: ["a"], forbidden_tools: [] }).notes).toEqual([]);
    expect(one({ script: ["x"] }, undefined, { anything: [1] }).notes).toEqual([]);
    expect(one({ script: ["x"] }, undefined, "text").notes).toEqual([]);
  });

  it("checks every case independently", () => {
    const results = checkDatasetAgainstAgent(
      [
        { id: "a", input: { script: ["x"] } },
        { id: "b", input: {} },
      ],
      {},
    );
    expect(results.map((r) => [r.caseId, r.valid])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});
