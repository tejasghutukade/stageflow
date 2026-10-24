import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDatasetFile } from "../src/config/loadDataset.js";
import { loadEvalOutcome, parseEvalOutcome, type LoadedEval } from "../src/config/loadEval.js";
import { resolveAgentTarget, resolveAgentTargetFromFile } from "../src/config/resolveAgentTarget.js";
import type { ValidationFinding } from "../src/config/validateCatalog.js";
import { validateEval, type DatasetReport } from "../src/config/validateEval.js";
import { FIXTURES_ROOT } from "./helpers/fixturePaths.js";
import { agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const PROJECT_FIXTURE = path.join(FIXTURES_ROOT, "evals", "agent", "project");

const AGENT_YAML = (extra = "", model = "anthropic/claude-haiku-4-5") =>
  [
    "id: support",
    "name: Support",
    "enabled: true",
    "instructions: Help customers.",
    "model:",
    `  id: ${model}`,
    "tools:",
    "  builtin: [read]",
    "  mcp:",
    "    billing: [lookup_invoice, refund]",
    "approvals:",
    "  ask_first: [billing.refund]",
    extra,
  ].join("\n");

const EVAL_HEAD = [
  "version: 1",
  "id: support-basics",
  "target:",
  "  kind: agent",
  "  agent: support",
  "dataset: ../datasets/support-scenarios.dataset.jsonl",
].join("\n");

const GRADERS = [
  "graders:",
  "  - id: calls",
  "    type: tool_calls",
  "    must_call: [billing.lookup_invoice]",
].join("\n");

let fx: AgentsFixture;

beforeEach(async () => {
  fx = await agentsFixture();
  await fx.writeAgentFile("support", AGENT_YAML());
  await mkdir(path.join(fx.project, "evals"), { recursive: true });
  await mkdir(path.join(fx.project, "datasets"), { recursive: true });
  await cp(
    path.join(PROJECT_FIXTURE, "datasets", "support-scenarios.dataset.jsonl"),
    path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"),
  );
});

afterEach(async () => {
  await fx.cleanup();
});

function load(yaml: string): LoadedEval {
  const outcome = parseEvalOutcome(yaml, path.join(fx.project, "evals", "support-basics.eval.yaml"), fx.project);
  if (!outcome.ok) throw new Error(outcome.issues.map((i) => i.message).join("; "));
  return outcome.value;
}

function evalYaml(opts: { defaults?: string; conversation?: string; graders?: string } = {}): string {
  return [
    EVAL_HEAD,
    opts.defaults ? `defaults:\n${opts.defaults}` : "",
    opts.conversation ? `conversation:\n${opts.conversation}` : "",
    opts.graders ?? GRADERS,
  ]
    .filter(Boolean)
    .join("\n");
}

async function report(): Promise<DatasetReport> {
  const loaded = await loadDatasetFile(path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"), {
    root: fx.project,
  });
  return {
    path: loaded.path,
    relPath: loaded.relPath,
    cases: loaded.cases,
    findings: loaded.findings,
    contentHash: loaded.contentHash,
  };
}

const codes = (findings: ValidationFinding[]): string[] => findings.map((f) => f.code);
const find = (findings: ValidationFinding[], code: string) => findings.find((f) => f.code === code);

async function validate(yaml: string, extra: Partial<Parameters<typeof validateEval>[1]> = {}) {
  return validateEval(load(yaml), { projectRoot: fx.project, agents: fx.service, ...extra });
}

