import { randomUUID } from "node:crypto";
import type { AgentSessionDetail } from "../../agents/service.js";
import { createOperatorEvalGate } from "../../operatorAgent/evalGate.js";
import type { OperatorAgentHost, OperatorAgentSession } from "../../operatorAgent/types.js";
import { buildConversationSubject } from "./conversationSubject.js";
import type { StageCaseRunner } from "./stageCaseRunner.js";
import { createDriver, DriverScenarioError, type DriverMode, type DriverScenario } from "./userDriver.js";
import type {
  ConversationOutput,
  ConversationStopReason,
  ConversationUsage,
  EvalPlan,
  RunCaseFailureCode,
  RunCaseRequest,
  RunCaseResult,
} from "../types.js";

const ZERO_USAGE: ConversationUsage = {
  cost_usd: 0,
  agent_cost_usd: 0,
  simulator_cost_usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  simulator_tokens_in: 0,
  simulator_tokens_out: 0,
  simulator_estimated: false,
  agent_calls: 0,
  simulator_calls: 0,
};

type RunState = { cancelled: boolean; abort: AbortController };

function failure(
  code: RunCaseFailureCode,
  message: string,
  extra: { subjectRef?: string; output?: ConversationOutput; latencyMs?: number; costUsd?: number } = {},
): RunCaseResult {
  return { ok: false, code, message, ...extra };
}

function parseMocks(value: unknown): Record<string, { result?: unknown; error?: string }> {
  const out: Record<string, { result?: unknown; error?: string }> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [tool, mock] of Object.entries(value)) {
    if (typeof mock !== "object" || mock === null) continue;
    const { result, error } = mock as Record<string, unknown>;
    if (typeof error === "string") out[tool] = { error };
    else if ("result" in mock) out[tool] = { result };
  }
  return out;
}

function detailFrom(sessionId: string, profileId: string, messages: AgentSessionDetail["messages"]): AgentSessionDetail {
  const now = new Date().toISOString();
  return {
    session: {
      id: sessionId,
      agentId: profileId,
      revision: 0,
      backend: "pi",
      status: "closed",
      source: "eval",
      sourceRef: null,
      threadKey: null,
      title: null,
      createdAt: now,
      updatedAt: now,
    },
    messages,
    turns: [],
    spans: [],
    approvals: [],
    pendingApproval: null,
    evalScores: [],
    deliveries: [],
  };
}

