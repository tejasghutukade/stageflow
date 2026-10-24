import { describe, expect, it } from "vitest";
import {
  countValidScenarios,
  emptyScenario,
  ignoredFields,
  invalidScenarioBanner,
  isMixedUse,
  modeOfCase,
  moveItem,
  scenarioFromCase,
  scenarioProblem,
  scenarioRow,
  scenarioSummary,
  scenarioToCase,
  type ScenarioDraft,
} from "./scenarioModel";

function draft(overrides: Partial<ScenarioDraft> = {}): ScenarioDraft {
  return { ...emptyScenario("simulated", []), ...overrides };
}

const opts = { defaultMode: "simulated" as const, existingIds: [] as string[] };

describe("scenario drafts", () => {
  it("starts with the next free id and the eval's mode", () => {
    expect(emptyScenario("script", ["c001", "c002"])).toMatchObject({ id: "c003", mode: "script", script: [""] });
  });

  it("reads a simulated case with mocks and expected data", () => {
    const d = scenarioFromCase(
      {
        id: "s001",
        title: "Refund",
        tags: ["billing", "pro"],
        input: { mode: "simulated", opening: "Hi", persona: "Annoyed", goal: "Refund", facts: ["INV-1"], tool_mocks: { "billing.lookup": { result: { status: "duplicate" } }, bash: { error: "denied" } } },
        expected: { outcome: "escalated", tools: ["billing.lookup"], forbidden_tools: ["billing.refund"] },
      },
      "script",
    );
    expect(d).toMatchObject({ id: "s001", title: "Refund", tags: "billing pro", mode: "simulated", opening: "Hi", facts: ["INV-1"], outcome: "escalated", tools: ["billing.lookup"], forbiddenTools: ["billing.refund"] });
    expect(d.mocks).toEqual([
      { tool: "billing.lookup", kind: "result", text: '{"status":"duplicate"}' },
      { tool: "bash", kind: "error", text: "denied" },
    ]);
  });

  it("inherits the mode unless the case sets one", () => {
    expect(modeOfCase({ input: { script: ["a"] } }, "script")).toBe("script");
    expect(modeOfCase({ input: {} }, "simulated")).toBe("simulated");
    expect(modeOfCase({ input: { mode: "script" } }, "simulated")).toBe("script");
    expect(modeOfCase({ input: { mode: "bogus" } }, "simulated")).toBe("simulated");
  });

  it("collapses the fields the mode ignores", () => {
    expect(ignoredFields("script")).toEqual(["opening", "persona", "goal", "facts"]);
    expect(ignoredFields("simulated")).toEqual(["script"]);
  });
});

