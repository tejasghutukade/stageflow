import { describe, expect, it } from "vitest";
import {
  AGENT_GRADER_TYPES,
  GRADER_TYPES,
  argToRow,
  argsOf,
  chipFor,
  describeGrader,
  finalReplyOf,
  finalReplyToRow,
  graderProblems,
  graderTypesFor,
  hasRubricWithoutJudge,
  newGrader,
  rowToArg,
  rowToFinalReply,
  setArgs,
  setFinalReply,
  setJudge,
  setOptionalInt,
  setStringList,
  stringList,
  ungrantedToolNames,
  type GraderConfig,
} from "./graderForms";

describe("Add grader menu", () => {
  it("hides schema for agents and adds the three conversation types", () => {
    expect(graderTypesFor("agent").map((t) => t.type)).toEqual(["field", "reference", "rubric", "code", "tool_calls", "conversation_check", "goal_reached"]);
  });

  it("keeps the stage menu exactly as it was", () => {
    expect(graderTypesFor("stage")).toBe(GRADER_TYPES);
    expect(graderTypesFor("stage").map((t) => t.type)).toEqual(["schema", "field", "reference", "rubric", "code"]);
  });

  it("marks the new types as agent types", () => {
    expect(AGENT_GRADER_TYPES.every((t) => t.agent === true)).toBe(true);
    expect(AGENT_GRADER_TYPES.map((t) => t.chip)).toEqual(["Check", "Check", "Rubric"]);
    expect(chipFor("goal_reached")).toBe("Rubric");
    expect(chipFor("tool_calls")).toBe("Check");
  });
});

describe("new agent graders", () => {
  it("starts tool_calls empty so the scenarios' expected tools apply", () => {
    expect(newGrader("tool_calls", [])).toEqual({ id: "grader-1", type: "tool_calls" });
    expect(describeGrader(newGrader("tool_calls", []))).toBe("Uses each scenario's expected tools");
  });

  it("starts conversation_check with a turn cap and goal_reached bare", () => {
    expect(newGrader("conversation_check", ["grader-1"])).toEqual({ id: "grader-2", type: "conversation_check", max_turns: 8 });
    expect(newGrader("goal_reached", [])).toEqual({ id: "grader-1", type: "goal_reached" });
  });

  it("treats goal_reached like a rubric for the judge requirement", () => {
    expect(hasRubricWithoutJudge([newGrader("goal_reached", [])])).toBe(true);
    expect(hasRubricWithoutJudge([setJudge(newGrader("goal_reached", []), "a/b")])).toBe(false);
    expect(hasRubricWithoutJudge([newGrader("tool_calls", [])])).toBe(false);
  });
});

