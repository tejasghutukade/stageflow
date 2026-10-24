import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  EVAL_AGENT_DEFAULT_CONCURRENCY,
  EVAL_AGENT_DEFAULT_MAX_COST_USD,
  loadEvalOutcome,
  parseEvalOutcome,
  resolveConversation,
} from "../src/config/loadEval.js";
import type { LoadIssue } from "../src/config/loadOutcome.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";

const PROJECT = path.join(FIXTURES_ROOT, "evals", "agent", "project");
const EVAL_PATH = path.join(PROJECT, "evals", "support-basics.eval.yaml");

const BASE = [
  "version: 1",
  "id: sample",
  "target:",
  "  kind: agent",
  "  agent: support",
  "dataset: ../datasets/support-scenarios.dataset.jsonl",
  "graders:",
  "  - id: polite",
  "    type: rubric",
  "    rubric: Be polite.",
  "    judge: anthropic/claude-sonnet-4-5",
].join("\n");

function parse(yaml: string) {
  return parseEvalOutcome(yaml, path.join(PROJECT, "evals", "sample.eval.yaml"), PROJECT);
}

function issuesOf(yaml: string): LoadIssue[] {
  const outcome = parse(yaml);
  return outcome.ok ? [] : outcome.issues;
}

function codesOf(yaml: string): string[] {
  return issuesOf(yaml).map((i) => i.code);
}

function withGraders(graders: string): string {
  return BASE.slice(0, BASE.indexOf("graders:")) + `graders:\n${graders}`;
}

describe("loadEval: an agent eval file", () => {
  it("loads the plan example with conversation, user_model and the new graders", async () => {
    const outcome = await loadEvalOutcome(EVAL_PATH, PROJECT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.issues).toBeUndefined();
    const { file, graders } = outcome.value;
    expect(file.target).toEqual({ kind: "agent", agent: "support" });
    expect(file.defaults?.user_model).toBe("anthropic/claude-sonnet-4-5");
    expect(file.conversation).toEqual({
      mode: "simulated",
      max_turns: 8,
      turn_timeout_ms: 120000,
      tools: "read_only",
      approvals: "record_only",
      read_only_tools: ["billing.lookup_invoice"],
    });
    expect(graders.map((g) => [g.id, g.type])).toEqual([
      ["no-refund-without-approval", "tool_calls"],
      ["looks-up-the-invoice", "tool_calls"],
      ["one-question-at-a-time", "conversation_check"],
      ["reaches-the-goal", "goal_reached"],
      ["stays-polite", "rubric"],
    ]);
    const goal = graders.find((g) => g.type === "goal_reached");
    expect(goal).toMatchObject({ weight: 3, judge: "anthropic/claude-sonnet-4-5" });
    const lookup = graders.find((g) => g.id === "looks-up-the-invoice");
    expect(lookup).toMatchObject({
      type: "tool_calls",
      mustCall: ["billing.lookup_invoice"],
      maxCalls: 3,
      args: [{ tool: "billing.lookup_invoice", path: "invoice_id", op: "matches", value: "^INV-[0-9]+$" }],
    });
    expect(graders.find((g) => g.id === "no-refund-without-approval")).toMatchObject({ mustPass: true });
  });

  it("applies conversation defaults and exposes the agent default constants", () => {
    expect(resolveConversation(undefined)).toEqual({
      mode: "script",
      maxTurns: 8,
      turnTimeoutMs: 120000,
      tools: "read_only",
      approvals: "record_only",
      readOnlyTools: [],
      allowRealTools: false,
    });
    expect(resolveConversation({ mode: "simulated", max_turns: 3 })).toMatchObject({
      mode: "simulated",
      maxTurns: 3,
    });
    expect(EVAL_AGENT_DEFAULT_CONCURRENCY).toBe(2);
    expect(EVAL_AGENT_DEFAULT_MAX_COST_USD).toBe(1);
  });

  it("a reference grader defaults to final_reply on an agent target and payload on a stage", () => {
    const agent = parse(withGraders("  - id: ref\n    type: reference\n    mode: equals\n    expected: expected.outcome"));
    expect(agent.ok && agent.value.graders[0]).toMatchObject({ type: "reference", path: "final_reply" });
    const stage = parseEvalOutcome(
      [
        "version: 1",
        "id: sample",
        "target:",
        "  kind: stage",
        "  file: ../stages/review.yaml",
        "dataset: ../datasets/sample.dataset.jsonl",
        "graders:",
        "  - id: ref",
        "    type: reference",
        "    mode: equals",
        "    expected: expected.outcome",
      ].join("\n"),
      path.join(PROJECT, "evals", "sample.eval.yaml"),
      PROJECT,
    );
    expect(stage.ok && stage.value.graders[0]).toMatchObject({ type: "reference", path: "payload" });
  });
});