describe("draft to case", () => {
  it("builds a simulated scenario in the A01 shape and omits the inherited mode", () => {
    const out = scenarioToCase(
      draft({
        id: "s001",
        title: " Refund ",
        tags: "billing",
        opening: "I was charged twice",
        persona: "Annoyed",
        goal: "Get a refund",
        facts: ["INV-2093", ""],
        outcome: "escalated_to_human",
        tools: ["billing.lookup_invoice"],
        forbiddenTools: ["billing.refund"],
        mocks: [{ tool: "billing.lookup_invoice", kind: "result", text: '{"status":"duplicate"}' }],
      }),
      opts,
    );
    expect(out).toEqual({
      ok: true,
      case: {
        id: "s001",
        input: {
          opening: "I was charged twice",
          persona: "Annoyed",
          goal: "Get a refund",
          facts: ["INV-2093"],
          tool_mocks: { "billing.lookup_invoice": { result: { status: "duplicate" } } },
        },
        title: "Refund",
        expected: { outcome: "escalated_to_human", tools: ["billing.lookup_invoice"], forbidden_tools: ["billing.refund"] },
        tags: ["billing"],
      },
    });
  });

  it("writes input.mode only when the scenario differs from the eval", () => {
    const out = scenarioToCase(draft({ id: "s2", mode: "script", script: ["Where is my order?", "", "Thanks"] }), opts);
    expect(out).toEqual({ ok: true, case: { id: "s2", input: { mode: "script", script: ["Where is my order?", "Thanks"] } } });
    const same = scenarioToCase(draft({ id: "s3", mode: "script", script: ["Hi"] }), { ...opts, defaultMode: "script" });
    expect(same).toEqual({ ok: true, case: { id: "s3", input: { script: ["Hi"] } } });
  });

  it("requires the mode's fields", () => {
    const sim = scenarioToCase(draft({ id: "s1" }), opts);
    expect(sim.ok).toBe(false);
    if (!sim.ok) expect(Object.keys(sim.errors).sort()).toEqual(["goal", "opening", "persona"]);
    const script = scenarioToCase(draft({ id: "s1", mode: "script", script: [""] }), opts);
    expect(script.ok).toBe(false);
    if (!script.ok) expect(script.errors.script).toMatch(/at least one/);
  });

  it("checks lengths and counts", () => {
    const long = scenarioToCase(draft({ id: "s1", opening: "x".repeat(2001), persona: "p", goal: "g" }), opts);
    expect(!long.ok && long.errors.opening).toMatch(/2,000/);
    const manyMessages = scenarioToCase(draft({ id: "s1", mode: "script", script: Array.from({ length: 41 }, () => "a") }), opts);
    expect(!manyMessages.ok && manyMessages.errors.script).toMatch(/40/);
    const manyFacts = scenarioToCase(draft({ id: "s1", opening: "o", persona: "p", goal: "g", facts: Array.from({ length: 31 }, () => "f") }), opts);
    expect(!manyFacts.ok && manyFacts.errors.facts).toMatch(/30/);
  });

  it("validates id, title and tags", () => {
    const bad = scenarioToCase(draft({ id: "bad id", title: "t".repeat(121), tags: "Bad_Tag", opening: "o", persona: "p", goal: "g" }), opts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["id", "tags", "title"]);
    const taken = scenarioToCase(draft({ id: "s1", opening: "o", persona: "p", goal: "g" }), { ...opts, existingIds: ["s1"] });
    expect(!taken.ok && taken.errors.id).toMatch(/already used/);
    const editing = scenarioToCase(draft({ id: "s1", opening: "o", persona: "p", goal: "g" }), { ...opts, existingIds: ["s1"], editing: true });
    expect(editing.ok).toBe(true);
  });

  it("validates tool mocks", () => {
    const base = { id: "s1", opening: "o", persona: "p", goal: "g" };
    const badJson = scenarioToCase(draft({ ...base, mocks: [{ tool: "a.b", kind: "result", text: "{nope" }] }), opts);
    expect(!badJson.ok && badJson.errors["mock.0.value"]).toBe("Not valid JSON");
    const noTool = scenarioToCase(draft({ ...base, mocks: [{ tool: "has space", kind: "error", text: "x" }] }), opts);
    expect(!noTool.ok && noTool.errors["mock.0.tool"]).toMatch(/Tool id/);
    const dup = scenarioToCase(draft({ ...base, mocks: [{ tool: "a.b", kind: "error", text: "x" }, { tool: "a.b", kind: "error", text: "y" }] }), opts);
    expect(!dup.ok && dup.errors["mock.1.tool"]).toMatch(/Another mock/);
    const emptyError = scenarioToCase(draft({ ...base, mocks: [{ tool: "a.b", kind: "error", text: " " }] }), opts);
    expect(!emptyError.ok && emptyError.errors["mock.0.value"]).toMatch(/required/);
    const longError = scenarioToCase(draft({ ...base, mocks: [{ tool: "a.b", kind: "error", text: "e".repeat(1001) }] }), opts);
    expect(!longError.ok && longError.errors["mock.0.value"]).toMatch(/1000/);
    const big = scenarioToCase(draft({ ...base, mocks: [{ tool: "a.b", kind: "result", text: JSON.stringify("x".repeat(21 * 1024)) }] }), opts);
    expect(!big.ok && big.errors["mock.0.value"]).toMatch(/20 KB/);
    const blank = scenarioToCase(draft({ ...base, mocks: [{ tool: "", kind: "result", text: "" }] }), opts);
    expect(blank.ok).toBe(true);
  });

  it("keeps what the mode ignores so switching does not lose it", () => {
    const d = scenarioFromCase({ id: "s1", input: { mode: "script", script: ["Hi"], opening: "kept", goal: "kept goal", facts: ["f"] } }, "simulated");
    const out = scenarioToCase(d, opts);
    expect(out.ok && out.case.input).toEqual({ mode: "script", script: ["Hi"], opening: "kept", goal: "kept goal", facts: ["f"] });
    const sim = scenarioToCase({ ...d, mode: "simulated", persona: "p" }, opts);
    expect(sim.ok && sim.case.input).toMatchObject({ opening: "kept", persona: "p", goal: "kept goal", script: ["Hi"] });
  });

  it("rejects over-long expected data", () => {
    const out = scenarioToCase(draft({ id: "s1", opening: "o", persona: "p", goal: "g", outcome: "o".repeat(501), tools: Array.from({ length: 51 }, (_, i) => `t${i}`) }), opts);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["outcome", "tools"]);
  });
});

