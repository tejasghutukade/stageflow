import { describe, expect, it } from "vitest";
import { CONVERSATION_RUBRIC_PROMPT_VERSION } from "../src/evals/constants.js";
import {
  buildComponents,
  buildSnapshot,
  computeFingerprint,
  type AgentComponent,
  type ComponentsInput,
  type SnapshotInput,
} from "../src/evals/snapshot.js";

const STAGE_INPUT: ComponentsInput = {
  stageVersionHash: "stagehash",
  model: "anthropic/claude-sonnet-4-5",
  datasetHash: "datasethash",
  caseIds: ["b", "a"],
  graders: [
    { id: "g2", hash: "h2" },
    { id: "g1", hash: "h1" },
  ],
  judge: "anthropic/claude-sonnet-4-5",
  repeats: 3,
  passThreshold: 0.8,
  engine: { name: "promptfoo", version: "1.0.0" },
};

describe("stage snapshot stays byte-identical", () => {
  it("pins the stage fingerprint and components", () => {
    const components = buildComponents(STAGE_INPUT);
    expect(components).toEqual({
      stage: "stagehash",
      model: "anthropic/claude-sonnet-4-5",
      dataset: "datasethash",
      case_ids: ["a", "b"],
      graders: { g1: "h1", g2: "h2" },
      judge: "anthropic/claude-sonnet-4-5",
      repeats: 3,
      pass_threshold: 0.8,
      engine: { name: "promptfoo", version: "1.0.0" },
      rubric_prompt_version: 1,
    });
    expect(computeFingerprint(components)).toBe("cabca1ea");
  });

  it("pins the stage snapshot JSON", () => {
    const snapshot = buildSnapshot({
      evalId: "e",
      evalPath: "e.eval.yaml",
      evalHash: "eh",
      evalDefinition: { id: "e" },
      overrides: { repeats: null, judge: null, model: null, max_cost_usd: null, case_ids: null, tags: null, only_failed_from: null },
      target: {
        pipeline_path: "p.yaml",
        stage_id: "s",
        file: null,
        stage_version_hash: "stagehash",
        stage_definition: { id: "s" },
        model: "m",
        model_tier: "t",
        input_schema_hash: null,
        output_schema_hash: null,
      },
      dataset: { path: "d.jsonl", hash: "dh", format: "jsonl", case_count: 1, cases_run: 1, cases_skipped: 0, skipped_case_ids: [] },
      graders: [],
      settings: { repeats: 1, pass_threshold: 0.8, judge: "j", judge_same_as_stage: false, max_cost_usd: 1, concurrency: 1, suite_type: "capability" },
      engine: { name: "promptfoo", version: "1.0.0", nodeVersion: "22.0.0" },
      stageflowVersion: "0.0.0",
    });
    expect(JSON.stringify(snapshot)).toBe("{\"snapshot_version\":1,\"eval\":{\"id\":\"e\",\"path\":\"e.eval.yaml\",\"hash\":\"eh\",\"definition\":{\"id\":\"e\"}},\"overrides\":{\"repeats\":null,\"judge\":null,\"model\":null,\"max_cost_usd\":null,\"case_ids\":null,\"tags\":null,\"only_failed_from\":null},\"target\":{\"kind\":\"stage\",\"pipeline_path\":\"p.yaml\",\"stage_id\":\"s\",\"file\":null,\"stage_version_hash\":\"stagehash\",\"stage_definition\":{\"id\":\"s\"},\"model\":\"m\",\"model_tier\":\"t\",\"input_schema_hash\":null,\"output_schema_hash\":null},\"dataset\":{\"path\":\"d.jsonl\",\"hash\":\"dh\",\"format\":\"jsonl\",\"case_count\":1,\"cases_run\":1,\"cases_skipped\":0,\"skipped_case_ids\":[]},\"graders\":[],\"settings\":{\"repeats\":1,\"pass_threshold\":0.8,\"judge\":\"j\",\"judge_same_as_stage\":false,\"max_cost_usd\":1,\"concurrency\":1,\"suite_type\":\"capability\"},\"engine\":{\"name\":\"promptfoo\",\"version\":\"1.0.0\",\"rubric_prompt_version\":1,\"node_version\":\"22.0.0\"},\"stageflow_version\":\"0.0.0\"}");
  });
});

const AGENT: AgentComponent = {
  revision: 4,
  mode: "simulated",
  max_turns: 8,
  turn_timeout_ms: 120000,
  tools: "read_only",
  approvals: "record_only",
  read_only_tools: [],
  user_model: "anthropic/claude-sonnet-4-5",
  simulator_prompt_version: 1,
};

function agentInput(patch: Partial<ComponentsInput> = {}, agent: Partial<AgentComponent> = {}): ComponentsInput {
  return { ...STAGE_INPUT, agent: { ...AGENT, ...agent }, ...patch };
}

const fp = (input: ComponentsInput): string => computeFingerprint(buildComponents(input));

