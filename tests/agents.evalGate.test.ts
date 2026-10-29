import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { createEvalGate, EvalGateRegistry, type EvalGate, type EvalGatePolicy } from "../src/agents/evalGate.js";
import { classifyTool, toolRiskSummary } from "../src/agents/toolRisk.js";
import { agentInput, agentsFixture, scriptedBackend, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const policyOf = (overrides: Partial<EvalGatePolicy> = {}): EvalGatePolicy => ({ tools: "read_only", approvals: "record_only", readOnlyTools: [], mocks: {}, ...overrides });

async function setup() {
  const fixture = await agentsFixture();
  fixtures.push(fixture);
  const { service, project } = fixture;
  await service.create(project, agentInput("helper"), { source: "console" });
  await service.setEnabled(project, "helper", true, { source: "console" });
  await service.create(
    project,
    agentInput("support", {
      tools: {
        builtin: ["read", "write", "shell"],
        mcp: { billing: ["lookup_invoice", "refund"], docs: ["search"] },
        stageflow: { groups: [], tools: ["get_agent", "archive_agent", "fire_trigger", "probe_project_mcp", "run_eval", "agent_chat"] },
      },
      sub_agents: ["helper"],
      approvals: { ask_first: ["billing.refund", "docs.search"] },
    }),
    { source: "console" },
  );
  await service.setEnabled(project, "support", true, { source: "console" });
  const definition = (await service.get(project, "support")).definition!;
  return { ...fixture, definition };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Runs one eval session whose backend makes the scripted tool calls; returns the spy of tool bodies that really ran. */
async function converse(fx: Setup, policy: EvalGatePolicy, calls: Array<[string, Record<string, unknown>?]>, options: { source?: string; register?: boolean } = {}) {
  const evalGates = new EvalGateRegistry();
  const gate = createEvalGate({ policy, definition: fx.definition, projectRoot: fx.project, stageflowHome: fx.home });
  const bodies: string[] = [];
  const outputs: Array<{ ran: boolean; output: string }> = [];
  const backend = scriptedBackend(async (_messages, ctx) => {
    for (const [tool, input] of calls) outputs.push(await ctx.tool(tool, input ?? {}, () => (bodies.push(tool), `ran ${tool}`)));
    return "done";
  });
  const chat = new AgentChatController({ service: fx.service, backend, evalGates });
  const session = await fx.service.openSession(fx.project, "support", { source: options.source ?? "eval", ...((options.source ?? "eval") === "eval" ? { eval: {} } : {}) });
  if (options.register !== false) evalGates.set(session.id, gate);
  const statuses: string[] = [];
  const watcher = setInterval(() => void fx.service.getSession(fx.project, session.id).then((d) => statuses.push(d.session.status)), 1);
  const detail = await chat.send({ projectRoot: fx.project, agentId: "support", sessionId: session.id, text: "go", source: options.source ?? "eval" });
  clearInterval(watcher);
  const approvalRows = fx.connection.prepare("SELECT COUNT(*) AS n FROM agent_approvals").get() as { n: number };
  return { gate, bodies, outputs, detail, statuses, approvalRows: approvalRows.n, pending: await fx.service.pendingApprovals(fx.project, { includeEval: true }), session };
}

const outcomes = (gate: EvalGate) => Object.fromEntries(gate.records().map((r) => [r.name, r.policyOutcome]));

describe("tool classification", () => {
  const definition = { tools: { builtin: [], mcp: {}, stageflow: { groups: [], tools: [] } }, sub_agents: [] } as never;
  it("classifies each tool class", () => {
    expect(classifyTool(definition, "read")).toEqual({ class: "read", readOnly: true });
    expect(classifyTool(definition, "write")).toEqual({ class: "write", readOnly: false });
    expect(classifyTool(definition, "bash")).toEqual({ class: "shell", readOnly: false });
    expect(classifyTool(definition, "stageflow.get_agent")).toEqual({ class: "read", readOnly: true });
    expect(classifyTool(definition, "stageflow.create_agent")).toMatchObject({ class: "write", readOnly: false });
    expect(classifyTool(definition, "stageflow.archive_agent")).toEqual({ class: "destructive", readOnly: false });
    expect(classifyTool(definition, "stageflow.fire_trigger")).toEqual({ class: "external", readOnly: false });
    expect(classifyTool(definition, "stageflow.get_started")).toEqual({ class: "operator_only", readOnly: false });
    expect(classifyTool(definition, "billing.lookup_invoice")).toEqual({ class: "mcp_unknown", readOnly: false });
    expect(classifyTool(definition, "agent:helper")).toEqual({ class: "sub_agent", readOnly: false });
    expect(classifyTool(definition, "browser")).toEqual({ class: "browser", readOnly: false });
  });

  it("treats an author-listed tool or server wildcard as read-only, but never a sub-agent or operator-only tool", () => {
    expect(classifyTool(definition, "billing.lookup_invoice", ["billing.lookup_invoice"])).toEqual({ class: "read", readOnly: true });
    expect(classifyTool(definition, "billing.refund", ["billing.*"])).toEqual({ class: "read", readOnly: true });
    expect(classifyTool(definition, "agent:helper", ["agent:helper"]).readOnly).toBe(false);
    expect(classifyTool(definition, "stageflow.get_started", ["stageflow.get_started"]).readOnly).toBe(false);
  });

  it("summarizes the granted tools for the picker", async () => {
    const fx = await setup();
    const summary = toolRiskSummary(fx.definition, ["docs.search"]);
    expect(summary.find((e) => e.tool === "docs.search")).toEqual({ tool: "docs.search", class: "read", readOnly: true });
    expect(summary.find((e) => e.tool === "agent:helper")?.class).toBe("sub_agent");
    expect(summary.find((e) => e.tool === "bash")?.class).toBe("shell");
  });
});

describe("eval gate: read_only", () => {
  it("runs read tools; stubs and records everything else without running its body", async () => {
    const fx = await setup();
    const calls: Array<[string]> = [["read"], ["write"], ["edit"], ["stageflow.get_agent"], ["stageflow.archive_agent"], ["billing.lookup_invoice"], ["billing.refund"], ["bash"]];
    const run = await converse(fx, policyOf(), calls);
    expect(run.bodies).toEqual(["read", "stageflow.get_agent"]);
    expect(outcomes(run.gate)).toEqual({
      read: "ran",
      write: "stubbed",
      edit: "stubbed",
      "stageflow.get_agent": "ran",
      "stageflow.archive_agent": "stubbed",
      "billing.lookup_invoice": "stubbed",
      "billing.refund": "would_ask_first",
      bash: "would_ask_first",
    });
    const write = run.gate.records().find((r) => r.name === "write")!;
    expect(write).toMatchObject({ status: "not_run", result: "write was not executed in this evaluation." });
    expect(run.outputs[1]).toEqual({ ran: false, output: "write was not executed in this evaluation." });
    expect(run.gate.records().find((r) => r.name === "read")).toMatchObject({ status: "ok", result: "ran read" });
  });

  it("runs an MCP tool the eval lists as read-only", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ readOnlyTools: ["billing.lookup_invoice"] }), [["billing.lookup_invoice", { id: "inv_1" }]]);
    expect(run.bodies).toEqual(["billing.lookup_invoice"]);
    expect(run.gate.records()[0]).toMatchObject({ policyOutcome: "ran", args: { id: "inv_1" }, status: "ok" });
  });

  it("answers with a case mock for a non-read tool, recording it mocked", async () => {
    const fx = await setup();
    const policy = policyOf({ mocks: { "billing.lookup_invoice": { result: { total: 42 } }, write: { error: "disk full" } } });
    const run = await converse(fx, policy, [["billing.lookup_invoice"], ["write"]]);
    expect(run.bodies).toEqual([]);
    expect(run.outputs[0]).toEqual({ ran: false, output: '{"total":42}' });
    expect(run.outputs[1]).toEqual({ ran: false, output: "disk full" });
    expect(run.gate.records()).toMatchObject([
      { policyOutcome: "mocked", status: "ok", result: '{"total":42}' },
      { policyOutcome: "mocked", status: "error", result: "disk full" },
    ]);
  });
});

