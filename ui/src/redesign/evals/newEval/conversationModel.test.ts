import { describe, expect, it } from "vitest";
import type { EvalAgentTool } from "../../../api/evalTypes";
import {
  agentEstimateLines,
  conversationErrors,
  conversationSummary,
  conversationValid,
  estimateBasisText,
  fromConversation,
  initialConversation,
  realToolsPending,
  setTools,
  stubbedHint,
  stubbedTools,
  toConversation,
  userModelOf,
} from "./conversationModel";

const tools: EvalAgentTool[] = [
  { id: "read", risk: "read", class: "read" },
  { id: "bash", risk: "write", class: "shell" },
  { id: "billing.lookup_invoice", risk: "unknown", class: "mcp_unknown" },
  { id: "billing.refund", risk: "unknown", class: "mcp_unknown" },
  { id: "stageflow.send_message", risk: "external", class: "external" },
];

describe("conversation defaults", () => {
  it("starts in script mode with the plan's defaults", () => {
    expect(initialConversation()).toEqual({
      mode: "script",
      maxTurns: 8,
      turnTimeoutSec: 120,
      userModel: null,
      tools: "read_only",
      approvals: "record_only",
      readOnlyTools: [],
      allowReal: false,
    });
  });

  it("writes the five basics explicitly, with the timeout in milliseconds", () => {
    expect(toConversation(initialConversation())).toEqual({
      mode: "script",
      max_turns: 8,
      turn_timeout_ms: 120000,
      tools: "read_only",
      approvals: "record_only",
    });
  });

  it("writes read_only_tools only when listed and allow_real_tools only for consented real tools", () => {
    const c = { ...initialConversation(), readOnlyTools: ["billing.lookup_invoice"] };
    expect(toConversation(c).read_only_tools).toEqual(["billing.lookup_invoice"]);
    expect(toConversation(c)).not.toHaveProperty("allow_real_tools");
    const real = { ...initialConversation(), tools: "real" as const, allowReal: true };
    expect(toConversation(real).allow_real_tools).toBe(true);
    expect(toConversation({ ...real, allowReal: false })).not.toHaveProperty("allow_real_tools");
    expect(toConversation({ ...real, tools: "read_only" })).not.toHaveProperty("allow_real_tools");
  });

  it("round-trips a definition's conversation block", () => {
    const draft = fromConversation(
      { mode: "simulated", max_turns: 6, turn_timeout_ms: 90000, tools: "mocked", approvals: "deny", read_only_tools: ["a.*"] },
      "anthropic/claude-sonnet-4-5",
    );
    expect(draft).toMatchObject({ mode: "simulated", maxTurns: 6, turnTimeoutSec: 90, userModel: "anthropic/claude-sonnet-4-5", tools: "mocked", approvals: "deny", readOnlyTools: ["a.*"] });
    expect(toConversation(draft)).toMatchObject({ max_turns: 6, turn_timeout_ms: 90000 });
    expect(fromConversation(undefined, undefined)).toEqual(initialConversation());
  });
});

describe("user model", () => {
  it("is only written for a simulated conversation", () => {
    const c = { ...initialConversation(), userModel: "openai/gpt-5" };
    expect(userModelOf(c)).toBeUndefined();
    expect(userModelOf({ ...c, mode: "simulated" })).toBe("openai/gpt-5");
    expect(userModelOf({ ...c, mode: "simulated", userModel: null })).toBeUndefined();
  });
});

describe("validation", () => {
  it("accepts the defaults", () => {
    expect(conversationValid(initialConversation())).toBe(true);
  });

  it("rejects out-of-range turns and timeouts", () => {
    expect(conversationErrors({ ...initialConversation(), maxTurns: 0 }).maxTurns).toMatch(/1 to 30/);
    expect(conversationErrors({ ...initialConversation(), maxTurns: 31 }).maxTurns).toBeDefined();
    expect(conversationErrors({ ...initialConversation(), maxTurns: 2.5 }).maxTurns).toBeDefined();
    expect(conversationErrors({ ...initialConversation(), turnTimeoutSec: 4 }).turnTimeout).toMatch(/5 to 600/);
    expect(conversationErrors({ ...initialConversation(), turnTimeoutSec: 601 }).turnTimeout).toBeDefined();
    expect(conversationErrors({ ...initialConversation(), maxTurns: Number.NaN }).maxTurns).toBeDefined();
  });

  it("rejects tool ids with spaces and more than 50 of them", () => {
    expect(conversationErrors({ ...initialConversation(), readOnlyTools: ["bad id"] }).readOnlyTools).toMatch(/not a tool id/);
    const many = Array.from({ length: 51 }, (_, i) => `s.t${i}`);
    expect(conversationErrors({ ...initialConversation(), readOnlyTools: many }).readOnlyTools).toMatch(/50/);
  });
});

