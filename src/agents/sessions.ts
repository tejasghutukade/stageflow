import { randomBytes } from "node:crypto";
import type { AgentDefinition } from "../config/loadAgent.js";
import { assertDelegateAllowed } from "./delegate.js";
import { AgentError, isAgentError } from "./errors.js";
import { checkGuardrails } from "./guardrails.js";
import { fitHistory } from "./historyFit.js";
import type { OtlpSink } from "./otlpSink.js";
import { isToolGranted, requiresAskFirst } from "./policy.js";
import type { ConversationBackend, GateDecision, RuntimeUsage, ToolCall, TurnHooks } from "./runtime/types.js";
import type { AgentService, AgentSessionDetail } from "./service.js";
import { prepareSpan, type SpanKind } from "./trace.js";

export type { ConversationBackend, ConversationMessage } from "./runtime/types.js";

export type SendTurnInput = {
  projectRoot: string;
  agentId: string;
  sessionId?: string;
  text: string;
  /** Who sent the message (display name or channel identity). */
  author?: string | null;
  /** Where a new session came from: console, cli, mcp, schedule, or a provider id. */
  source?: string;
  onDelta?: (text: string) => void;
  onSessionOpened?: (sessionId: string) => void;
};

export type ConversationOptions = {
  service: AgentService;
  backend: ConversationBackend;
  otlpSink?: OtlpSink | undefined;
  logError?: (message: string) => void;
};

const GROUNDEDNESS_PROMPT = (reply: string, evidence: string[]) =>
  [
    "Rate how well the ANSWER is supported by the TOOL OUTPUTS, from 0 (unsupported or contradicted) to 1 (fully supported).",
    "Reply with only the number.",
    "",
    "TOOL OUTPUTS:",
    ...evidence.map((e, i) => `[${i + 1}] ${e.slice(0, 4000)}`),
    "",
    "ANSWER:",
    reply.slice(0, 8000),
  ].join("\n");

