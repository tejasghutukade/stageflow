import { describe, expect, it } from "vitest";
import type { EvalDetail, EvalRunEstimate } from "../../../api/evalTypes";
import {
  buildContext,
  buildEstimateRequest,
  buildOptions,
  buildStartRequest,
  caseLabel,
  conversationLine,
  effectiveApprovals,
  effectiveTools,
  estimateText,
  initialState,
  isValid,
  needsConsent,
  saferApprovalsOptions,
  saferToolsOptions,
  userModelDefaultLabel,
  validate,
  type RunDialogContext,
  type RunDialogState,
} from "./runDialogModel";

function detail(conversation: NonNullable<EvalDetail["definition"]>["conversation"] = {}, defaults: Record<string, unknown> = {}): EvalDetail {
  return {
    id: "support-eval",
    path: "evals/support-eval.eval.yaml",
    file_hash: "h",
    definition: {
      version: 1,
      id: "support-eval",
      target: { kind: "agent", agent: "support" },
      dataset: "datasets/support-cases.dataset.jsonl",
      graders: [{ id: "a", type: "tool_calls" }],
      defaults: { repeats: 3, max_cost_usd: 1, judge: "anthropic/claude-sonnet-4-5", ...defaults },
      conversation: { mode: "simulated", max_turns: 8, tools: "read_only", approvals: "record_only", ...conversation },
    },
    yaml: "",
    findings: [],
    runs_count: 0,
    last_run: null,
    agent: { id: "support", name: "Support", model: "anthropic/claude-sonnet-4-5", revision: 4, enabled: true, archived: false, tools: [], ask_first: [], issues: [] },
  };
}

function ctxOf(d = detail(), cases: Array<{ input: Record<string, unknown> }> = []): RunDialogContext {
  return buildContext({ evalId: "support-eval", detail: d, casesTotal: 6, lastCompleted: null, cases });
}

describe("agent run context", () => {
  it("names the agent and its revision in the subtitle", () => {
    const c = ctxOf();
    expect(c.subtitle).toBe("Agent Support · r4 · anthropic/claude-sonnet-4-5 · dataset support-cases · 1 grader");
    expect(c.agent).toMatchObject({ id: "support", name: "Support", revision: 4, model: "anthropic/claude-sonnet-4-5" });
    expect(c.defaults).toEqual({ repeats: 3, maxCostUsd: 1, stageModel: "anthropic/claude-sonnet-4-5", judge: "anthropic/claude-sonnet-4-5" });
  });

  it("defaults the cost limit to $1 and leaves stage contexts alone", () => {
    const noLimit = detail();
    delete noLimit.definition!.defaults!.max_cost_usd;
    expect(ctxOf(noLimit).defaults.maxCostUsd).toBe(1);
    const stage = buildContext({ evalId: "e", detail: { ...detail(), definition: { ...detail().definition!, target: { kind: "stage", pipeline: "p", stage: "s" }, conversation: undefined } }, casesTotal: 1, lastCompleted: null });
    expect(stage.agent).toBeUndefined();
    expect(stage.subtitle).toBe("Stage s · dataset support-cases · 1 grader");
  });

  it("offers the user model only when a scenario is simulated", () => {
    expect(ctxOf(detail({ mode: "script" })).agent?.anySimulated).toBe(false);
    expect(ctxOf(detail({ mode: "script" }), [{ input: { script: ["a"] } }, { input: { mode: "simulated", opening: "o", persona: "p", goal: "g" } }]).agent?.anySimulated).toBe(true);
    expect(ctxOf(detail({ mode: "simulated" })).agent?.anySimulated).toBe(true);
  });

  it("labels the user model default with the eval's model or the judge", () => {
    expect(userModelDefaultLabel(ctxOf(detail({}, { user_model: "openai/gpt-5" })))).toBe("Eval default · openai/gpt-5");
    expect(userModelDefaultLabel(ctxOf())).toBe("Eval default · anthropic/claude-sonnet-4-5");
  });
});

describe("conversation summary and policies", () => {
  it("reads the settings the run will use", () => {
    const c = ctxOf();
    const s = initialState(c);
    expect(conversationLine(c, s)).toBe("Simulated · up to 8 turns · tools read only · approvals recorded");
    expect(conversationLine(c, { ...s, tools: "mocked", approvals: "deny" })).toBe("Simulated · up to 8 turns · tools mocked · approvals denied");
    expect(effectiveTools(s, c)).toBe("read_only");
    expect(effectiveApprovals(s, c)).toBe("record_only");
  });

  it("only offers safer overrides", () => {
    expect(saferToolsOptions(ctxOf(detail({ tools: "real" }))).map((o) => o.value)).toEqual(["", "read_only", "mocked"]);
    expect(saferToolsOptions(ctxOf(detail({ tools: "read_only" }))).map((o) => o.value)).toEqual(["", "mocked"]);
    expect(saferToolsOptions(ctxOf(detail({ tools: "mocked" }))).map((o) => o.value)).toEqual([""]);
    expect(saferApprovalsOptions(ctxOf(detail({ approvals: "auto_approve_read" }))).map((o) => o.value)).toEqual(["", "record_only", "deny"]);
    expect(saferApprovalsOptions(ctxOf(detail({ approvals: "record_only" }))).map((o) => o.value)).toEqual(["", "deny"]);
    expect(saferApprovalsOptions(ctxOf(detail({ approvals: "deny" }))).map((o) => o.value)).toEqual([""]);
  });
});