describe("validateEval: agent targets", () => {
  it("the fixture eval with its dataset has no errors against a real agent service", async () => {
    const outcome = await loadEvalOutcome(path.join(PROJECT_FIXTURE, "evals", "support-basics.eval.yaml"), PROJECT_FIXTURE);
    if (!outcome.ok) throw new Error("load failed");
    await cp(path.join(PROJECT_FIXTURE, "agents", "support.agent.yaml"), path.join(fx.project, "agents", "support.agent.yaml"));
    await cp(path.join(PROJECT_FIXTURE, "evals", "support-basics.eval.yaml"), path.join(fx.project, "evals", "support-basics.eval.yaml"));
    const loaded = load(await (await import("node:fs/promises")).readFile(path.join(fx.project, "evals", "support-basics.eval.yaml"), "utf8"));
    const findings = await validateEval(loaded, {
      projectRoot: fx.project,
      agents: fx.service,
      datasetReport: await report(),
    });
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(codes(findings)).toContain("eval.tools_unstubbed_list");
  });

  it("resolves the agent revision, hash, tools and ask-first list", async () => {
    const loaded = load(evalYaml());
    const resolved = await resolveAgentTarget(loaded.file, fx.project, fx.service);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const { value } = resolved;
    expect(value.agentId).toBe("support");
    expect(value.revision).toBe(1);
    expect(value.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(value.modelResolved).toBe("anthropic/claude-haiku-4-5");
    expect(value.askFirst).toContain("billing.refund");
    expect(value.tools.find((t) => t.id === "read")?.risk).toBe("read");
    expect(value.tools.find((t) => t.id === "billing.refund")?.risk).toBe("mcp_unknown");
  });

  it("the definition hash is stable and follows the defaults.model override", async () => {
    const plain = load(evalYaml());
    const same = await resolveAgentTarget(plain.file, fx.project, fx.service);
    const again = await resolveAgentTarget(plain.file, fx.project, fx.service);
    const overridden = load(evalYaml({ defaults: "  model: openai/gpt-5" }));
    const other = await resolveAgentTarget(overridden.file, fx.project, fx.service);
    if (!same.ok || !again.ok || !other.ok) throw new Error("resolve failed");
    expect(same.value.definitionHash).toBe(again.value.definitionHash);
    expect(other.value.definitionHash).not.toBe(same.value.definitionHash);
    expect(other.value.modelResolved).toBe("openai/gpt-5");
  });

  it("a missing agent is an error", async () => {
    const findings = await validate(evalYaml().replace("agent: support", "agent: ghost"));
    expect(find(findings, "eval.agent_not_found")?.severity).toBe("error");
  });

  it("an archived agent is an error", async () => {
    await fx.service.list(fx.project);
    await rm(path.join(fx.project, "agents", "support.agent.yaml"));
    const findings = await validate(evalYaml());
    expect(find(findings, "eval.agent_archived")?.severity).toBe("error");
  });

  it("a disabled agent is a warning only", async () => {
    await fx.writeAgentFile("support", AGENT_YAML().replace("enabled: true", "enabled: false"));
    const findings = await validate(evalYaml());
    expect(find(findings, "eval.agent_disabled")?.severity).toBe("warning");
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("an agent with parse issues is an error", async () => {
    await fx.writeAgentFile("support", "id: support\nname: Support\ninstructions: x\ncolour: red\n");
    const findings = await validate(evalYaml());
    const finding = find(findings, "eval.agent_invalid");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("colour");
  });

  it("an agent whose file broke after loading is an error", async () => {
    await fx.service.list(fx.project);
    await fx.writeAgentFile("support", "id: support\nname: Support\ninstructions: x\ncolour: red\n");
    const findings = await validate(evalYaml());
    expect(codes(findings)).toContain("eval.agent_invalid");
  });

  it("offline resolution parses the agent file only and has no revision", async () => {
    const loaded = load(evalYaml());
    const resolved = await resolveAgentTargetFromFile(loaded.file, fx.project);
    expect(resolved.ok && resolved.value.revision).toBe(null);
    const findings = await validateEval(loaded, { projectRoot: fx.project });
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const missing = await validateEval(load(evalYaml().replace("agent: support", "agent: ghost")), {
      projectRoot: fx.project,
    });
    expect(codes(missing)).toContain("eval.agent_not_found");
    await fx.writeAgentFile("support", "name: nope\n");
    const broken = await validateEval(loaded, { projectRoot: fx.project });
    expect(codes(broken)).toContain("eval.agent_invalid");
    await fx.writeAgentFile("support", AGENT_YAML().replace("enabled: true", "enabled: false"));
    const disabled = await validateEval(loaded, { projectRoot: fx.project });
    expect(find(disabled, "eval.agent_disabled")?.severity).toBe("warning");
  });
});

describe("validateEval: grader and target applicability", () => {
  it("a schema grader on an agent target is not applicable", async () => {
    const findings = await validate(evalYaml({ graders: "graders:\n  - id: s\n    type: schema" }));
    expect(find(findings, "eval.grader_not_applicable")?.severity).toBe("error");
    expect(codes(findings)).not.toContain("eval.schema_grader_without_output_schema");
  });

  it.each([
    ["tool_calls", "    type: tool_calls\n    must_call: [a.b]"],
    ["conversation_check", "    type: conversation_check\n    max_turns: 3"],
    ["goal_reached", "    type: goal_reached"],
  ])("a %s grader on a stage target is not applicable", async (_type, body) => {
    const stage = [
      "version: 1",
      "id: support-basics",
      "target:",
      "  kind: stage",
      "  file: ../stages/review.yaml",
      "dataset: ../datasets/support-scenarios.dataset.jsonl",
      "defaults:",
      "  judge: anthropic/claude-sonnet-4-5",
      "graders:",
      "  - id: g",
      body,
    ].join("\n");
    const findings = await validateEval(load(stage), { projectRoot: fx.project });
    const hit = find(findings, "eval.grader_not_applicable");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain('"g"');
  });

  it("the other existing types apply to both kinds", async () => {
    const graders = [
      "graders:",
      "  - id: f",
      "    type: field",
      "    checks: [{ path: final_reply, op: not_empty }]",
      "  - id: c",
      "    type: code",
      "    code: \"return { pass: true }\"",
    ].join("\n");
    const findings = await validate(evalYaml({ graders }));
    expect(codes(findings)).not.toContain("eval.grader_not_applicable");
  });
});

describe("validateEval: tools, simulator and conversation findings", () => {
  it("tools: real without consent is an error", async () => {
    const findings = await validate(evalYaml({ conversation: "  tools: real" }));
    expect(find(findings, "eval.real_tools_not_allowed")?.severity).toBe("error");
  });

  it("tools: real with consent warns", async () => {
    const findings = await validate(evalYaml({ conversation: "  tools: real\n  allow_real_tools: true" }));
    const warning = find(findings, "eval.tools_real");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toBe("Real tools can change files and call services from this machine.");
    expect(codes(findings)).not.toContain("eval.real_tools_not_allowed");
  });

  it("read_only lists the tools that will be stubbed (first five)", async () => {
    const findings = await validate(evalYaml({ conversation: "  read_only_tools: [billing.lookup_invoice]" }));
    const warning = find(findings, "eval.tools_unstubbed_list");
    expect(warning?.message).toContain("billing.refund");
    expect(warning?.message).not.toContain("billing.lookup_invoice");
    expect(warning?.message).toContain("stubbed and recorded");
  });

  it("no unstubbed warning when every tool is read-class", async () => {
    const findings = await validate(evalYaml({ conversation: "  read_only_tools: [billing.*]" }));
    expect(codes(findings)).not.toContain("eval.tools_unstubbed_list");
  });

  it("read_only_tools naming a builtin tool is an error and does not make it read-only", async () => {
    const findings = await validate(evalYaml({ conversation: "  read_only_tools: [write, bash, billing.lookup_invoice]" }));
    const finding = find(findings, "eval.read_only_tools_not_mcp");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("write, bash");
    expect(finding?.message).not.toContain("billing");
    const clean = await validate(evalYaml({ conversation: "  read_only_tools: [billing.lookup_invoice]" }));
    expect(codes(clean)).not.toContain("eval.read_only_tools_not_mcp");
  });

  it("names the agent is not granted give eval.tool_not_granted", async () => {
    const graders = [
      "graders:",
      "  - id: calls",
      "    type: tool_calls",
      "    must_call: [crm.lookup]",
      "    must_not_call: [billing.refund]",
    ].join("\n");
    const findings = await validate(evalYaml({ graders, conversation: "  read_only_tools: [crm.*]" }));
    const hits = findings.filter((f) => f.code === "eval.tool_not_granted");
    expect(hits).toHaveLength(2);
    expect(hits.every((f) => f.severity === "warning")).toBe(true);
    expect(hits[0]?.message).toContain("crm.lookup");
    expect(hits[0]?.message).not.toContain("billing.refund");
  });

  it("case tool_mocks keys the agent is not granted warn", async () => {
    const line = JSON.stringify({ id: "m1", input: { script: ["hi"], tool_mocks: { "crm.x": { result: 1 } } } });
    await writeFile(path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"), `${line}\n`);
    const findings = await validate(evalYaml({ conversation: "  tools: mocked" }), { datasetReport: await report() });
    expect(findings.some((f) => f.code === "eval.tool_not_granted" && f.message.includes("crm.x"))).toBe(true);
    expect(codes(findings)).not.toContain("eval.tools_mocked_no_mocks");
  });

  it("tools: mocked with no mocks warns", async () => {
    await writeFile(
      path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"),
      `${JSON.stringify({ id: "m1", input: { script: ["hi"] } })}\n`,
    );
    const findings = await validate(evalYaml({ conversation: "  tools: mocked" }), { datasetReport: await report() });
    expect(find(findings, "eval.tools_mocked_no_mocks")?.severity).toBe("warning");
  });

  it("simulated cases need a user model", async () => {
    const findings = await validate(evalYaml({ conversation: "  mode: simulated" }));
    expect(find(findings, "eval.user_model_missing")?.severity).toBe("error");
  });

  it("a script-only eval never needs a user model", async () => {
    await writeFile(
      path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"),
      `${JSON.stringify({ id: "s1", input: { script: ["hi"] } })}\n`,
    );
    const findings = await validate(evalYaml(), { datasetReport: await report() });
    expect(codes(findings)).not.toContain("eval.user_model_missing");
  });

  it("a per-case simulated mode triggers the user model checks", async () => {
    await writeFile(
      path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"),
      `${JSON.stringify({ id: "s1", input: { mode: "simulated", opening: "o", persona: "p", goal: "g" } })}\n`,
    );
    const findings = await validate(evalYaml(), { datasetReport: await report() });
    expect(codes(findings)).toContain("eval.user_model_missing");
  });

  it("the user model falls back to the judge", async () => {
    const findings = await validate(
      evalYaml({ defaults: "  judge: anthropic/claude-sonnet-4-5", conversation: "  mode: simulated" }),
    );
    expect(codes(findings)).not.toContain("eval.user_model_missing");
  });

  it("a user model on an unsupported provider is an error", async () => {
    const findings = await validate(
      evalYaml({ defaults: "  user_model: groq/llama", conversation: "  mode: simulated" }),
    );
    expect(find(findings, "eval.simulator_unsupported")?.severity).toBe("error");
  });

  it("an unknown user model warns, a user model equal to the agent model warns", async () => {
    const findings = await validate(
      evalYaml({ defaults: "  user_model: anthropic/claude-haiku-4-5", conversation: "  mode: simulated" }),
      { isKnownModel: async () => false },
    );
    expect(find(findings, "eval.simulator_unknown_model")?.severity).toBe("warning");
    expect(find(findings, "eval.simulator_same_as_agent")?.severity).toBe("warning");
  });

  it("goal_reached and rubric count as judge graders", async () => {
    const graders = [
      "graders:",
      "  - id: goal",
      "    type: goal_reached",
      "  - id: tone",
      "    type: rubric",
      "    rubric: Be polite.",
    ].join("\n");
    const findings = await validate(evalYaml({ graders }));
    expect(findings.filter((f) => f.code === "eval.judge_missing").map((f) => f.message)).toEqual([
      expect.stringContaining('"goal"'),
      expect.stringContaining('"tone"'),
    ]);
  });

  it("a judge equal to the agent model warns and an unknown judge warns", async () => {
    const graders = ["graders:", "  - id: goal", "    type: goal_reached", "    judge: anthropic/claude-haiku-4-5"].join("\n");
    const findings = await validate(evalYaml({ graders }), { isKnownModel: async () => false });
    expect(codes(findings)).toEqual(expect.arrayContaining(["eval.judge_same_as_stage", "eval.judge_unknown_model"]));
    expect(find(findings, "eval.judge_same_as_stage")?.message).toContain("agent");
  });

  it("stage-only findings are never emitted for agent targets", async () => {
    const findings = await validate(evalYaml(), { datasetReport: await report() });
    for (const code of ["eval.schema_grader_without_output_schema", "eval.stage_has_gates", "eval.stage_needs_checkout"]) {
      expect(codes(findings)).not.toContain(code);
    }
  });
});

describe("validateEval: scenarios", () => {
  async function withDataset(lines: unknown[]): Promise<DatasetReport> {
    await writeFile(
      path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    return report();
  }

  it("invalid scenarios are listed and skipped", async () => {
    const datasetReport = await withDataset([
      { id: "ok", input: { script: ["hi"] } },
      { id: "bad", input: { mode: "simulated", opening: "o" } },
    ]);
    const findings = await validate(evalYaml(), { datasetReport });
    const mismatch = find(findings, "dataset.input_mismatch");
    expect(mismatch?.severity).toBe("warning");
    expect(mismatch?.message).toContain("bad");
    expect(mismatch?.message).toContain("scenario");
    expect(mismatch?.category).toBe("dataset");
    expect(find(findings, "eval.cases_skipped")?.message).toContain("bad");
    expect(codes(findings)).not.toContain("eval.no_valid_cases");
  });

  it("no valid cases is an error", async () => {
    const datasetReport = await withDataset([{ id: "bad", input: {} }]);
    const findings = await validate(evalYaml(), { datasetReport });
    expect(find(findings, "eval.no_valid_cases")?.severity).toBe("error");
  });

  it("unknown input fields and bad expected types are warnings and the case still runs", async () => {
    const datasetReport = await withDataset([
      { id: "c1", input: { script: ["hi"], persone: "typo" }, expected: { tools: "x" } },
    ]);
    const findings = await validate(evalYaml(), { datasetReport });
    expect(find(findings, "dataset.scenario_unknown_field")?.severity).toBe("warning");
    expect(find(findings, "dataset.expected_invalid")?.severity).toBe("warning");
    expect(codes(findings)).not.toContain("eval.cases_skipped");
    expect(codes(findings)).not.toContain("eval.no_valid_cases");
  });

  it("goal_reached warns for cases without a goal or outcome", async () => {
    const graders = ["graders:", "  - id: goal", "    type: goal_reached", "    judge: anthropic/claude-sonnet-4-5"].join("\n");
    const datasetReport = await withDataset([
      { id: "a", input: { script: ["hi"] } },
      { id: "b", input: { script: ["hi"] }, expected: { outcome: "resolved" } },
    ]);
    const findings = await validate(evalYaml({ graders }), { datasetReport });
    const warning = find(findings, "eval.cases_missing_goal");
    expect(warning?.message).toContain("1 of 2");
    expect(warning?.message).toContain("first: a");
  });

  it("a bare tool_calls grader warns when cases lack expected tools", async () => {
    const graders = "graders:\n  - id: calls\n    type: tool_calls";
    const datasetReport = await withDataset([
      { id: "a", input: { script: ["hi"] } },
      { id: "b", input: { script: ["hi"] }, expected: { tools: ["billing.lookup_invoice"] } },
    ]);
    const findings = await validate(evalYaml({ graders }), { datasetReport });
    expect(find(findings, "eval.cases_missing_expected")?.message).toContain("1 of 2");
  });

  it("the mode comes from the conversation default and a case can override it", async () => {
    const datasetReport = await withDataset([
      { id: "a", input: { mode: "script", script: ["hi"] } },
      { id: "b", input: { opening: "o", persona: "p", goal: "g" } },
    ]);
    const findings = await validate(
      evalYaml({ defaults: "  judge: anthropic/claude-sonnet-4-5", conversation: "  mode: simulated" }),
      { datasetReport },
    );
    expect(codes(findings)).not.toContain("dataset.input_mismatch");
  });

  it("a missing dataset file is reported", async () => {
    await rm(path.join(fx.project, "datasets", "support-scenarios.dataset.jsonl"));
    const findings = await validate(evalYaml());
    expect(codes(findings)).toContain("eval.dataset_unresolved");
  });

  it("run size limits apply to agent evals", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, input: { script: ["hi"] } }));
    const datasetReport = await withDataset(lines);
    const findings = await validate(evalYaml({ defaults: "  repeats: 10" }), { datasetReport });
    expect(find(findings, "eval.large_run")?.severity).toBe("warning");
  });
});