describe("scenario check", () => {
  it("mirrors the server's per-mode rules", () => {
    expect(scenarioProblem({ input: { script: ["a"] } }, "script")).toBeNull();
    expect(scenarioProblem({ input: {} }, "script")).toMatch(/script/);
    expect(scenarioProblem({ input: { script: [""] } }, "script")).toMatch(/invalid message/);
    expect(scenarioProblem({ input: { opening: "o", persona: "p", goal: "g" } }, "simulated")).toBeNull();
    expect(scenarioProblem({ input: { opening: "o", persona: "p" } }, "simulated")).toBe("scenario needs goal");
    expect(scenarioProblem({ input: { mode: "script", script: ["a"] } }, "simulated")).toBeNull();
  });

  it("counts valid and skipped scenarios under a mode", () => {
    const cases = [{ input: { script: ["a"] } }, { input: { opening: "o", persona: "p", goal: "g" } }, { input: {} }];
    expect(countValidScenarios(cases, "script")).toEqual({ ready: 1, skipped: 2 });
    expect(countValidScenarios(cases, "simulated")).toEqual({ ready: 1, skipped: 2 });
    expect(countValidScenarios([], "script")).toEqual({ ready: 0, skipped: 0 });
  });
});

describe("table rows and banners", () => {
  it("shows mode, title, the opening or first message and expected tools", () => {
    expect(scenarioRow({ id: "s1", title: "T", input: { script: ["Where is my order 1042?", "x"] }, expected: { tools: ["orders.get_status", "b"] }, tags: ["a", "b"] }, "script")).toEqual({
      id: "s1",
      mode: "script",
      title: "T",
      opening: "Where is my order 1042?",
      expectedTools: "orders.get_status, b",
      tags: "a b",
    });
    expect(scenarioRow({ input: { opening: "Hello" } }, "simulated", 2)).toMatchObject({ id: "c003", mode: "simulated", opening: "Hello" });
    const long = scenarioRow({ input: { opening: "word ".repeat(60) } }, "simulated");
    expect(long.opening.endsWith("…")).toBe(true);
  });

  it("summarises validity", () => {
    expect(scenarioSummary(6, 0)).toBe("6 scenarios · all valid");
    expect(scenarioSummary(1, 0)).toBe("1 scenario · all valid");
    expect(scenarioSummary(6, 2)).toBe("6 scenarios · 2 skipped");
    expect(invalidScenarioBanner(0, 6)).toBeNull();
    expect(invalidScenarioBanner(2, 6)).toEqual({ title: "2 of 6 scenarios are invalid.", tail: "Invalid scenarios are skipped in runs until fixed." });
  });

  it("flags a dataset used by both kinds of eval", () => {
    const kinds = new Map<string, "stage" | "agent">([["a", "agent"], ["s", "stage"]]);
    expect(isMixedUse(["a", "s"], kinds)).toBe(true);
    expect(isMixedUse(["a"], kinds)).toBe(false);
    expect(isMixedUse(["a", "unknown"], kinds)).toBe(false);
  });

  it("moves items without mutating", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(list, 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(list, 0, 5)).toEqual(["a", "b", "c"]);
    expect(list).toEqual(["a", "b", "c"]);
  });
});
