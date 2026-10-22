import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PromptfooEngine } from "../src/evals/engine/promptfoo/PromptfooEngine.js";
import { RunTokenRegistry } from "../src/evals/engine/promptfoo/runTokens.js";
import { json } from "../src/server/createHttpHost.js";
import { EVAL_INTERNAL_RUN_CASE_PATH, handleEvalInternalRoutes } from "../src/server/evalInternalRoutes.js";
import type { ConversationOutput, RunCaseResult } from "../src/evals/types.js";
import { recordingIo, samplePlan } from "./evals/promptfooHelpers.js";

/**
 * Opt-in (STAGEFLOW_EVALS_SMOKE=1), needs the pinned promptfoo installed (`sf eval engine install`).
 * An agent plan of 3 cases x 2 repeats with a tool_calls, a conversation_check and a rubric grader runs through the
 * real engine against the local stub judge. The runner is fake: no agent, no model, no network.
 */
const enabled = process.env.STAGEFLOW_EVALS_SMOKE === "1";
const MARKER = "TRANSCRIPT-MARKER-7f3a";
const PRICE = { inputPerMillion: 1000, outputPerMillion: 2000 };

function conversation(caseId: string): ConversationOutput {
  const calledLookup = caseId !== "c2";
  return {
    kind: "conversation",
    status: "success",
    summary: "1 turn",
    messages: [
      { role: "user", text: "Where is my invoice?", turn: 1 },
      { role: "assistant", text: "good answer about your invoice", turn: 1 },
    ],
    tool_calls: calledLookup
      ? [{ id: "call_1", turn: 1, name: "billing.lookup_invoice", args: { invoice_id: "INV-1" }, result_summary: "{}", status: "ok", policy_outcome: "ran" }]
      : [],
    final_reply: "good answer about your invoice",
    turns: 1,
    stop_reason: "script_end",
    usage: {
      cost_usd: 0.01,
      agent_cost_usd: 0.01,
      simulator_cost_usd: 0,
      tokens_in: 100,
      tokens_out: 20,
      simulator_tokens_in: 0,
      simulator_tokens_out: 0,
      simulator_estimated: false,
      agent_calls: 1,
      simulator_calls: 0,
    },
    transcript: `[turn 1] USER: Where is my invoice?\n[turn 1] AGENT: good answer about your invoice ${MARKER}`,
  };
}

describe.skipIf(!enabled)("PromptfooEngine against the real engine: agent plan", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function run() {
    const stubPort = 20000 + Math.floor(Math.random() * 20000);
    const work = mkdtempSync(path.join(tmpdir(), "sf-smoke-agent-"));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const log = path.join(work, "stub.jsonl");
    const stub: ChildProcess = spawn(process.execPath, [path.resolve("tests/fixtures/evals/stubJudgeServer.mjs")], {
      env: { ...process.env, STUB_PORT: String(stubPort), STUB_LOG: log },
      stdio: "ignore",
    });
    cleanups.push(() => void stub.kill());
    await new Promise((resolve) => setTimeout(resolve, 500));

    const home = process.env.STAGEFLOW_HOME ?? path.join(process.env.HOME ?? "", ".stageflow");
    const tokens = new RunTokenRegistry();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handleEvalInternalRoutes(
        req,
        req.method ?? "GET",
        url.pathname,
        { tokens, runner: { runCase: async () => Promise.reject(new Error("unused")) }, isRunning: () => true },
        res,
        json,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const callbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${EVAL_INTERNAL_RUN_CASE_PATH}`;

    const engine = new PromptfooEngine({
      tokens,
      callbackUrl,
      home,
      resolveJudgeKey: () => "stub-key",
      loadJudgePrices: async () => new Map([["openai/stub-judge", PRICE]]),
      judgeProviderConfig: { apiBaseUrl: `http://127.0.0.1:${stubPort}/v1` },
    });
    const plan = samplePlan({
      target: { kind: "agent", agentId: "support", revision: 3 },
      cases: [
        { id: "c1", position: 0, input: { opening: "hi" }, expected: { tools: ["billing.lookup_invoice"] }, tags: [] },
        { id: "c2", position: 1, input: { opening: "hi" }, expected: { tools: ["billing.lookup_invoice"] }, tags: [] },
        { id: "c3", position: 2, input: { opening: "hi" }, expected: { tools: ["billing.lookup_invoice"] }, tags: [] },
      ],
      graders: [
        { id: "calls", type: "tool_calls", weight: 1, mustPass: false, hash: "h1", args: [] },
        { id: "short", type: "conversation_check", weight: 1, mustPass: false, hash: "h2", maxTurns: 3 },
        {
          id: "tone",
          type: "rubric",
          weight: 1,
          mustPass: false,
          hash: "h3",
          rubric: "The agent is helpful",
          scale: "pass_fail",
          passAt: 1,
          judge: "openai/stub-judge",
          examples: [],
        },
      ],
      repeats: 2,
      concurrency: 2,
      evalRunId: "smoke-agent-run",
    } as never);
    const rec = recordingIo(async (req): Promise<RunCaseResult> => ({
      ok: true,
      stageRunId: `ses_${req.caseId}_${req.repeatIndex}`,
      output: conversation(req.caseId),
      latencyMs: 100,
      costUsd: 0.01,
      tokensIn: 100,
      tokensOut: 20,
    }));
    await engine.run(plan, rec.io, new AbortController().signal);
    return { rec, log };
  }

  it("grades conversation outputs with all three kinds of grader and joins repeats", async () => {
    const { rec } = await run();
    expect(rec.results).toHaveLength(6);
    expect(new Set(rec.results.map((r) => `${r.caseId}:${r.repeatIndex}`)).size).toBe(6);
    for (const result of rec.results) {
      expect(result.run.ok).toBe(true);
      expect(result.grades.map((g) => g.graderId)).toEqual(["calls", "short", "tone"]);
      const tone = result.grades[2]!;
      expect(tone.status).toBe("graded");
      expect(tone.judgeCostUsd).toBeGreaterThan(0);
      expect(tone.judgeCostUsd).toBeCloseTo(
        ((tone.judgeTokensIn ?? 0) * PRICE.inputPerMillion + (tone.judgeTokensOut ?? 0) * PRICE.outputPerMillion) / 1_000_000,
        10,
      );
    }
    const calls = (caseId: string) => rec.results.filter((r) => r.caseId === caseId).map((r) => r.grades[0]!.passed);
    expect(calls("c1")).toEqual([true, true]);
    expect(calls("c2")).toEqual([false, false]);
    expect(rec.judgeCost.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  }, 180_000);

  it("sends the transcript to the judge once (nested {{output.transcript}} must render)", async () => {
    const { log } = await run();
    const requests = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.route === "openai");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(String(request.text).split(MARKER).length - 1).toBe(1);
    }
  }, 180_000);
});