describe("tool_calls", () => {
  const base: GraderConfig = { id: "t", type: "tool_calls" };

  it("drops a list key when it is emptied", () => {
    const withList = setStringList(base, "must_call", ["billing.lookup_invoice"]);
    expect(stringList(withList, "must_call")).toEqual(["billing.lookup_invoice"]);
    expect(setStringList(withList, "must_call", [])).toEqual(base);
  });

  it("sets and clears integer keys within the range", () => {
    const ok = setOptionalInt(base, "max_calls", "3", { min: 0, max: 200 });
    expect(ok).toEqual({ ok: true, grader: { id: "t", type: "tool_calls", max_calls: 3 } });
    expect(setOptionalInt(base, "max_calls", "0", { min: 0, max: 200 })).toMatchObject({ ok: true });
    expect(setOptionalInt(base, "max_calls", "201", { min: 0, max: 200 })).toEqual({ ok: false, error: "Enter a whole number from 0 to 200" });
    expect(setOptionalInt(base, "max_calls", "1.5", { min: 0, max: 200 })).toMatchObject({ ok: false });
    expect(setOptionalInt({ ...base, max_calls: 4 }, "max_calls", "", { min: 0, max: 200 })).toEqual({ ok: true, grader: base });
  });

  it("turns argument rows into checks and back", () => {
    const row = { tool: "billing.lookup_invoice", path: "invoice_id", op: "matches", valueText: "^INV-[0-9]+$" };
    expect(rowToArg(row)).toEqual({ ok: true, arg: { tool: "billing.lookup_invoice", path: "invoice_id", op: "matches", value: "^INV-[0-9]+$" } });
    expect(argToRow({ tool: "a.b", path: "n", op: "gte", value: 2 })).toEqual({ tool: "a.b", path: "n", op: "gte", valueText: "2" });
    expect(rowToArg({ ...row, tool: " " })).toEqual({ ok: false, error: "Tool is required" });
    expect(rowToArg({ ...row, path: "" })).toEqual({ ok: false, error: "Path is required" });
    expect(rowToArg({ ...row, valueText: "(" })).toEqual({ ok: false, error: "Not a valid regular expression" });
    expect(rowToArg({ tool: "a.b", path: "x", op: "exists", valueText: "ignored" })).toEqual({ ok: true, arg: { tool: "a.b", path: "x", op: "exists" } });
  });

  it("stores arguments, dropping the key when none are left", () => {
    const arg = { tool: "a.b", path: "x", op: "exists" };
    const g = setArgs(base, [arg]);
    expect(argsOf(g)).toEqual([arg]);
    expect(setArgs(g, [])).toEqual(base);
  });

  it("finds tool names the agent is not granted", () => {
    const g: GraderConfig = { id: "t", type: "tool_calls", must_call: ["billing.lookup_invoice"], must_not_call: ["billing.*", "crm.*"], must_ask_first: ["bash"], args: [{ tool: "orders.get", path: "id", op: "exists" }] };
    expect(ungrantedToolNames(g, ["billing.lookup_invoice", "bash"])).toEqual(["crm.*", "orders.get"]);
    expect(ungrantedToolNames(g, ["billing.lookup_invoice", "bash", "crm.find", "orders.get"])).toEqual([]);
    expect(ungrantedToolNames({ id: "f", type: "field" }, [])).toEqual([]);
  });

  it("describes what it checks", () => {
    expect(describeGrader({ ...base, must_call: ["a.b"], must_not_call: ["c.d"], max_calls: 3 })).toBe("must call a.b · must not call c.d · at most 3 calls");
    expect(describeGrader({ ...base, must_ask_first: ["bash"], args: [{ tool: "a", path: "p", op: "exists" }] })).toBe("must ask first bash · 1 argument check");
    expect(describeGrader({ ...base, description: "Custom" })).toBe("Custom");
  });

  it("rejects an out-of-range max_calls and too many argument rows", () => {
    expect(graderProblems({ ...base, max_calls: 201 })).toEqual(["Max calls must be a whole number from 0 to 200"]);
    expect(graderProblems({ ...base, args: Array.from({ length: 21 }, () => ({ tool: "a", path: "p", op: "exists" })) })).toEqual(["At most 20 argument checks"]);
    expect(graderProblems(base)).toEqual([]);
  });
});

describe("conversation_check", () => {
  const base: GraderConfig = { id: "c", type: "conversation_check" };

  it("needs at least one check", () => {
    expect(graderProblems(base)).toEqual(["Set at least one check"]);
    expect(graderProblems({ ...base, max_turns: 6 })).toEqual([]);
    expect(graderProblems({ ...base, final_reply: [{ op: "not_empty" }] })).toEqual([]);
  });

  it("keeps the numbers in range", () => {
    expect(graderProblems({ ...base, max_turns: 0 })).toContain("Max turns must be a whole number from 1 to 100");
    expect(graderProblems({ ...base, max_agent_questions_per_turn: 11 })).toContain("Max questions per agent turn must be a whole number from 0 to 10");
    expect(graderProblems({ ...base, max_agent_questions_per_turn: 0 })).toEqual([]);
  });

  it("round-trips final reply checks", () => {
    const row = finalReplyToRow({ op: "contains", value: "refund" });
    expect(row).toEqual({ op: "contains", valueText: "refund" });
    expect(rowToFinalReply(row)).toEqual({ ok: true, check: { op: "contains", value: "refund" } });
    expect(rowToFinalReply({ op: "not_empty", valueText: "" })).toEqual({ ok: true, check: { op: "not_empty" } });
    expect(rowToFinalReply({ op: "contains", valueText: "" })).toEqual({ ok: false, error: "Value is required" });
    const g = setFinalReply(base, [{ op: "not_empty" }]);
    expect(finalReplyOf(g)).toEqual([{ op: "not_empty" }]);
    expect(setFinalReply(g, [])).toEqual(base);
  });

  it("describes what it checks", () => {
    expect(describeGrader({ ...base, max_turns: 6, max_agent_questions_per_turn: 1, final_reply: [{ op: "not_empty" }] })).toBe("at most 6 turns · at most 1 question per turn · 1 final reply check");
    expect(describeGrader(base)).toBe("No checks yet");
  });
});

describe("goal_reached", () => {
  it("describes itself with its guidance or the fixed line", () => {
    expect(describeGrader({ id: "g", type: "goal_reached" })).toBe("Judged on the whole conversation. Uses each scenario's goal.");
    expect(describeGrader({ id: "g", type: "goal_reached", guidance: "Be strict.\nSecond line" })).toBe("Be strict.");
  });

  it("limits the guidance", () => {
    expect(graderProblems({ id: "g", type: "goal_reached", guidance: "x".repeat(2001) })).toEqual(["Guidance is limited to 2,000 characters"]);
    expect(graderProblems({ id: "g", type: "goal_reached", guidance: "ok" })).toEqual([]);
  });
});