describe("real tools", () => {
  it("is pending until the consent box is ticked", () => {
    const real = setTools(initialConversation(), "real");
    expect(realToolsPending(real)).toBe(true);
    expect(realToolsPending({ ...real, allowReal: true })).toBe(false);
    expect(realToolsPending(initialConversation())).toBe(false);
  });

  it("drops the consent when the policy leaves real", () => {
    const ticked = { ...initialConversation(), tools: "real" as const, allowReal: true };
    expect(setTools(ticked, "read_only").allowReal).toBe(false);
    expect(setTools(ticked, "real").allowReal).toBe(true);
  });
});

describe("stubbed tools hint", () => {
  it("lists tools that are not read-class and not declared read-only", () => {
    expect(stubbedTools(tools, [])).toEqual(["bash", "billing.lookup_invoice", "billing.refund", "stageflow.send_message"]);
    expect(stubbedTools(tools, ["billing.lookup_invoice"])).toEqual(["bash", "billing.refund", "stageflow.send_message"]);
    expect(stubbedTools(tools, ["billing.*"])).toEqual(["bash", "stageflow.send_message"]);
  });

  it("names the first five and counts all", () => {
    expect(stubbedHint(tools, [])).toBe("4 of this agent's tools are not read-only and will be stubbed: bash, billing.lookup_invoice, billing.refund, stageflow.send_message");
    const many: EvalAgentTool[] = Array.from({ length: 7 }, (_, i) => ({ id: `s.t${i}`, risk: "write", class: "write" }));
    expect(stubbedHint(many, [])).toMatch(/^7 of this agent's tools .*: s\.t0, s\.t1, s\.t2, s\.t3, s\.t4, \.\.\.$/);
    expect(stubbedHint([{ id: "read", risk: "read", class: "read" }], [])).toBeNull();
  });
});

describe("summary line", () => {
  it("reads the settings", () => {
    expect(conversationSummary({ mode: "simulated", max_turns: 8, tools: "read_only", approvals: "record_only" })).toBe(
      "Simulated · up to 8 turns · tools read only · approvals recorded",
    );
    expect(conversationSummary(undefined)).toBe("Script · up to 8 turns · tools read only · approvals recorded");
    expect(conversationSummary({ mode: "script", max_turns: 3, tools: "mocked", approvals: "deny" })).toBe("Script · up to 3 turns · tools mocked · approvals denied");
  });
});

describe("estimate lines", () => {
  it("reads the API's call counts", () => {
    expect(agentEstimateLines({ stage_calls: 24, simulator_calls: 120, judge_calls: 48 })).toEqual([
      { label: "Agent turns", value: "24 conversations" },
      { label: "Simulator", value: "120 calls" },
      { label: "Judge", value: "48 calls" },
    ]);
    expect(agentEstimateLines({ stage_calls: 1, judge_calls: 1 })[1]?.value).toBe("0 calls");
    expect(agentEstimateLines(null)).toEqual([]);
  });

  it("says where the estimate comes from", () => {
    expect(estimateBasisText({ estimate_basis: "assumptions", based_on_run_number: null })).toBe("Rough estimate from typical conversations");
    expect(estimateBasisText({ estimate_basis: "previous_run", based_on_run_number: 4 })).toBe("Based on run #4");
    expect(estimateBasisText({ estimate_basis: null, based_on_run_number: null })).toBeNull();
    expect(estimateBasisText(null)).toBeNull();
  });
});
