import { describe, expect, it } from "vitest";
import type { EvalCaseInput } from "../../../api/evalTypes";
import {
  addGrader,
  agentTargetOf,
  buildDefinition,
  canContinueFromGraders,
  canContinueFromSetup,
  canEnterStep,
  datasetFromAgentConfirm,
  datasetFromScenarios,
  datasetSummary,
  datasetTarget,
  datasetWithCases,
  deriveEvalId,
  gradersProblems,
  initialDraft,
  isAgentDraft,
  recountDataset,
  sameAgent,
  setupChecks,
  setupProblems,
  tryDisabledReason,
  withConversation,
  withTarget,
  withTargetKind,
  type WizardDraft,
} from "./wizardModel";
import { createFromDraft } from "./wizardCreate";
import { DEFAULT_DIRS } from "./wizardModel";

const agent = { id: "support", name: "Support", model: "anthropic/claude-sonnet-4-5", revision: 4, enabled: true };
const scripts: EvalCaseInput[] = [
  { id: "s001", input: { script: ["Where is my order 1042?"] }, expected: { tools: ["orders.get_status"] } },
  { id: "s002", input: { script: ["Cancel it"] } },
];

function agentDraft(): WizardDraft {
  let d = withTarget(initialDraft(), agentTargetOf(agent), null, []);
  d = { ...d, dataset: datasetFromScenarios(scripts, "script", "support", []) };
  d = addGrader(d, "tool_calls");
  return d;
}

describe("agent target in the draft", () => {
  it("switches the draft to an agent when an agent is picked", () => {
    const d = withTarget(initialDraft(), agentTargetOf(agent), null, ["support-eval"]);
    expect(isAgentDraft(d)).toBe(true);
    expect(d.target).toMatchObject({ kind: "agent", agentId: "support", revision: 4, label: "Support", model: "anthropic/claude-sonnet-4-5" });
    expect(d.id).toBe("support-eval-2");
    expect(sameAgent(agent, d.target)).toBe(true);
    expect(sameAgent({ id: "other" }, d.target)).toBe(false);
  });

  it("derives <agent-id>-eval with underscores turned into dashes", () => {
    expect(deriveEvalId("billing_support", [])).toBe("billing-support-eval");
    expect(withTarget(initialDraft(), agentTargetOf({ ...agent, id: "billing_support" }), null, []).id).toBe("billing-support-eval");
  });

  it("drops the other kind's target, dataset and inapplicable graders when the toggle flips", () => {
    let d = agentDraft();
    d = { ...d, graders: [...d.graders, { id: "g-field", type: "field", checks: [{ path: "final_reply", op: "not_empty" }] }] };
    const stage = withTargetKind(d, "stage");
    expect(stage).toMatchObject({ targetKind: "stage", target: null, dataset: null });
    expect(stage.graders.map((g) => g.type)).toEqual(["field"]);
    const back = withTargetKind(addGrader(stage, "schema"), "agent");
    expect(back.graders.map((g) => g.type)).toEqual(["field"]);
    expect(withTargetKind(d, "agent")).toBe(d);
  });

  it("moves the cost limit default with the kind, but keeps a value the author typed", () => {
    expect(withTargetKind(initialDraft(), "agent").defaults.maxCostUsd).toBe(1);
    const typed = { ...initialDraft(), defaults: { ...initialDraft().defaults, maxCostUsd: 5 } };
    expect(withTargetKind(typed, "agent").defaults.maxCostUsd).toBe(5);
    expect(withTargetKind(withTargetKind(initialDraft(), "agent"), "stage").defaults.maxCostUsd).toBe(2);
  });

  it("targets the agent for datasets", () => {
    expect(datasetTarget(agentTargetOf(agent))).toEqual({ agent_id: "support" });
  });
});