describe("loadEval: invalid agent values (table)", () => {
  const cases: Array<[string, string, string, string?]> = [
    ["missing agent", BASE.replace("  agent: support\n", ""), "eval.target_invalid"],
    ["bad agent id", BASE.replace("agent: support", "agent: Not-An-Id"), "eval.target_invalid"],
    ["reserved agent id", BASE.replace("agent: support", "agent: new"), "eval.target_invalid"],
    ["revision authored", BASE.replace("agent: support", "agent: support\n  revision: 2"), "eval.target_invalid", "recorded by the run"],
    ["stage key on agent", BASE.replace("agent: support", "agent: support\n  stage: review"), "eval.target_invalid"],
    ["agent key on stage", BASE.replace("kind: agent\n  agent: support", "kind: stage\n  agent: support"), "eval.target_invalid"],
    ["unknown target key", BASE.replace("agent: support", "agent: support\n  colour: red"), "eval.unknown_key"],
    ["task on agent", `${BASE}\ntask:\n  goal: x`, "eval.task_not_applicable"],
    ["conversation on stage", [
      "version: 1", "id: sample", "target:", "  kind: stage", "  file: ../stages/review.yaml",
      "dataset: ../datasets/sample.dataset.jsonl", "conversation:", "  mode: script",
      "graders:", "  - id: s", "    type: schema",
    ].join("\n"), "eval.conversation_not_applicable"],
    ["user_model on stage", [
      "version: 1", "id: sample", "target:", "  kind: stage", "  file: ../stages/review.yaml",
      "dataset: ../datasets/sample.dataset.jsonl", "defaults:", "  user_model: anthropic/x",
      "graders:", "  - id: s", "    type: schema",
    ].join("\n"), "eval.conversation_not_applicable"],
    ["conversation not a mapping", `${BASE}\nconversation: nope`, "eval.conversation_invalid"],
    ["bad mode", `${BASE}\nconversation:\n  mode: chatty`, "eval.conversation_invalid", "mode"],
    ["max_turns 0", `${BASE}\nconversation:\n  max_turns: 0`, "eval.conversation_invalid", "max_turns"],
    ["max_turns 31", `${BASE}\nconversation:\n  max_turns: 31`, "eval.conversation_invalid", "max_turns"],
    ["max_turns fraction", `${BASE}\nconversation:\n  max_turns: 2.5`, "eval.conversation_invalid", "max_turns"],
    ["timeout too low", `${BASE}\nconversation:\n  turn_timeout_ms: 4999`, "eval.conversation_invalid", "turn_timeout_ms"],
    ["timeout too high", `${BASE}\nconversation:\n  turn_timeout_ms: 600001`, "eval.conversation_invalid", "turn_timeout_ms"],
    ["bad tools", `${BASE}\nconversation:\n  tools: all`, "eval.conversation_invalid", "tools"],
    ["bad approvals", `${BASE}\nconversation:\n  approvals: ask`, "eval.conversation_invalid", "approvals"],
    ["read_only_tools not a list", `${BASE}\nconversation:\n  read_only_tools: x`, "eval.conversation_invalid", "read_only_tools"],
    ["read_only_tools bad id", `${BASE}\nconversation:\n  read_only_tools: ["has space"]`, "eval.conversation_invalid", "read_only_tools"],
    ["read_only_tools over 50", `${BASE}\nconversation:\n  read_only_tools: [${Array.from({ length: 51 }, (_, i) => `t${i}`).join(", ")}]`, "eval.conversation_invalid", "read_only_tools"],
    ["allow_real_tools not boolean", `${BASE}\nconversation:\n  tools: real\n  allow_real_tools: yes please`, "eval.conversation_invalid", "allow_real_tools"],
    ["allow_real_tools without real", `${BASE}\nconversation:\n  allow_real_tools: true`, "eval.conversation_invalid", "allow_real_tools"],
    ["unknown conversation key", `${BASE}\nconversation:\n  vibe: high`, "eval.unknown_key"],
    ["empty user_model", `${BASE}\ndefaults:\n  user_model: ""`, "eval.invalid_field"],
    ["tool_calls bad list", withGraders("  - id: t\n    type: tool_calls\n    must_call: nope"), "eval.grader_invalid"],
    ["tool_calls max_calls 201", withGraders("  - id: t\n    type: tool_calls\n    max_calls: 201"), "eval.grader_invalid"],
    ["tool_calls args op", withGraders("  - id: t\n    type: tool_calls\n    args:\n      - { tool: a.b, path: x, op: nope }"), "eval.grader_invalid"],
    ["tool_calls args path", withGraders("  - id: t\n    type: tool_calls\n    args:\n      - { tool: a.b, path: \"x y\", op: exists }"), "eval.grader_invalid"],
    ["tool_calls unknown key", withGraders("  - id: t\n    type: tool_calls\n    colour: red"), "eval.unknown_key"],
    ["conversation_check empty", withGraders("  - id: c\n    type: conversation_check"), "eval.grader_invalid"],
    ["conversation_check max_turns 101", withGraders("  - id: c\n    type: conversation_check\n    max_turns: 101"), "eval.grader_invalid"],
    ["conversation_check questions 11", withGraders("  - id: c\n    type: conversation_check\n    max_agent_questions_per_turn: 11"), "eval.grader_invalid"],
    ["conversation_check final_reply op", withGraders("  - id: c\n    type: conversation_check\n    final_reply:\n      - { op: equals }"), "eval.grader_invalid"],
    ["goal_reached scale", withGraders("  - id: g\n    type: goal_reached\n    scale: pass_fail"), "eval.grader_invalid", "scale"],
    ["goal_reached guidance too long", withGraders(`  - id: g\n    type: goal_reached\n    guidance: ${"x".repeat(2001)}`), "eval.grader_invalid"],
    ["goal_reached judge", withGraders("  - id: g\n    type: goal_reached\n    judge: 3"), "eval.grader_invalid"],
  ];

  it.each(cases)("%s", (_name, yaml, code, fragment) => {
    const issues = issuesOf(yaml);
    expect(issues.map((i) => i.code)).toEqual([code]);
    if (fragment) expect(issues[0]?.message).toContain(fragment);
  });

  it("the grader type list now names all eight types", () => {
    const issues = issuesOf(withGraders("  - id: x\n    type: vibes"));
    expect(issues[0]?.code).toBe("eval.grader_type_unsupported");
    for (const type of [
      "schema", "field", "reference", "rubric", "code", "tool_calls", "conversation_check", "goal_reached",
    ]) {
      expect(issues[0]?.message).toContain(type);
    }
  });

  it("kinds that are neither stage nor agent stay unsupported", () => {
    expect(codesOf(BASE.replace("kind: agent", "kind: team"))).toEqual(["eval.target_kind_unsupported"]);
  });

  it("the kind-less target message mentions both kinds", () => {
    const issues = issuesOf(BASE.replace("  kind: agent\n", ""));
    expect(issues[0]?.message).toContain('"agent"');
  });
});

describe("loadEval: grader hashes", () => {
  it("pins an existing stage grader hash", async () => {
    const outcome = await loadEvalOutcome(path.join(FIXTURES_ROOT, "evals", "valid.eval.yaml"), FIXTURES_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.graders.map((g) => g.hash.slice(0, 6))).toEqual([
      "c9af7f",
      "1da529",
      "5d7c42",
      "e446c0",
      "a60a5c",
    ]);
  });

  it("new grader types hash their configs and are stable", async () => {
    const first = await loadEvalOutcome(EVAL_PATH, PROJECT);
    const second = await loadEvalOutcome(EVAL_PATH, PROJECT);
    if (!first.ok || !second.ok) throw new Error("load failed");
    const hashes = first.value.graders.map((g) => g.hash);
    expect(hashes).toEqual(second.value.graders.map((g) => g.hash));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(first.value.graders[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changing a tool_calls key changes its hash", () => {
    const a = parse(withGraders("  - id: t\n    type: tool_calls\n    must_call: [a.b]"));
    const b = parse(withGraders("  - id: t\n    type: tool_calls\n    must_call: [a.c]"));
    expect(a.ok && b.ok && a.value.graders[0]?.hash !== b.value.graders[0]?.hash).toBe(true);
  });
});
