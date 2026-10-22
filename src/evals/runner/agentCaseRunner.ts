import { isAgentError } from "../../agents/errors.js";
import { createEvalGate, type EvalGate } from "../../agents/evalGate.js";
import type { AgentHostContext } from "../../agents/hostContext.js";
import type { AgentSessionDetail } from "../../agents/service.js";
import type { AgentDefinition } from "../../config/loadAgent.js";
import { buildConversationSubject } from "./conversationSubject.js";
import {
  createBackendSimulatorModel,
  SimulatorError,
  type DriverUsage,
  type ModelPrice,
  type SimulatorModel,
} from "./simulatorModel.js";
import type { StageCaseRunner } from "./stageCaseRunner.js";
import {
  createDriver,
  DriverScenarioError,
  type DriverContext,
  type DriverMode,
  type DriverScenario,
  type UserDriver,
} from "./userDriver.js";
import type {
  ConversationOutput,
  ConversationStopReason,
  ConversationUsage,
  EvalPlan,
  RunCaseFailureCode,
  RunCaseRequest,
  RunCaseResult,
} from "../types.js";

export const EVAL_CASE_WALL_CLOCK_GRACE_MS = 60_000;
export const EVAL_TURN_STOP_GRACE_MS = 10_000;
const SESSION_OVERHEAD_MINUTES = 5;

export type AgentRunnerHost = Pick<AgentHostContext, "service" | "chat" | "evalGates" | "backend">;

export type AgentCaseRunnerDeps = {
  /** Lazy: the manager is built before the agent host. Undefined means this Host cannot run agents. */
  host: () => AgentRunnerHost | undefined;
  /** Builds the simulated user's model; defaults to the agent backend's one-shot call on `plan.userModel`. */
  simulatorModel?: (input: { projectRoot: string; definition: AgentDefinition; modelId: string; host: AgentRunnerHost }) => SimulatorModel;
  /** USD per million tokens by model id, for pricing simulator calls the backend reports no cost for. */
  loadPrices?: (modelIds: readonly string[], projectRoot: string) => Promise<Map<string, ModelPrice>>;
  now?: () => number;
  wallClockGraceMs?: number;
  stopGraceMs?: number;
};

type EvalRunState = {
  active: Map<string, { done: Promise<void> }>;
  spend: number;
  cancelled: boolean;
  abort: AbortController;
};

type CaseEnd =
  | { kind: "done"; stopReason: ConversationStopReason }
  | { kind: "failed"; code: RunCaseFailureCode; message: string; stopReason: "error" | "timeout" }
  | { kind: "cancelled" };

type Mock = { result?: unknown; error?: string };

function failure(
  code: RunCaseFailureCode,
  message: string,
  extra: { subjectRef?: string; output?: ConversationOutput; latencyMs?: number; costUsd?: number } = {},
): RunCaseResult {
  return {
    ok: false,
    code,
    message,
    ...(extra.subjectRef !== undefined ? { subjectRef: extra.subjectRef } : {}),
    ...(extra.output !== undefined ? { output: extra.output } : {}),
    ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
    ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}),
  };
}

function parseMocks(value: unknown): Record<string, Mock> {
  const out: Record<string, Mock> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [tool, mock] of Object.entries(value)) {
    if (typeof mock !== "object" || mock === null) continue;
    const { result, error } = mock as Record<string, unknown>;
    if (typeof error === "string") out[tool] = { error };
    else if ("result" in mock) out[tool] = { result };
  }
  return out;
}

function sumTurns(detail: AgentSessionDetail): { costUsd: number; tokensIn: number; tokensOut: number; modelCalls: number } {
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const turn of detail.turns) {
    costUsd += turn.costUsd ?? 0;
    tokensIn += turn.inputTokens ?? 0;
    tokensOut += turn.outputTokens ?? 0;
  }
  const modelSpans = detail.spans.filter((span) => span.kind === "model").length;
  return { costUsd, tokensIn, tokensOut, modelCalls: modelSpans > 0 ? modelSpans : detail.turns.length };
}

function errorText(error: unknown): string {
  if (isAgentError(error)) return error.message === error.code ? error.code : `${error.code}: ${error.message}`;
  return "agent.backend_failed";
}