describe("agent step validity", () => {
  it("needs an agent and at least one valid scenario", () => {
    expect(setupProblems(withTargetKind(initialDraft(), "agent"))).toEqual(expect.arrayContaining(["Pick an agent to evaluate", "Add a dataset with at least one valid scenario"]));
    expect(canContinueFromSetup(agentDraft())).toBe(true);
    const noScenarios = { ...agentDraft(), dataset: datasetFromScenarios([{ id: "x", input: {} }], "script", "support", []) };
    expect(noScenarios.dataset?.ready).toBe(0);
    expect(canContinueFromSetup(noScenarios)).toBe(false);
  });

  it("needs valid conversation settings", () => {
    const bad = withConversation(agentDraft(), { maxTurns: 99 });
    expect(canContinueFromSetup(bad)).toBe(false);
    expect(setupProblems(bad).join(" ")).toMatch(/Max turns/);
    expect(canContinueFromSetup(withConversation(agentDraft(), { turnTimeoutSec: 1 }))).toBe(false);
  });

  it("needs a grader, and graders that fit an agent", () => {
    const d = agentDraft();
    expect(canContinueFromGraders(d)).toBe(true);
    expect(canContinueFromGraders({ ...d, graders: [] })).toBe(false);
    const schema = { ...d, graders: [{ id: "output-schema", type: "schema", must_pass: true }] };
    expect(gradersProblems(schema)).toContain("output-schema: schema graders do not apply to agents");
    const stage = { ...initialDraft(), graders: [{ id: "t", type: "tool_calls" }] };
    expect(gradersProblems(stage)).toContain("t: tool_calls graders do not apply to stages");
  });

  it("asks for a judge when goal_reached has none", () => {
    const d = addGrader(agentDraft(), "goal_reached");
    expect(gradersProblems(d)).toContain("Pick a judge model for the rubric graders");
    expect(gradersProblems({ ...d, defaults: { ...d.defaults, judge: "anthropic/claude-sonnet-4-5" } })).toEqual([]);
  });

  it("gates the steps", () => {
    expect(canEnterStep(agentDraft(), "review")).toBe(true);
    expect(canEnterStep(withTargetKind(initialDraft(), "agent"), "graders")).toBe(false);
  });
});

describe("definition conversion", () => {
  it("writes the A01 shape with every default explicit", () => {
    const d = { ...agentDraft(), id: "support-eval", name: "Support basics", defaults: { repeats: 3, passThreshold: 0.8, maxCostUsd: 1, judge: "anthropic/claude-sonnet-4-5" } };
    const def = buildDefinition(d, DEFAULT_DIRS);
    expect(def).toEqual({
      version: 1,
      id: "support-eval",
      name: "Support basics",
      type: "capability",
      target: { kind: "agent", agent: "support" },
      dataset: "../datasets/support-cases.dataset.jsonl",
      defaults: { repeats: 3, judge: "anthropic/claude-sonnet-4-5", pass_threshold: 0.8, max_cost_usd: 1, concurrency: 2 },
      conversation: { mode: "script", max_turns: 8, turn_timeout_ms: 120000, tools: "read_only", approvals: "record_only" },
      graders: [{ id: "grader-1", type: "tool_calls" }],
    });
    expect(Object.keys(def!)).toEqual(["version", "id", "name", "type", "target", "dataset", "defaults", "conversation", "graders"]);
    expect(Object.keys(def!.defaults!)).toEqual(["repeats", "judge", "pass_threshold", "max_cost_usd", "concurrency"]);
  });

  it("puts user_model after the judge and only for a simulated conversation", () => {
    const sim = withConversation({ ...agentDraft(), defaults: { ...agentDraft().defaults, judge: "j/m" } }, { mode: "simulated", userModel: "u/m" });
    expect(Object.keys(buildDefinition(sim)!.defaults!)).toEqual(["repeats", "judge", "user_model", "pass_threshold", "max_cost_usd", "concurrency"]);
    expect(buildDefinition(withConversation(sim, { mode: "script" }))!.defaults).not.toHaveProperty("user_model");
  });

  it("carries real tools only with the consent", () => {
    const real = withConversation(agentDraft(), { tools: "real" });
    expect(buildDefinition(real)!.conversation).not.toHaveProperty("allow_real_tools");
    expect(buildDefinition(withConversation(real, { allowReal: true }))!.conversation).toMatchObject({ tools: "real", allow_real_tools: true });
  });

  it("leaves stage definitions as they were", () => {
    const stage = { ...initialDraft(), target: { kind: "pipeline" as const, stageId: "review", pipelinePath: "p/a.pipeline.yaml", label: "x" }, dataset: datasetFromScenarios([], "script", "review", []) };
    const def = buildDefinition(stage);
    expect(def?.conversation).toBeUndefined();
    expect(def?.defaults).toEqual({ repeats: 3, pass_threshold: 0.8, max_cost_usd: 2 });
  });
});

