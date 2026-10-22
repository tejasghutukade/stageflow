import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { EvalGateRegistry } from "../src/agents/evalGate.js";
import { createAgentCaseRunner, type AgentRunnerHost } from "../src/evals/runner/agentCaseRunner.js";
import { createEvalCaseRunner } from "../src/evals/runner/caseRunner.js";
import { FakeAgentBackend, type FakeTurnScript } from "../src/evals/runner/FakeAgentBackend.js";
import { FakeSimulatorModel } from "../src/evals/runner/simulatorModel.js";
import type { EvalPlan, PlanCase, RunCaseResult } from "../src/evals/types.js";
import { agentInput, agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const fixtures: AgentsFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.01 };

async function setup(backend: FakeAgentBackend, agents: Record<string, Record<string, unknown>> = { support: {} }) {
  const fx = await agentsFixture();
  fixtures.push(fx);
  for (const [id, overrides] of Object.entries(agents)) {
    await fx.service.create(fx.project, agentInput(id, overrides), { source: "console" });
  }
  const evalGates = new EvalGateRegistry();
  const chat = new AgentChatController({ service: fx.service, backend, evalGates });
  const host: AgentRunnerHost = { service: fx.service, chat, evalGates, backend };
  const detail = await fx.service.get(fx.project, "support");
  return { fx, host, chat, evalGates, detail };
}

function planFor(
  fx: AgentsFixture,
  detail: Awaited<ReturnType<AgentsFixture["service"]["get"]>>,
  cases: PlanCase[],
  over: Partial<EvalPlan> & { maxTurns?: number; turnTimeoutMs?: number; tools?: "real" | "read_only" | "mocked"; mode?: "script" | "simulated" } = {},
): EvalPlan {
  const { maxTurns = 8, turnTimeoutMs = 120_000, tools = "read_only", mode = "script", ...rest } = over;
  return {
    evalRunId: "er_1",
    projectRoot: fx.project,
    evalId: "e",
    target: { kind: "agent", agentId: "support", revision: detail.agent.revision },
    targetVersionHash: "h",
    stageModel: "m",
    task: {},
    cases,
    graders: [],
    repeats: 1,
    passThreshold: 0.8,
    concurrency: 1,
    maxCostUsd: 10,
    agent: { definitionHash: "h", definition: detail.definition as unknown as Record<string, unknown> },
    conversation: { mode, maxTurns, turnTimeoutMs, tools, approvals: "record_only", readOnlyTools: [], allowRealTools: false },
    userModel: mode === "simulated" ? "fake/sim" : null,
    ...rest,
  };
}

const scriptCase = (script: string[], extra: Record<string, unknown> = {}): PlanCase => ({
  id: "c1",
  position: 0,
  input: { script, ...extra },
  tags: [],
});
const req = { evalRunId: "er_1", caseId: "c1", repeatIndex: 0 };

function ok(result: RunCaseResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result;
}

