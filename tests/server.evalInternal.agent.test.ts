import { cp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentChatController } from "../src/agents/chatTurn.js";
import { EvalGateRegistry } from "../src/agents/evalGate.js";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import { buildEvalPlan } from "../src/evals/plan.js";
import { createAgentCaseRunner } from "../src/evals/runner/agentCaseRunner.js";
import { createEvalCaseRunner } from "../src/evals/runner/caseRunner.js";
import { FakeAgentBackend } from "../src/evals/runner/FakeAgentBackend.js";
import type { StageCaseRunner } from "../src/evals/runner/stageCaseRunner.js";
import { json } from "../src/server/createHttpHost.js";
import { handleEvalInternalRoutes, EVAL_INTERNAL_RUN_CASE_PATH } from "../src/server/evalInternalRoutes.js";
import { agentsFixture, type AgentsFixture } from "./helpers/agentsHarness.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/evals/agent/project");
const fixtures: AgentsFixture[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

describe("POST /api/evals/internal/run-case with an agent plan", () => {
  it("returns the agent RunCaseResult: conversation output, session ref, usage", async () => {
    const fx = await agentsFixture();
    fixtures.push(fx);
    await cp(SRC, fx.project, { recursive: true, force: true });
    const built = await buildEvalPlan({
      projectRoot: fx.project,
      evalPath: "evals/support-basics.eval.yaml",
      evalRunId: "run-1",
      engine: { name: "fake", version: "1", nodeVersion: "22" },
      agents: fx.service,
      overrides: { case_ids: ["s002"] },
    });
    if (!built.ok) throw new Error(JSON.stringify(built.findings.filter((f) => f.severity === "error")));

    const backend = new FakeAgentBackend([
      { text: "Looking.", tools: [{ tool: "read", input: { path: "a" } }] },
      { text: "Almost." },
      { text: "It ships Tuesday." },
    ]);
    const evalGates = new EvalGateRegistry();
    const chat = new AgentChatController({ service: fx.service, backend, evalGates });
    const stage: StageCaseRunner = {
      async runCase() {
        return { ok: false, code: "EVAL_STAGE_FAILED", message: "not a stage plan" };
      },
      async cancelAll() {},
      spend: () => 0,
      addSpend: () => undefined,
    };
    const runner = createEvalCaseRunner({
      stage,
      agent: createAgentCaseRunner({ host: () => ({ service: fx.service, chat, evalGates, backend }) }),
    });
    const tokens = new RunTokenRegistry();
    const token = tokens.issue("run-1", { plan: built.plan });

    const server = createServer(async (req, res) => {
      const handled = await handleEvalInternalRoutes(req, req.method ?? "GET", req.url ?? "/", {
        tokens,
        runner,
        isRunning: (id) => id === "run-1",
      }, res, json);
      if (!handled) json(res, 404, { error: "Not found" });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${origin}${EVAL_INTERNAL_RUN_CASE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ eval_run_id: "run-1", case_id: "s002", repeat_index: 0 }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.subjectRef ?? body.subject_ref).toMatch(/^ses_/);
    expect(body.output.kind).toBe("conversation");
    expect(body.output.final_reply).toBe("It ships Tuesday.");
    expect(body.output.tool_calls.map((c: any) => [c.name, c.policy_outcome])).toEqual([["read", "ran"]]);
    expect(body.costUsd).toBeGreaterThan(0);
    expect(text).not.toContain(token);

    const unknown = await fetch(`${origin}${EVAL_INTERNAL_RUN_CASE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ eval_run_id: "run-1", case_id: "nope", repeat_index: 0 }),
    });
    const failure = await unknown.json();
    expect(failure.ok).toBe(false);
    expect(typeof failure.code).toBe("string");
    expect(JSON.stringify(failure)).not.toContain(token);
  });
});