describe("eval gate: declared read-only cannot upgrade builtin or Stageflow tools", () => {
  it("classifies declared write, shell, destructive and external tools as not read-only", () => {
    const definition = { tools: { builtin: [], mcp: {}, stageflow: { groups: [], tools: [] } }, sub_agents: [] } as never;
    for (const tool of ["write", "edit", "bash", "browser", "stageflow.archive_agent", "stageflow.fire_trigger", "stageflow.create_agent"]) {
      expect(classifyTool(definition, tool, [tool]).readOnly).toBe(false);
    }
  });

  it("stubs write and bash under read_only and auto_approve_read even when declared", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ approvals: "auto_approve_read", readOnlyTools: ["write", "bash", "stageflow.archive_agent"] }), [["write"], ["bash"], ["stageflow.archive_agent"]]);
    expect(run.bodies).toEqual([]);
    expect(outcomes(run.gate)).toMatchObject({ write: "stubbed", bash: expect.stringMatching(/stubbed|would_ask_first/), "stageflow.archive_agent": "stubbed" });
  });

  it("blocks sort_eval_failures, calibrate_eval_grader and cancel_eval_run even under real", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ tools: "real" }), [["stageflow.sort_eval_failures"], ["stageflow.calibrate_eval_grader"], ["stageflow.cancel_eval_run"]]);
    expect(run.bodies).toEqual([]);
    expect(run.gate.records().every((r) => r.policyOutcome === "denied")).toBe(true);
  });
});