describe("held scenarios", () => {
  it("counts valid and skipped scenarios under the conversation mode and again when it changes", () => {
    const mixed: EvalCaseInput[] = [...scripts, { id: "s003", input: { opening: "o", persona: "p", goal: "g" } }];
    let d: WizardDraft = { ...agentDraft(), dataset: datasetFromScenarios(mixed, "script", "support", []) };
    expect(d.dataset).toMatchObject({ ready: 2, skipped: 1 });
    d = withConversation(d, { mode: "simulated" });
    expect(d.dataset).toMatchObject({ ready: 1, skipped: 2 });
    expect(datasetSummary(d.dataset!, true)).toEqual({ title: "1 scenario", match: "2 skipped" });
    expect(datasetSummary({ ...d.dataset!, skipped: 0 }, true).match).toBe("all valid");
  });

  it("leaves the stage wording alone", () => {
    expect(datasetSummary({ ...datasetFromScenarios(scripts, "script", "x", []), skipped: 0 })).toEqual({ title: "2 cases", match: "all match io.input" });
  });

  it("holds the rows an upload gave that fit the mode and counts the rest as skipped", () => {
    const ds = datasetFromAgentConfirm(
      { candidates: [...scripts, { id: "x", input: {} }], cases: scripts, fileName: "scenarios.jsonl" },
      "upload",
      "support",
      [],
      "script",
    );
    expect(ds).toMatchObject({ ready: 2, skipped: 1, importSkipped: 1, fileName: "scenarios.jsonl", source: "upload" });
    expect(ds.cases).toHaveLength(2);
    expect(recountDataset(ds, "simulated")).toMatchObject({ ready: 0, skipped: 3 });
  });

  it("adds, replaces and removes scenarios", () => {
    const base = datasetFromScenarios(scripts, "script", "support", []);
    const added = datasetWithCases(base, [...scripts, { id: "s003", input: { script: ["x"] } }], "script", "support", []);
    expect(added?.ready).toBe(3);
    expect(datasetWithCases(null, [], "script", "support", [])).toBeNull();
    expect(datasetWithCases(base, [], "script", "support", [])).toMatchObject({ ready: 0 });
    expect(datasetWithCases(null, [scripts[0]!], "script", "support", ["support-cases"])?.name).toBe("support-cases-2");
  });
});

describe("checks and try", () => {
  it("lists the agent and the scenario count", () => {
    const lines = setupChecks(agentDraft(), []);
    expect(lines.map((l) => l.text)).toEqual(["Agent support found (r4)", "2 of 2 scenarios valid"]);
    const missing = setupChecks(agentDraft(), [{ severity: "error", code: "eval.agent_not_found", message: "Agent support was not found", path: "x" } as never]);
    expect(missing.map((l) => l.text)).toEqual(["2 of 2 scenarios valid", "Agent support was not found"]);
  });

  it("blocks try until real tools are acknowledged", () => {
    const real = withConversation(agentDraft(), { tools: "real" });
    expect(tryDisabledReason(real, [])).toBe("Tick I understand on the Conversation card to try with real tools.");
    expect(tryDisabledReason(withConversation(real, { allowReal: true }), [])).toBeNull();
    expect(tryDisabledReason(agentDraft(), [{ severity: "error", code: "eval.x", message: "m", path: "p" } as never])).toBe("Fix the errors in the draft first.");
  });
});

describe("create", () => {
  it("writes a sessions dataset from the chosen session ids", async () => {
    let d = agentDraft();
    d = { ...d, id: "support-eval", dataset: { source: "sessions", fileName: "Past sessions", name: "support-cases", cases: null, runIds: ["s_1", "s_2"], runPreviews: [], ready: 2, skipped: 0 } };
    const calls: unknown[] = [];
    const out = await createFromDraft(d, DEFAULT_DIRS, {
      createDataset: async (input) => void calls.push(input),
      createEval: async () => ({ id: "support-eval" }),
    });
    expect(out).toEqual({ ok: true, evalId: "support-eval" });
    expect(calls[0]).toEqual({ name: "support-cases", directory: "datasets", source: "sessions", target: { agent_id: "support" }, session_ids: ["s_1", "s_2"] });
  });

  it("writes typed scenarios as a plain cases dataset", async () => {
    const calls: unknown[] = [];
    await createFromDraft({ ...agentDraft(), id: "support-eval" }, DEFAULT_DIRS, {
      createDataset: async (input) => void calls.push(input),
      createEval: async () => ({ id: "support-eval" }),
    });
    expect(calls[0]).toMatchObject({ name: "support-cases", cases: scripts });
  });
});