export function createInternalAgentCaseRunner(deps: {
  host: () => OperatorAgentHost | undefined;
  now?: () => number;
}): StageCaseRunner {
  const clock = deps.now ?? Date.now;
  const states = new Map<string, RunState>();
  const stateFor = (id: string): RunState => {
    let state = states.get(id);
    if (!state) {
      state = { cancelled: false, abort: new AbortController() };
      states.set(id, state);
    }
    return state;
  };

  async function runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult> {
    const state = stateFor(req.evalRunId);
    if (state.cancelled) return failure("EVAL_CANCELLED", "Eval run was cancelled");
    if (plan.target.kind !== "internal_agent" || !plan.conversation) {
      return failure("EVAL_ENGINE_ERROR", "Not an internal-agent plan");
    }
    if (plan.conversation.tools === "real") {
      return failure("EVAL_ENGINE_ERROR", "Internal agents cannot run an eval with real tools");
    }
    const host = deps.host();
    if (!host) return failure("EVAL_ENGINE_ERROR", "Internal agents are unavailable on this host");
    const planCase = plan.cases.find((c) => c.id === req.caseId);
    if (!planCase) return failure("EVAL_ENGINE_ERROR", `Case "${req.caseId}" is not in the plan`);

    const scenario = planCase.input as DriverScenario & { tool_mocks?: unknown };
    const mode: DriverMode = scenario.mode === "script" || scenario.mode === "simulated" ? scenario.mode : plan.conversation.mode;
    let driver;
    try {
      driver = createDriver(mode, scenario, {});
    } catch (err) {
      return failure("EVAL_ENGINE_ERROR", err instanceof DriverScenarioError ? err.message : "Scenario could not be prepared");
    }
    if (mode === "simulated") {
      return failure("EVAL_ENGINE_ERROR", "A simulated internal-agent case needs a user model, which this runner does not call");
    }

    const conversation = plan.conversation;
    const sessionId = `op_eval_${randomUUID()}`;
    let turn = 0;
    const gate = createOperatorEvalGate({
      policy: { tools: conversation.tools, mocks: parseMocks(scenario.tool_mocks) },
      turn: () => turn,
    });
    let session: OperatorAgentSession;
    try {
      session = host.openEvalSession({
        profileId: plan.target.profileId,
        context: { kind: "stageflow_guide" },
        gate,
      });
    } catch (err) {
      return failure("EVAL_ENGINE_ERROR", err instanceof Error ? err.message : "The eval session could not be opened");
    }

    const startedAt = clock();
    const messages: AgentSessionDetail["messages"] = [];
    const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
    let end: { kind: "done"; stopReason: ConversationStopReason } | { kind: "failed"; code: RunCaseFailureCode; message: string; stopReason: "error" | "timeout" } | { kind: "cancelled" } = {
      kind: "done",
      stopReason: "max_turns",
    };
    const caseCtl = new AbortController();
    let wallExpired = false;
    let turnTimedOut = false;
    const stopCase = (): void => {
      caseCtl.abort();
      void session.abort().catch(() => undefined);
    };
    const onRunAbort = (): void => stopCase();
    state.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    const wallMs = conversation.maxTurns * conversation.turnTimeoutMs + 60_000;
    const wall = setTimeout(() => {
      wallExpired = true;
      stopCase();
    }, wallMs);
    const stopped = new Promise<"stopped">((resolve) => {
      if (caseCtl.signal.aborted) resolve("stopped");
      else caseCtl.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    try {
      for (turn = 1; turn <= conversation.maxTurns; turn += 1) {
        if (state.cancelled) {
          end = { kind: "cancelled" };
          break;
        }
        if (wallExpired || turnTimedOut || caseCtl.signal.aborted) {
          end = {
            kind: "failed",
            code: "EVAL_AGENT_TIMEOUT",
            message: turnTimedOut ? `Turn ${turn} exceeded ${conversation.turnTimeoutMs} ms` : "Conversation exceeded its time limit",
            stopReason: "timeout",
          };
          break;
        }
        const step = await driver.next({ turn, transcript, signal: caseCtl.signal });
        if (step.kind === "end") {
          end = { kind: "done", stopReason: step.reason };
          break;
        }
        const now = new Date().toISOString();
        messages.push({ id: randomUUID(), sessionId, seq: messages.length, turnId: String(turn), role: "user", author: null, text: step.text, createdAt: now });
        const turnTimer = setTimeout(() => {
          turnTimedOut = true;
          stopCase();
        }, conversation.turnTimeoutMs);
        const sent = session.send(step.text, plan.modelOverride ? { modelId: plan.modelOverride } : {}).then(
          (events) => ({ ok: true as const, events }),
          (err: unknown) => ({ ok: false as const, err }),
        );
        const outcome = await Promise.race([sent, stopped]);
        clearTimeout(turnTimer);
        if (state.cancelled) {
          end = { kind: "cancelled" };
          break;
        }
        if (outcome === "stopped" || wallExpired || turnTimedOut) {
          end = {
            kind: "failed",
            code: "EVAL_AGENT_TIMEOUT",
            message: turnTimedOut ? `Turn ${turn} exceeded ${conversation.turnTimeoutMs} ms` : "Conversation exceeded its time limit",
            stopReason: "timeout",
          };
          break;
        }
        if (!outcome.ok) {
          end = { kind: "failed", code: "EVAL_ENGINE_ERROR", message: outcome.err instanceof Error ? outcome.err.message : "Conversation failed", stopReason: "error" };
          break;
        }
        const text = outcome.events
          .filter((event) => event.type === "message" && event.role === "assistant")
          .map((event) => (event.type === "message" ? event.text : ""))
          .filter(Boolean)
          .join("\n\n");
        if (!text && gate.records().every((call) => call.turn !== turn)) {
          end = { kind: "failed", code: "EVAL_AGENT_EMPTY_REPLY", message: "The agent returned an empty reply", stopReason: "error" };
          break;
        }
        messages.push({ id: randomUUID(), sessionId, seq: messages.length, turnId: String(turn), role: "assistant", author: null, text, createdAt: now });
        transcript.push({ role: "user", text: step.text }, { role: "assistant", text });
        if (step.endAfter !== undefined) {
          end = { kind: "done", stopReason: step.endAfter };
          break;
        }
        if (turn === conversation.maxTurns) end = { kind: "done", stopReason: "max_turns" };
      }
    } catch (err) {
      end = state.cancelled
        ? { kind: "cancelled" }
        : wallExpired || turnTimedOut
          ? { kind: "failed", code: "EVAL_AGENT_TIMEOUT", message: turnTimedOut ? `Turn ${turn} exceeded ${conversation.turnTimeoutMs} ms` : "Conversation exceeded its time limit", stopReason: "timeout" }
          : { kind: "failed", code: "EVAL_ENGINE_ERROR", message: err instanceof Error ? err.message : "Conversation failed", stopReason: "error" };
    } finally {
      clearTimeout(wall);
      state.abort.signal.removeEventListener("abort", onRunAbort);
      session.close();
    }

    const usage = { ...ZERO_USAGE, agent_calls: messages.filter((m) => m.role === "assistant").length };
    const subject = (stopReason: ConversationStopReason, failed?: string): ConversationOutput =>
      buildConversationSubject({
        detail: detailFrom(sessionId, plan.target.kind === "internal_agent" ? plan.target.profileId : "", messages),
        calls: gate.records(),
        stopReason,
        usage,
        turns: messages.filter((m) => m.role === "user").length,
        ...(failed !== undefined ? { failure: failed } : {}),
      });
    const latencyMs = Math.max(0, clock() - startedAt);
    if (end.kind === "done") {
      return { ok: true, subjectRef: sessionId, output: subject(end.stopReason), latencyMs, costUsd: 0, tokensIn: 0, tokensOut: 0 };
    }
    if (end.kind === "cancelled") return failure("EVAL_CANCELLED", "Eval run was cancelled", { subjectRef: sessionId, latencyMs, costUsd: 0 });
    return failure(end.code, end.message, { subjectRef: sessionId, output: subject(end.stopReason, end.message), latencyMs, costUsd: 0 });
  }

  return {
    runCase,
    async cancelAll(evalRunId) {
      const state = states.get(evalRunId);
      if (!state) return;
      state.cancelled = true;
      state.abort.abort();
    },
    spend: () => 0,
    addSpend: () => undefined,
  };
}