describe("eval gate: mocked and real", () => {
  it("mocked: mock wins even for read tools; unmocked read tools run; others are stubbed", async () => {
    const fx = await setup();
    const policy = policyOf({ tools: "mocked", mocks: { read: { result: "canned" } } });
    const run = await converse(fx, policy, [["read"], ["stageflow.get_agent"], ["write"]]);
    expect(run.bodies).toEqual(["stageflow.get_agent"]);
    expect(outcomes(run.gate)).toEqual({ read: "mocked", "stageflow.get_agent": "ran", write: "stubbed" });
  });

  it("real: runs every granted tool, still denies a non-granted tool and a forbidden write path", async () => {
    const fx = await setup();
    const policy = policyOf({ tools: "real" });
    const run = await converse(fx, policy, [["write", { path: "notes.txt" }], ["billing.lookup_invoice"], ["docs.nope"], ["write", { path: `${fx.project}/agents/support.agent.yaml` }]]);
    expect(run.bodies).toEqual(["write", "billing.lookup_invoice"]);
    expect(run.gate.records().map((r) => r.policyOutcome)).toEqual(["ran", "ran", "denied", "denied"]);
    expect(run.gate.warning).toMatch(/run for real/);
    expect(createEvalGate({ policy: policyOf(), definition: fx.definition }).warning).toBeUndefined();
  });

  it("real: ask-first tools still follow the approval policy", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ tools: "real", approvals: "auto_approve_read", readOnlyTools: ["docs.search"] }), [["docs.search"], ["billing.refund"], ["bash"]]);
    expect(run.bodies).toEqual(["docs.search"]);
    expect(run.gate.records().map((r) => r.policyOutcome)).toEqual(["ran", "would_ask_first", "would_ask_first"]);
  });

  it("blocks run_eval, agent_chat and fire_trigger in every mode; probe_project_mcp and sub-agents only outside real", async () => {
    const fx = await setup();
    const calls: Array<[string]> = [["stageflow.run_eval"], ["stageflow.agent_chat"], ["stageflow.fire_trigger"], ["stageflow.probe_project_mcp"], ["agent:helper"]];
    for (const tools of ["read_only", "mocked"] as const) {
      const run = await converse(fx, policyOf({ tools }), calls);
      expect(run.gate.records().map((r) => r.policyOutcome)).toEqual(["denied", "denied", "denied", "denied", "denied"]);
    }
    const real = await converse(fx, policyOf({ tools: "real" }), calls);
    expect(real.gate.records().map((r) => r.policyOutcome)).toEqual(["denied", "denied", "denied", "ran", "ran"]);
  });

  it("denies an operator-only Stageflow tool in every mode", async () => {
    const fx = await setup();
    for (const tools of ["real", "read_only", "mocked"] as const) {
      const gate = createEvalGate({ policy: policyOf({ tools }), definition: fx.definition });
      expect(gate.decide({ id: "c1", tool: "stageflow.get_started", input: {} })).toMatchObject({ allow: false });
      expect(gate.records()[0]!.policyOutcome).toBe("denied");
    }
  });
});