describe("real tools consent", () => {
  const real = () => ctxOf(detail({ tools: "real", allow_real_tools: true }));

  it("blocks the run until the box is ticked", () => {
    const c = real();
    const s = initialState(c);
    expect(needsConsent(s, c)).toBe(true);
    expect(validate(s, c).consent).toBe("Tick I understand to run with real tools.");
    expect(isValid(s, c)).toBe(false);
    expect(isValid({ ...s, consent: true }, c)).toBe(true);
  });

  it("still estimates before the box is ticked", () => {
    const c = real();
    expect(buildEstimateRequest(initialState(c), c)).toEqual({});
    expect(buildEstimateRequest({ ...initialState(c), repeats: "0" }, c)).toBeNull();
  });

  it("sends allow_real_tools only with the consent", () => {
    const c = real();
    expect(buildStartRequest({ ...initialState(c), consent: true }, c).allow_real_tools).toBe(true);
    expect(buildStartRequest(initialState(c), c)).not.toHaveProperty("allow_real_tools");
  });

  it("needs no consent once the run is made safer", () => {
    const c = real();
    const s: RunDialogState = { ...initialState(c), tools: "read_only" };
    expect(needsConsent(s, c)).toBe(false);
    expect(isValid(s, c)).toBe(true);
    expect(buildStartRequest(s, c)).toMatchObject({ tools: "read_only" });
    expect(buildStartRequest(s, c)).not.toHaveProperty("allow_real_tools");
  });

  it("never asks a read-only eval for consent", () => {
    const c = ctxOf();
    expect(needsConsent(initialState(c), c)).toBe(false);
    expect(buildStartRequest(initialState(c), c)).toEqual({});
  });
});

describe("run options", () => {
  it("sends the overrides the author picked", () => {
    const c = ctxOf();
    const s: RunDialogState = { ...initialState(c), userModel: "openai/gpt-5", tools: "mocked", approvals: "deny", stageModel: "anthropic/claude-haiku-4-5" };
    expect(buildOptions(s, c)).toEqual({ model: "anthropic/claude-haiku-4-5", user_model: "openai/gpt-5", tools: "mocked", approvals: "deny" });
    expect(buildEstimateRequest(s, c)).toMatchObject({ user_model: "openai/gpt-5", tools: "mocked", approvals: "deny" });
    expect(buildOptions(initialState(c), c)).toEqual({});
  });
});

describe("agent estimate", () => {
  const estimate = (over: Partial<EvalRunEstimate> = {}): EvalRunEstimate => ({
    results_total: 18,
    stage_calls: 18,
    judge_calls: 36,
    estimate_usd: 1.42,
    estimate_seconds: 480,
    judge_included: true,
    based_on_run_number: 3,
    target_kind: "agent",
    simulator_calls: 90,
    estimate_basis: "previous_run",
    ...over,
  });

  it("reads conversations, simulator and judge calls with the limit footnote", () => {
    expect(estimateText(estimate(), 1)).toEqual({
      headline: "About $1.42 and 8 m 00 s",
      detail: "18 conversations, 90 simulator calls and 36 judge calls, based on run #3",
      notes: [],
      stops: "stops at $1.00",
      footnote: "A conversation that has started always finishes, so the limit can be passed by a little.",
    });
  });

  it("says the estimate is rough when it comes from assumptions", () => {
    const text = estimateText(estimate({ based_on_run_number: null, estimate_basis: "assumptions" }), 1);
    expect(text.detail).toBe("18 conversations, 90 simulator calls and 36 judge calls. Rough estimate from typical conversations");
  });

  it("handles a script eval and an unknown price", () => {
    const text = estimateText(estimate({ simulator_calls: 0, judge_calls: 0, estimate_usd: null, estimate_seconds: null, estimate_basis: null, based_on_run_number: null }), 1);
    expect(text.headline).toBe("No cost history yet; the limit still applies");
    expect(text.detail).toBe("18 conversations and 0 simulator calls. No previous run to base this on");
  });

  it("leaves the stage estimate without a footnote", () => {
    const stage = estimateText({ results_total: 3, stage_calls: 3, judge_calls: 0, estimate_usd: 0.5, estimate_seconds: 30, judge_included: true, based_on_run_number: 1 }, 2);
    expect(stage).not.toHaveProperty("footnote");
  });
});

describe("case labels", () => {
  it("shows a scenario's opening or first script message for agents only", () => {
    expect(caseLabel({ input: { opening: "I was charged twice" } }, true)).toBe("I was charged twice");
    expect(caseLabel({ input: { script: ["Where is my order?"] } }, true)).toBe("Where is my order?");
    expect(caseLabel({ title: "Refund", input: { opening: "x" } }, true)).toBe("Refund");
    expect(caseLabel({ input: { opening: "x" } })).toBe('{"opening":"x"}');
  });
});