export function createAgentCaseRunner(deps: AgentCaseRunnerDeps): StageCaseRunner {
  const clock = deps.now ?? Date.now;
  const wallGraceMs = deps.wallClockGraceMs ?? EVAL_CASE_WALL_CLOCK_GRACE_MS;
  const stopGraceMs = deps.stopGraceMs ?? EVAL_TURN_STOP_GRACE_MS;
  const states = new Map<string, EvalRunState>();

  const stateFor = (evalRunId: string): EvalRunState => {
    let state = states.get(evalRunId);
    if (state === undefined) {
      state = { active: new Map(), spend: 0, cancelled: false, abort: new AbortController() };
      states.set(evalRunId, state);
    }
    return state;
  };

  async function simulatorFor(plan: EvalPlan, host: AgentRunnerHost, definition: AgentDefinition): Promise<SimulatorModel> {
    const modelId = plan.userModel as string;
    if (deps.simulatorModel) return deps.simulatorModel({ projectRoot: plan.projectRoot, definition, modelId, host });
    const prices = (await deps.loadPrices?.([modelId], plan.projectRoot).catch(() => undefined)) ?? new Map<string, ModelPrice>();
    return createBackendSimulatorModel({
      backend: host.backend,
      projectRoot: plan.projectRoot,
      definition,
      modelId,
      priceOf: (id) => prices.get(id),
    });
  }

  async function runCase(plan: EvalPlan, req: RunCaseRequest): Promise<RunCaseResult> {
    const state = stateFor(req.evalRunId);
    if (state.cancelled) return failure("EVAL_CANCELLED", "Eval run was cancelled");
    if (state.spend >= plan.maxCostUsd) {
      return failure("EVAL_BUDGET_EXCEEDED", `Eval spend reached the $${plan.maxCostUsd} limit`);
    }
    const { agent, conversation, target } = plan;
    if (target.kind !== "agent" || !agent || !conversation) {
      return failure("EVAL_ENGINE_ERROR", "Not an agent plan");
    }
    const host = deps.host();
    if (!host) return failure("EVAL_ENGINE_ERROR", "Agents are unavailable on this host");
    const planCase = plan.cases.find((c) => c.id === req.caseId);
    if (planCase === undefined) return failure("EVAL_ENGINE_ERROR", `Case "${req.caseId}" is not in the plan`);

    const definition = agent.definition as unknown as AgentDefinition;
    const scenario = planCase.input as DriverScenario & { tool_mocks?: unknown };
    const mode: DriverMode = scenario.mode === "script" || scenario.mode === "simulated" ? scenario.mode : conversation.mode;
    let driver: UserDriver;
    try {
      let simulatorModel: SimulatorModel | undefined;
      if (mode === "simulated") {
        if (!plan.userModel) return failure("EVAL_ENGINE_ERROR", "A simulated case needs a user model");
        simulatorModel = await simulatorFor(plan, host, definition);
      }
      driver = createDriver(mode, scenario, simulatorModel ? { simulatorModel } : {});
    } catch (err) {
      return failure("EVAL_ENGINE_ERROR", err instanceof DriverScenarioError ? err.message : "Scenario could not be prepared");
    }

    const { service, chat, evalGates } = host;
    const startedAt = clock();
    const sessionMinutes = Math.ceil((conversation.maxTurns * conversation.turnTimeoutMs) / 60_000) + SESSION_OVERHEAD_MINUTES;
    let sessionId: string;
    try {
      const session = await service.openSession(plan.projectRoot, target.agentId, {
        source: "eval",
        sourceRef: plan.evalRunId,
        title: `eval ${plan.evalId} ${plan.evalRunId} ${req.caseId}.${req.repeatIndex}`,
        eval: {
          ...(target.revision !== undefined ? { revision: target.revision } : {}),
          ...(plan.modelOverride !== undefined ? { definition: { model: { id: plan.modelOverride } } } : {}),
          limits: { max_turns: conversation.maxTurns + 1, session_minutes: sessionMinutes, cost_usd: null },
          capture: "full",
        },
      });
      sessionId = session.id;
    } catch (err) {
      const code = isAgentError(err) && (err.code === "agent.archived" || err.code === "agent.revision_not_found") ? "EVAL_AGENT_FAILED" : "EVAL_ENGINE_ERROR";
      return failure(code, isAgentError(err) ? errorText(err) : "The eval session could not be opened");
    }

    let resolveDone!: () => void;
    state.active.set(sessionId, { done: new Promise<void>((resolve) => (resolveDone = resolve)) });

    let currentTurn = 0;
    const gate: EvalGate = createEvalGate({
      policy: {
        tools: conversation.tools,
        approvals: conversation.approvals,
        readOnlyTools: conversation.readOnlyTools,
        mocks: parseMocks(scenario.tool_mocks),
      },
      definition,
      projectRoot: plan.projectRoot,
      turn: () => currentTurn,
    });
    evalGates.set(sessionId, gate);

    const usage = { simCost: 0, simIn: 0, simOut: 0, simCalls: 0, simEstimated: false };
    const addSimulator = (u: DriverUsage | undefined): void => {
      if (u === undefined) return;
      usage.simCost += u.costUsd;
      usage.simIn += u.tokensIn;
      usage.simOut += u.tokensOut;
      usage.simCalls += 1;
      usage.simEstimated ||= u.estimated === true;
      state.spend += u.costUsd;
    };
    let countedRootCost = 0;
    const syncSpend = (detail: AgentSessionDetail): void => {
      const cost = sumTurns(detail).costUsd;
      state.spend += cost - countedRootCost;
      countedRootCost = cost;
    };

    const caseCtl = new AbortController();
    let wallExpired = false;
    let stuckTimer: NodeJS.Timeout | undefined;
    let releaseStuck: () => void = () => undefined;
    const stuck = new Promise<"stuck">((resolve) => (releaseStuck = () => resolve("stuck")));
    const stopTurn = (): void => {
      chat.stop(sessionId);
      stuckTimer ??= setTimeout(releaseStuck, stopGraceMs);
    };
    const onCancel = (): void => {
      caseCtl.abort();
      stopTurn();
    };
    state.abort.signal.addEventListener("abort", onCancel, { once: true });
    const wallMs = conversation.maxTurns * conversation.turnTimeoutMs + wallGraceMs;
    const wallTimer = setTimeout(() => {
      wallExpired = true;
      caseCtl.abort();
      stopTurn();
    }, wallMs);

    let turnsDone = 0;

    const converse = async (): Promise<CaseEnd> => {
      const transcript: DriverContext["transcript"] = [];
      for (let turn = 1; turn <= conversation.maxTurns; turn++) {
        if (state.cancelled) return { kind: "cancelled" };
        if (wallExpired) return { kind: "failed", code: "EVAL_AGENT_TIMEOUT", message: "Conversation exceeded its time limit", stopReason: "timeout" };
        let step;
        try {
          step = await driver.next({ turn, transcript, signal: caseCtl.signal });
        } catch (err) {
          if (state.cancelled) return { kind: "cancelled" };
          if (wallExpired) return { kind: "failed", code: "EVAL_AGENT_TIMEOUT", message: "Conversation exceeded its time limit", stopReason: "timeout" };
          const message = err instanceof SimulatorError ? err.message : "The simulated user failed";
          return { kind: "failed", code: "EVAL_SIMULATOR_ERROR", message, stopReason: "error" };
        }
        addSimulator(step.usage);
        if (step.kind === "end") return { kind: "done", stopReason: step.reason };

        currentTurn = turn;
        let turnTimedOut = false;
        const turnTimer = setTimeout(() => {
          turnTimedOut = true;
          stopTurn();
        }, conversation.turnTimeoutMs);
        const sent = chat
          .send({ projectRoot: plan.projectRoot, agentId: target.agentId, sessionId, text: step.text, source: "eval" })
          .then(
            (detail) => ({ ok: true as const, detail }),
            (err: unknown) => ({ ok: false as const, err }),
          );
        const outcome = await Promise.race([sent, stuck]);
        clearTimeout(turnTimer);
        turnsDone = turn;

        if (state.cancelled) return { kind: "cancelled" };
        if (outcome === "stuck" || turnTimedOut || wallExpired) {
          const message = turnTimedOut ? `Turn ${turn} exceeded ${conversation.turnTimeoutMs} ms` : "Conversation exceeded its time limit";
          return { kind: "failed", code: "EVAL_AGENT_TIMEOUT", message, stopReason: "timeout" };
        }
        if (!outcome.ok) {
          return { kind: "failed", code: "EVAL_AGENT_FAILED", message: errorText(outcome.err), stopReason: "error" };
        }
        const { detail } = outcome;
        syncSpend(detail);
        const latest = detail.turns[detail.turns.length - 1];
        if (latest?.status === "waiting") {
          return { kind: "failed", code: "EVAL_ENGINE_ERROR", message: "A turn is waiting for approval, which an eval cannot give", stopReason: "error" };
        }
        if (latest !== undefined && latest.status !== "succeeded") {
          return { kind: "failed", code: "EVAL_AGENT_FAILED", message: latest.errorCode ?? "agent.backend_failed", stopReason: "error" };
        }
        transcript.splice(0, transcript.length, ...detail.messages.map((m) => ({ role: m.role, text: m.text })));
        if (step.endAfter !== undefined) return { kind: "done", stopReason: step.endAfter };
      }
      return { kind: "done", stopReason: "max_turns" };
    };

    let end: CaseEnd;
    try {
      end = await converse();
    } catch (err) {
      end = { kind: "failed", code: "EVAL_ENGINE_ERROR", message: err instanceof Error ? err.message : "Conversation failed", stopReason: "error" };
    }
    clearTimeout(wallTimer);
    if (stuckTimer) clearTimeout(stuckTimer);
    state.abort.signal.removeEventListener("abort", onCancel);

    let result: RunCaseResult;
    try {
      const detail = await service.getSession(plan.projectRoot, sessionId);
      syncSpend(detail);
      const root = sumTurns(detail);
      let childCost = 0;
      let childIn = 0;
      let childOut = 0;
      let childCalls = 0;
      for (const child of service.listChildSessions(sessionId)) {
        const childDetail = await service.getSession(plan.projectRoot, child.id);
        const sums = sumTurns(childDetail);
        childCost += sums.costUsd;
        childIn += sums.tokensIn;
        childOut += sums.tokensOut;
        childCalls += sums.modelCalls;
      }
      state.spend += childCost;
      const agentCost = root.costUsd + childCost;
      const conversationUsage: ConversationUsage = {
        cost_usd: agentCost + usage.simCost,
        agent_cost_usd: agentCost,
        simulator_cost_usd: usage.simCost,
        tokens_in: root.tokensIn + childIn,
        tokens_out: root.tokensOut + childOut,
        simulator_tokens_in: usage.simIn,
        simulator_tokens_out: usage.simOut,
        simulator_estimated: usage.simEstimated,
        agent_calls: root.modelCalls + childCalls,
        simulator_calls: usage.simCalls,
      };
      const latencyMs = Math.max(0, clock() - startedAt);
      const costUsd = conversationUsage.cost_usd;
      const subject = (stopReason: ConversationStopReason, failed?: string): ConversationOutput =>
        buildConversationSubject({
          detail,
          calls: gate.records(),
          stopReason,
          usage: conversationUsage,
          turns: turnsDone,
          ...(failed !== undefined ? { failure: failed } : {}),
        });
      if (end.kind === "done") {
        result = {
          ok: true,
          subjectRef: sessionId,
          output: subject(end.stopReason),
          latencyMs,
          costUsd,
          tokensIn: conversationUsage.tokens_in,
          tokensOut: conversationUsage.tokens_out,
        };
      } else if (end.kind === "cancelled") {
        result = failure("EVAL_CANCELLED", "Eval run was cancelled", { subjectRef: sessionId, latencyMs, costUsd });
      } else {
        result = failure(end.code, end.message, {
          subjectRef: sessionId,
          output: subject(end.stopReason, end.message),
          latencyMs,
          costUsd,
        });
      }
    } catch (err) {
      result = failure("EVAL_ENGINE_ERROR", err instanceof Error ? err.message : "Conversation could not be read", { subjectRef: sessionId });
    } finally {
      try {
        const children = service.listChildSessions(sessionId);
        await chat.closeEvalSession(plan.projectRoot, sessionId);
        for (const child of children) {
          await chat.release(child.id);
          service.forgetEvalSession(child.id);
          evalGates.delete(child.id);
        }
      } catch {
        /* the runtime session is dropped with the Host at the latest */
      }
      evalGates.delete(sessionId);
      state.active.delete(sessionId);
      resolveDone();
    }
    return result;
  }

  return {
    runCase,
    async cancelAll(evalRunId) {
      const state = stateFor(evalRunId);
      state.cancelled = true;
      state.abort.abort();
      const host = deps.host();
      await Promise.all(
        [...state.active.entries()].map(async ([sessionId, entry]) => {
          host?.chat.stop(sessionId);
          await entry.done;
        }),
      );
    },
    spend: (evalRunId) => states.get(evalRunId)?.spend ?? 0,
    addSpend(evalRunId, usd) {
      stateFor(evalRunId).spend += usd;
    },
  };
}