function spanId(): string {
  return randomBytes(8).toString("hex");
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One turn: open (if needed) → record user message → model + tools → guardrails → record reply. */
export class AgentConversation {
  private controller: AbortController | null = null;

  constructor(
    private readonly options: ConversationOptions,
    private readonly depth = 0,
    private readonly parentSignal?: AbortSignal,
  ) {}

  stop(): void {
    this.controller?.abort();
  }

  async send(input: SendTurnInput): Promise<AgentSessionDetail> {
    const { service, backend } = this.options;
    const controller = new AbortController();
    this.controller = controller;
    const onParentAbort = () => controller.abort();
    this.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    try {
      let sessionId = input.sessionId;
      if (!sessionId) {
        const opened = await service.openSession(input.projectRoot, input.agentId, {
          source: input.source ?? "console",
          sourceRef: input.author ?? null,
        });
        sessionId = opened.id;
        input.onSessionOpened?.(sessionId);
      }
      const active = await service.beginTurn(input.projectRoot, sessionId, {
        text: input.text,
        author: input.author ?? null,
      });
      if (active.session.agentId !== input.agentId) {
        await service.completeTurn(input.projectRoot, active.turn.id, { status: "failed", errorCode: "agent.session_not_found" });
        throw new AgentError("agent.session_not_found");
      }
      try {
        return await this.runTurn(input, sessionId, active, controller);
      } catch (error) {
        // A failure outside the model call (storage, spans) must not leave the session stuck running.
        const state = (await service.getSession(input.projectRoot, sessionId).catch(() => undefined))?.turns.find((t) => t.id === active.turn.id);
        if (state && (state.status === "running" || state.status === "waiting")) {
          await service.completeTurn(input.projectRoot, active.turn.id, {
            status: "failed",
            errorCode: isAgentError(error) ? error.code : "agent.backend_failed",
          }).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      this.parentSignal?.removeEventListener("abort", onParentAbort);
      if (this.controller === controller) this.controller = null;
    }
  }

  private async runTurn(
    input: SendTurnInput,
    sessionId: string,
    active: Awaited<ReturnType<AgentService["beginTurn"]>>,
    controller: AbortController,
  ): Promise<AgentSessionDetail> {
    const { service, backend } = this.options;
    const { definition, turn } = active;
    const capture = definition.observability.capture;
    const rootId = spanId();
    const startedAt = new Date();
    const record = (draft: Parameters<typeof prepareSpan>[1]) => {
      const span = prepareSpan(capture, draft);
      if (span) service.recordSpan(input.projectRoot, span);
    };
    const toolStarts = new Map<string, Date>();
    let stopReason: { code: string; message: string } | undefined;
    let gateChain: Promise<unknown> = Promise.resolve();

    const gateOne = async (call: ToolCall): Promise<GateDecision> => {
      if (!isToolGranted(definition, call.tool)) {
        return { allow: false, reason: `Tool ${call.tool} is not granted to this agent.` };
      }
      if (!requiresAskFirst(definition, call.tool)) return { allow: true };
      const gateStart = new Date();
      const approval = await service.requestApproval(input.projectRoot, sessionId, {
        tool: call.tool,
        payload: call.input,
        turnId: turn.id,
      });
      if (approval.status === "approved") return { allow: true };
      service.markTurnWaiting(input.projectRoot, turn.id, true);
      const outcome = await service.approvalBroker.wait(approval.id, { expiresAt: approval.expiresAt, signal: controller.signal, now: () => service.clockMs() });
      if (outcome === "expired") await service.pendingApprovals(input.projectRoot);
      if (outcome !== "aborted") service.markTurnWaiting(input.projectRoot, turn.id, false);
      record({
        turnId: turn.id,
        parentSpanId: rootId,
        name: `approval ${call.tool}`,
        kind: "gate",
        status: outcome === "approved" ? "ok" : "error",
        startedAt: gateStart,
        endedAt: new Date(),
        attributes: { "stageflow.approval.outcome": outcome, "gen_ai.tool.name": call.tool },
      });
      if (outcome === "approved") return { allow: true };
      if (outcome === "aborted") return { allow: false, reason: "The turn was stopped.", stopTurn: true };
      if (outcome === "denied") return { allow: false, reason: `The operator denied ${call.tool}. Do not retry it; continue without it or explain.` };
      if (definition.approvals.on_timeout === "deny") {
        stopReason = { code: "agent.approval_expired", message: "Approval timed out" };
        return { allow: false, reason: "Approval timed out; the turn was ended.", stopTurn: true };
      }
      return { allow: false, reason: `Approval for ${call.tool} timed out and the action was skipped. Continue without it.` };
    };

    const hooks: TurnHooks = {
      gate: (call) => {
        const next = gateChain.then(() => gateOne(call));
        gateChain = next.catch(() => undefined);
        return next;
      },
      toolStarted: (call) => {
        toolStarts.set(call.id, new Date());
      },
      toolFinished: (call, result) => {
        const isAgent = call.tool.startsWith("agent:");
        record({
          turnId: turn.id,
          parentSpanId: rootId,
          name: isAgent ? `invoke_agent ${call.tool.slice(6)}` : `execute_tool ${call.tool}`,
          kind: (isAgent ? "sub_agent" : "tool") as SpanKind,
          status: result.ok ? "ok" : "error",
          startedAt: toolStarts.get(call.id) ?? new Date(),
          endedAt: new Date(),
          attributes: { "gen_ai.tool.name": call.tool },
          input: toJson(call.input),
          output: result.output,
        });
      },
      modelFinished: (info) => {
        record({
          turnId: turn.id,
          parentSpanId: rootId,
          name: "chat",
          kind: "model",
          status: "ok",
          startedAt: info.startedAt,
          endedAt: info.endedAt,
          usage: { inputTokens: info.inputTokens, outputTokens: info.outputTokens },
          attributes: {
            "gen_ai.system": definition.model.backend,
            ...(info.model ? { "gen_ai.request.model": info.model } : {}),
            "gen_ai.usage.cost_usd": info.costUsd,
          },
        });
      },
      delegate: async (agentId, message) => {
        assertDelegateAllowed(definition, agentId, this.depth);
        const child = new AgentConversation(this.options, this.depth + 1, controller.signal);
        try {
          const detail = await child.send({
            projectRoot: input.projectRoot,
            agentId,
            text: message,
            source: "agent",
            author: active.session.agentId,
          });
          return [...detail.messages].reverse().find((m) => m.role === "assistant")?.text ?? "(no reply)";
        } catch (error) {
          return `Sub-agent ${agentId} failed: ${isAgentError(error) ? error.code : "error"}${error instanceof Error && error.message !== (error as AgentError).code ? ` (${error.message})` : ""}`;
        }
      },
    };

    let result: Awaited<ReturnType<ConversationBackend["complete"]>>;
    try {
      const transcript = [...active.history, active.userMessage].map((m) => ({ role: m.role, text: m.text }));
      result = await backend.complete({
        sessionId,
        projectRoot: input.projectRoot,
        definition,
        messages: [...fitHistory(transcript.slice(0, -1), definition.limits.long_context), transcript.at(-1)!],
        signal: controller.signal,
        onDelta: input.onDelta ?? (() => undefined),
        hooks,
      });
    } catch (error) {
      const code = isAgentError(error) ? error.code : "agent.backend_failed";
      record({ turnId: turn.id, name: `invoke_agent ${definition.id}`, kind: "agent", status: "error", startedAt, endedAt: new Date(), attributes: { "error.type": code } });
      await service.completeTurn(input.projectRoot, turn.id, { status: "failed", errorCode: code });
      this.exportLive(input.projectRoot, definition, turn.id);
      throw error;
    }

    const cancelled = controller.signal.aborted;
    const usage: RuntimeUsage | undefined = result.usage;
    const endRoot = (status: "ok" | "error" | "cancelled") => {
      const rootSpan = prepareSpan(capture, {
        turnId: turn.id,
        name: `invoke_agent ${definition.id}`,
        kind: "agent",
        status,
        startedAt,
        endedAt: new Date(),
        ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}),
        attributes: {
          "gen_ai.agent.name": definition.id,
          "stageflow.agent.revision": active.session.revision,
          ...(definition.model.id ? { "gen_ai.request.model": definition.model.id } : {}),
        },
        input: input.text,
        output: result.text,
      });
      if (rootSpan) service.recordSpan(input.projectRoot, { ...rootSpan, id: rootId });
    };

    const guard = checkGuardrails(definition.guardrails, result.text);
    if (!guard.ok) {
      record({ turnId: turn.id, parentSpanId: rootId, name: "guardrail", kind: "guardrail", status: "error", startedAt: new Date(), endedAt: new Date(), attributes: { "stageflow.guardrail.pattern": guard.pattern } });
      endRoot("error");
      await service.completeTurn(input.projectRoot, turn.id, {
        status: "failed",
        errorCode: "agent.guardrail_blocked",
        ...(usage ? { usage, costUsd: usage.costUsd } : {}),
      });
      this.exportLive(input.projectRoot, definition, turn.id);
      throw new AgentError("agent.guardrail_blocked", `Reply blocked by guardrail ${guard.pattern}`);
    }

    const evalScores = await this.score(input.projectRoot, definition, turn.id, rootId, result, controller.signal, cancelled || stopReason !== undefined);
    const failed = stopReason !== undefined;
    endRoot(cancelled ? "cancelled" : failed ? "error" : "ok");
    const detail = await service.completeTurn(input.projectRoot, turn.id, {
      status: failed ? "failed" : cancelled ? "cancelled" : "succeeded",
      ...(failed ? { errorCode: stopReason!.code } : {}),
      assistantText: result.text,
      ...(usage ? { usage, costUsd: usage.costUsd } : {}),
      ...(evalScores.length > 0 ? { evalScores } : {}),
    });
    this.exportLive(input.projectRoot, definition, turn.id);
    return detail;
  }

  private async score(
    projectRoot: string,
    definition: AgentDefinition,
    turnId: string,
    rootId: string,
    result: { text: string; toolOutputs: string[] },
    signal: AbortSignal,
    skip: boolean,
  ): Promise<Array<{ metric: string; score: number }>> {
    const { backend, service } = this.options;
    if (skip || !definition.evals.groundedness || !backend.judge || result.toolOutputs.length === 0 || !result.text.trim()) return [];
    const startedAt = new Date();
    try {
      const raw = await backend.judge({ projectRoot, definition, prompt: GROUNDEDNESS_PROMPT(result.text, result.toolOutputs), signal });
      const match = /(?:^|[^\d.])(1(?:\.0+)?|0?\.\d+|0)(?![\d])/.exec(raw.trim());
      if (!match) throw new Error("no score in judge output");
      const score = Math.min(1, Math.max(0, Number(match[1])));
      const span = prepareSpan(definition.observability.capture, {
        turnId, parentSpanId: rootId, name: "eval groundedness", kind: "guardrail", status: "ok", startedAt, endedAt: new Date(),
        attributes: { "gen_ai.evaluation.name": "groundedness", "gen_ai.evaluation.score.value": score },
      });
      if (span) service.recordSpan(projectRoot, span);
      return [{ metric: "groundedness", score }];
    } catch (error) {
      this.options.logError?.(`groundedness eval failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Best-effort push to the configured OTLP collector; a collector outage never fails a turn. */
  private exportLive(projectRoot: string, definition: AgentDefinition, turnId: string): void {
    const sink = this.options.otlpSink;
    if (!sink || !definition.observability.otlp || definition.observability.capture === "off") return;
    void (async () => {
      try {
        await sink(this.options.service.exportTurnOtlp(projectRoot, turnId));
      } catch (error) {
        this.options.logError?.(`OTLP export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }
}