describe("agent fingerprint", () => {
  it("uses the conversation rubric version and the agent key, and differs from the stage fingerprint", () => {
    const components = buildComponents(agentInput());
    expect(components.rubric_prompt_version).toBe(CONVERSATION_RUBRIC_PROMPT_VERSION);
    expect(components.agent).toEqual(AGENT);
    expect(fp(agentInput())).not.toBe(fp(STAGE_INPUT));
    expect(buildComponents(STAGE_INPUT)).not.toHaveProperty("agent");
  });

  const changes: Array<[string, ComponentsInput]> = [
    ["definition hash", agentInput({ stageVersionHash: "other" })],
    ["effective model", agentInput({ model: "openai/gpt-5" })],
    ["conversation rubric version", agentInput({ rubricPromptVersion: CONVERSATION_RUBRIC_PROMPT_VERSION + 1 })],
    ["revision", agentInput({}, { revision: 5 })],
    ["mode", agentInput({}, { mode: "script", user_model: null })],
    ["max_turns", agentInput({}, { max_turns: 9 })],
    ["turn_timeout_ms", agentInput({}, { turn_timeout_ms: 60000 })],
    ["tool policy", agentInput({}, { tools: "stubbed" })],
    ["approval policy", agentInput({}, { approvals: "auto_approve" })],
    ["read_only_tools", agentInput({}, { read_only_tools: ["billing.lookup"] })],
    ["user model", agentInput({}, { user_model: "openai/gpt-5" })],
    ["simulator prompt version", agentInput({}, { simulator_prompt_version: 2 })],
  ];

  it.each(changes)("changes when the %s changes", (_name, changed) => {
    expect(fp(changed)).not.toBe(fp(agentInput()));
  });

  it("ignores read_only_tools order", () => {
    expect(fp(agentInput({}, { read_only_tools: ["a", "b"] }))).toBe(fp(agentInput({}, { read_only_tools: ["b", "a"] })));
  });

  it("does not depend on cost cap or concurrency: they are snapshot settings, not component inputs", () => {
    const a = buildSnapshot(agentSnapshotInput({ max_cost_usd: 1, concurrency: 1 }));
    const b = buildSnapshot(agentSnapshotInput({ max_cost_usd: 50, concurrency: 8 }));
    expect(a.settings.max_cost_usd).not.toBe(b.settings.max_cost_usd);
    expect(Object.keys(agentInput())).not.toContain("maxCostUsd");
    expect(Object.keys(agentInput())).not.toContain("concurrency");
    expect(fp(agentInput())).toBe(fp(agentInput()));
  });
});

function agentSnapshotInput(settings: { max_cost_usd: number; concurrency: number }): SnapshotInput {
  return {
    evalId: "support-basics",
    evalPath: "evals/support-basics.eval.yaml",
    evalHash: "eh",
    evalDefinition: {},
    overrides: { repeats: null, judge: null, model: null, user_model: null, tools: null, approvals: null, max_cost_usd: null, case_ids: null, tags: null, only_failed_from: null },
    target: {
      agent_id: "support",
      revision: 4,
      definition_hash: "dh",
      definition: { id: "support" },
      model: "anthropic/claude-sonnet-4-5",
      model_tier: "",
      tools: [{ id: "billing.refund", risk: "unknown", class: "mcp_unknown" }],
      ask_first: ["billing.refund"],
      sub_agents: [{ id: "helper", revision: 2 }],
      limits_override: {
        agent: { max_turns: 40, session_minutes: 10, cost_usd: null, always_on: false },
        effective: { max_turns: 9, session_minutes: 22, cost_usd: null, always_on: false },
        capture: "full",
        otlp: false,
        groundedness: false,
      },
    },
    dataset: { path: "d.jsonl", hash: "dh", format: "jsonl", case_count: 1, cases_run: 1, cases_skipped: 0, skipped_case_ids: [] },
    graders: [],
    settings: {
      repeats: 1, pass_threshold: 0.8, judge: "j", judge_same_as_stage: false, ...settings, suite_type: "capability",
      conversation: {
        mode: "simulated", max_turns: 8, turn_timeout_ms: 120000, tools: "read_only", approvals: "record_only",
        read_only_tools: [], real_tools_confirmed: false, user_model: "m", user_model_from_judge: true, simulator_prompt_version: 1,
      },
    },
    engine: { name: "promptfoo", version: "1.0.0", nodeVersion: "22.0.0" },
    stageflowVersion: "0.0.0",
  };
}

describe("agent snapshot", () => {
  it("writes an agent target, effective limits, conversation settings and the conversation rubric version", () => {
    const snapshot = buildSnapshot(agentSnapshotInput({ max_cost_usd: 1, concurrency: 2 }));
    expect(snapshot.snapshot_version).toBe(1);
    expect(snapshot.target.kind).toBe("agent");
    if (snapshot.target.kind !== "agent") return;
    expect(snapshot.target.limits_override.effective.max_turns).toBe(9);
    expect(snapshot.target.ask_first).toEqual(["billing.refund"]);
    expect(snapshot.settings.conversation?.simulator_prompt_version).toBe(1);
    expect(snapshot.engine.rubric_prompt_version).toBe(CONVERSATION_RUBRIC_PROMPT_VERSION);
  });
});