describe("agentCaseRunner", () => {
  it("runs a scripted case: messages, tool calls, usage, hidden eval session", async () => {
    const backend = new FakeAgentBackend([
      { text: "hello", usage },
      { text: "looked up", usage, tools: [{ tool: "read", input: { path: "a" } }, { tool: "write", input: { path: "b" } }] },
      { text: "done", usage },
    ]);
    const { fx, host } = await setup(backend, { support: { tools: { builtin: ["read", "write"] } } });
    const detail = await fx.service.get(fx.project, "support");
    const runner = createAgentCaseRunner({ host: () => host });
    const result = ok(await runner.runCase(planFor(fx, detail, [scriptCase(["a", "b", "c"])]), req));
    expect(result.subjectRef).toMatch(/^ses_/);
    expect(result.output.kind).toBe("conversation");
    if (result.output.kind !== "conversation") return;
    expect(result.output.messages).toHaveLength(6);
    expect(result.output.stop_reason).toBe("script_end");
    expect(result.output.turns).toBe(3);
    expect(result.output.tool_calls.map((c) => [c.name, c.policy_outcome])).toEqual([
      ["read", "ran"],
      ["write", "stubbed"],
    ]);
    expect(result.output.tool_calls[0]!.turn).toBe(2);
    expect(backend.executed).toEqual(["read"]);
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(result.tokensIn).toBe(300);
    expect(result.tokensOut).toBe(60);
    const session = (await fx.service.getSession(fx.project, result.subjectRef!)).session;
    expect(session.source).toBe("eval");
    expect((await fx.service.listAllSessions(fx.project, { limit: 50 })).sessions.length).toBe(0);
    expect(runner.spend("er_1")).toBeCloseTo(0.03);
    expect(backend.released).toContain(result.subjectRef);
    expect(host.evalGates.get(result.subjectRef!)).toBeUndefined();
  });

  it("stops at max_turns as a completed case", async () => {
    const { fx, host, detail } = await setup(new FakeAgentBackend());
    const runner = createAgentCaseRunner({ host: () => host });
    const result = ok(await runner.runCase(planFor(fx, detail, [scriptCase(["1", "2", "3", "4"])], { maxTurns: 2 }), req));
    if (result.output.kind !== "conversation") throw new Error();
    expect(result.output.stop_reason).toBe("max_turns");
    expect(result.output.turns).toBe(2);
  });

  it("plays a simulated user, sums simulator usage, and honors the resolved marker", async () => {
    const simulator = new FakeSimulatorModel(["second message", "thanks\n[[END:resolved]]"], {
      costUsd: 0.002,
      tokensIn: 10,
      tokensOut: 5,
      model: "fake/sim",
    });
    const { fx, host, detail } = await setup(new FakeAgentBackend());
    const runner = createAgentCaseRunner({ host: () => host, simulatorModel: () => simulator });
    const c: PlanCase = { id: "c1", position: 0, input: { opening: "hi", persona: "p", goal: "g" }, tags: [] };
    const result = ok(await runner.runCase(planFor(fx, detail, [c], { mode: "simulated" }), req));
    if (result.output.kind !== "conversation") throw new Error();
    expect(result.output.stop_reason).toBe("resolved");
    expect(result.output.turns).toBe(3);
    expect(result.output.usage.simulator_calls).toBe(2);
    expect(result.output.usage.simulator_cost_usd).toBeCloseTo(0.004);
    expect(result.costUsd).toBeCloseTo(0.03 + 0.004);
    expect(result.tokensIn).toBe(300);
  });

  it("maps a simulator failure and abandonment", async () => {
    const { fx, host, detail } = await setup(new FakeAgentBackend());
    const c: PlanCase = { id: "c1", position: 0, input: { opening: "hi", persona: "p", goal: "g" }, tags: [] };
    const failing = createAgentCaseRunner({ host: () => host, simulatorModel: () => new FakeSimulatorModel([new Error("boom")]) });
    const failed = await failing.runCase(planFor(fx, detail, [c], { mode: "simulated" }), req);
    expect(failed).toMatchObject({ ok: false, code: "EVAL_SIMULATOR_ERROR" });
    if (!failed.ok) expect(failed.output?.stop_reason).toBe("error");

    const abandoning = createAgentCaseRunner({ host: () => host, simulatorModel: () => new FakeSimulatorModel(["ok bye\n[[END:abandoned]]"]) });
    const done = ok(await abandoning.runCase(planFor(fx, detail, [c], { mode: "simulated" }), { ...req, evalRunId: "er_2" }));
    if (done.output.kind !== "conversation") throw new Error();
    expect(done.output.stop_reason).toBe("abandoned");
  });

  it("stops no_progress and empty_message", async () => {
    const { fx, host, detail } = await setup(new FakeAgentBackend());
    const c: PlanCase = { id: "c1", position: 0, input: { opening: "hi", persona: "p", goal: "g" }, tags: [] };
    const same = createAgentCaseRunner({ host: () => host, simulatorModel: () => new FakeSimulatorModel(["hi"]) });
    const a = ok(await same.runCase(planFor(fx, detail, [c], { mode: "simulated" }), req));
    const blank = createAgentCaseRunner({ host: () => host, simulatorModel: () => new FakeSimulatorModel(["   "]) });
    const b = ok(await blank.runCase(planFor(fx, detail, [c], { mode: "simulated" }), { ...req, evalRunId: "er_2" }));
    if (a.output.kind !== "conversation" || b.output.kind !== "conversation") throw new Error();
    expect([a.output.stop_reason, b.output.stop_reason]).toEqual(["no_progress", "empty_message"]);
  });

  it("times out a turn and keeps the partial transcript", async () => {
    const backend = new FakeAgentBackend([{ text: "fine", usage }, { hang: true }]);
    const { fx, host, detail } = await setup(backend);
    const runner = createAgentCaseRunner({ host: () => host });
    const result = await runner.runCase(planFor(fx, detail, [scriptCase(["a", "b"])], { turnTimeoutMs: 50 }), req);
    expect(result).toMatchObject({ ok: false, code: "EVAL_AGENT_TIMEOUT" });
    if (result.ok) return;
    expect(result.output?.stop_reason).toBe("timeout");
    expect(result.output?.status).toBe("failure");
    expect(result.subjectRef).toBeDefined();
    expect(backend.released).toContain(result.subjectRef);
  });

  it("maps a backend failure to EVAL_AGENT_FAILED", async () => {
    const backend = new FakeAgentBackend([{ error: new Error("provider body secret") }]);
    const { fx, host, detail } = await setup(backend);
    const result = await createAgentCaseRunner({ host: () => host }).runCase(planFor(fx, detail, [scriptCase(["a"])]), req);
    expect(result).toMatchObject({ ok: false, code: "EVAL_AGENT_FAILED", message: "agent.backend_failed" });
    if (!result.ok) expect(result.output?.turns).toBe(1);
  });

  it("refuses to start a case over budget without opening a session", async () => {
    const { fx, host, detail } = await setup(new FakeAgentBackend());
    const runner = createAgentCaseRunner({ host: () => host });
    runner.addSpend("er_1", 5);
    const result = await runner.runCase(planFor(fx, detail, [scriptCase(["a"])], { maxCostUsd: 5 }), req);
    expect(result).toMatchObject({ ok: false, code: "EVAL_BUDGET_EXCEEDED" });
    expect(fx.store.listEvalRootSessions()).toEqual([]);
  });

  it("cancelAll stops an in-flight turn and sessions end terminal", async () => {
    const backend = new FakeAgentBackend([{ hang: true }]);
    const { fx, host, detail } = await setup(backend);
    const runner = createAgentCaseRunner({ host: () => host });
    const running = runner.runCase(planFor(fx, detail, [scriptCase(["a", "b"])]), req);
    await new Promise((r) => setTimeout(r, 100));
    await runner.cancelAll("er_1");
    const result = await running;
    expect(result).toMatchObject({ ok: false, code: "EVAL_CANCELLED" });
    if (!result.ok) {
      const d = await fx.service.getSession(fx.project, result.subjectRef!);
      expect(d.turns.every((t) => t.status !== "running")).toBe(true);
    }
    expect(await runner.runCase(planFor(fx, detail, [scriptCase(["a"])]), req)).toMatchObject({ code: "EVAL_CANCELLED" });
  });

  it("runs the pinned revision even if the agent is saved mid-run", async () => {
    const seen: string[] = [];
    const backend = new FakeAgentBackend((input): FakeTurnScript => {
      seen.push(input.definition.instructions);
      return { text: "r", usage };
    });
    const { fx, host, detail } = await setup(backend);
    const plan = planFor(fx, detail, [scriptCase(["a"])]);
    await fx.service.save(fx.project, "support", { baseRevision: detail.agent.revision, definition: { ...detail.definition!, instructions: "changed" } }, { source: "console" });
    ok(await createAgentCaseRunner({ host: () => host }).runCase(plan, req));
    expect(seen).toEqual(["Be helpful."]);
  });

  it("applies mocks and records them", async () => {
    const backend = new FakeAgentBackend([{ tools: [{ tool: "write", input: { path: "x" } }], usage }]);
    const { fx, host, detail } = await setup(backend, { support: { tools: { builtin: ["write"] } } });
    const detail2 = await fx.service.get(fx.project, "support");
    const plan = planFor(fx, detail2, [scriptCase(["a"], { tool_mocks: { write: { result: "mocked!" } } })], { tools: "mocked" });
    const result = ok(await createAgentCaseRunner({ host: () => host }).runCase(plan, req));
    if (result.output.kind !== "conversation") throw new Error();
    expect(result.output.tool_calls[0]).toMatchObject({ policy_outcome: "mocked", status: "ok", result_summary: "mocked!" });
    expect(backend.executed).toEqual([]);
    void detail;
  });

  it("sums sub-agent cost and releases children", async () => {
    const backend = new FakeAgentBackend((input, index): FakeTurnScript => {
      if (input.definition.id === "helper") return { text: "helped", usage };
      return { text: "main", usage, tools: index === 0 ? [{ tool: "agent:helper", input: { message: "do" } }] : [] };
    });
    const { fx, host } = await setup(backend, { support: { sub_agents: ["helper"] }, helper: {} });
    const detail = await fx.service.get(fx.project, "support");
    const plan = planFor(fx, detail, [scriptCase(["a"])], { tools: "real" });
    const result = ok(await createAgentCaseRunner({ host: () => host }).runCase(plan, req));
    if (result.output.kind !== "conversation") throw new Error();
    expect(result.costUsd).toBeCloseTo(0.02);
    expect(result.output.tool_calls[0]!.session_id).toMatch(/^ses_/);
    expect(backend.released.length).toBe(2);
  });

  it("answers ENGINE_ERROR when the host cannot run agents", async () => {
    const { fx, detail } = await setup(new FakeAgentBackend());
    const result = await createAgentCaseRunner({ host: () => undefined }).runCase(planFor(fx, detail, [scriptCase(["a"])]), req);
    expect(result).toMatchObject({ ok: false, code: "EVAL_ENGINE_ERROR" });
  });
});