describe("eval gate: approvals", () => {
  it.each([
    ["record_only", "would_ask_first"],
    ["deny", "denied"],
    ["auto_approve_read", "would_ask_first"],
  ] as const)("bash under %s is %s, creates no approval row and never waits", async (approvals, outcome) => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ approvals, tools: "real" }), [["bash", { command: "ls" }]]);
    expect(run.gate.records()[0]).toMatchObject({ policyOutcome: outcome, status: "not_run", result: "Approval for bash was not granted in this evaluation. Continue without it." });
    expect(run.outputs[0]).toEqual({ ran: false, output: "Approval for bash was not granted in this evaluation. Continue without it." });
    expect(run.bodies).toEqual([]);
    expect(run.approvalRows).toBe(0);
    expect(run.pending).toEqual([]);
    expect(run.statuses).not.toContain("waiting");
    expect(run.detail.turns[0]!.status).toBe("succeeded");
  });

  it("auto_approve_read lets a read-class ask-first call continue to the tool policy; deny does not", async () => {
    const fx = await setup();
    const auto = await converse(fx, policyOf({ approvals: "auto_approve_read", readOnlyTools: ["docs.search"] }), [["docs.search"], ["billing.refund"]]);
    expect(auto.gate.records().map((r) => r.policyOutcome)).toEqual(["ran", "would_ask_first"]);
    expect(auto.approvalRows).toBe(0);
    const deny = await converse(fx, policyOf({ approvals: "deny", readOnlyTools: ["docs.search"] }), [["docs.search"]]);
    expect(deny.gate.records()[0]!.policyOutcome).toBe("denied");
  });

  it("records the would-ask-first approval span", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf(), [["bash"]]);
    const spans = (await fx.service.getSession(fx.project, run.session.id)).turns[0]!.id;
    const rows = fx.connection.prepare("SELECT name, kind, attributes_json AS attributes FROM agent_spans WHERE turn_id = ?").all(spans) as Array<{ name: string; kind: string; attributes: string }>;
    const span = rows.find((r) => r.name === "approval bash");
    expect(span?.kind).toBe("gate");
    expect(JSON.parse(span!.attributes)).toMatchObject({ "stageflow.approval.outcome": "would_ask_first" });
  });
});

describe("eval gate: registry wiring", () => {
  it("fails closed for an eval session with no registered gate", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf({ tools: "real" }), [["read"]], { register: false });
    expect(run.bodies).toEqual([]);
    expect(run.outputs[0]!.output).toMatch(/No eval policy/);
  });

  it("does not touch a real session even if a gate is registered for its id", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf(), [["read"], ["write"]], { source: "console" });
    expect(run.bodies).toEqual(["read", "write"]);
    expect(run.gate.records()).toEqual([]);
  });
});

describe("eval sessions are read only for operators", () => {
  it("refuses a console or mcp chat turn on an eval session", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf(), [["read"]]);
    const chat = new AgentChatController({ service: fx.service, backend: scriptedBackend(), evalGates: new EvalGateRegistry() });
    for (const source of ["console", "mcp"]) {
      await expect(chat.send({ projectRoot: fx.project, agentId: "support", sessionId: run.session.id, text: "hi", source })).rejects.toMatchObject({ code: "agent.session_eval_readonly" });
    }
  });

  it("refuses an approval decision on an eval session", async () => {
    const fx = await setup();
    const run = await converse(fx, policyOf(), [["read"]]);
    await expect(fx.service.decideApproval(fx.project, run.session.id, "approve", { kind: "operator" })).rejects.toMatchObject({ code: "agent.session_eval_readonly" });
  });
});