describe("createEvalCaseRunner", () => {
  it("routes by target kind and fans out spend and cancel", async () => {
    const calls: string[] = [];
    const mk = (name: string) => ({
      runCase: async () => {
        calls.push(name);
        return { ok: false, code: "EVAL_ENGINE_ERROR", message: name } as RunCaseResult;
      },
      cancelAll: async () => void calls.push(`cancel-${name}`),
      spend: () => (name === "agent" ? 2 : 1),
      addSpend: () => void calls.push(`spend-${name}`),
    });
    const runner = createEvalCaseRunner({ stage: mk("stage"), agent: mk("agent") });
    const base = { target: { kind: "agent", agentId: "a" } } as unknown as EvalPlan;
    await runner.runCase(base, { evalRunId: "r1", caseId: "c", repeatIndex: 0 });
    await runner.runCase({ target: { kind: "stage" } } as unknown as EvalPlan, { evalRunId: "r2", caseId: "c", repeatIndex: 0 });
    runner.addSpend("r1", 1);
    runner.addSpend("r2", 1);
    await runner.cancelAll("r1");
    expect(calls).toEqual(["agent", "stage", "spend-agent", "spend-stage", "cancel-stage", "cancel-agent"]);
    expect(runner.spend("r1")).toBe(3);
  });
});
