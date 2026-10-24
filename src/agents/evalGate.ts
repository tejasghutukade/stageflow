import { redactSecrets } from "../agent/streamLogRedact.js";
import type { AgentDefinition } from "../config/loadAgent.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { forbiddenWriteTarget, isToolGranted, requiresAskFirst } from "./policy.js";
import type { GateDecision, ToolCall } from "./runtime/types.js";
import { classifyTool } from "./toolRisk.js";

export type EvalToolPolicy = "real" | "read_only" | "mocked";
export type EvalApprovalPolicy = "deny" | "auto_approve_read" | "record_only";
export type EvalPolicyOutcome = "ran" | "stubbed" | "mocked" | "would_ask_first" | "denied";

export type EvalGatePolicy = {
  tools: EvalToolPolicy;
  approvals: EvalApprovalPolicy;
  /** Grant ids the eval author declares read-only (`<server>.<tool>`, `<server>.*`, or a builtin/Stageflow grant id). */
  readOnlyTools: string[];
  /** Canned results by tool grant id: `{ result }` or `{ error }`. */
  mocks: Record<string, { result?: unknown; error?: string }>;
};

export type EvalToolCallRecord = {
  id: string;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  policyOutcome: EvalPolicyOutcome;
  status: "ok" | "error" | "not_run";
  result?: string;
};

export type EvalGate = {
  readonly policy: EvalGatePolicy;
  /** Set when tools run for real; the console shows it as a warning. */
  readonly warning: string | undefined;
  decide(call: ToolCall, definition?: AgentDefinition): GateDecision;
  observeFinished(call: ToolCall, result: { ok: boolean; output: string }): void;
  recordOf(callId: string): EvalToolCallRecord | undefined;
  records(): EvalToolCallRecord[];
};

export const APPROVAL_NOT_GRANTED = (tool: string) => `Approval for ${tool} was not granted in this evaluation. Continue without it.`;
export const STUB_RESULT = (tool: string) => `${tool} was not executed in this evaluation.`;

const ALWAYS_BLOCKED = new Set([
  "stageflow.run_eval",
  "stageflow.agent_chat",
  "stageflow.fire_trigger",
  "stageflow.sort_eval_failures",
  "stageflow.cancel_eval_run",
]);
const BLOCKED_UNLESS_REAL = new Set(["stageflow.probe_project_mcp"]);

function redactedArgs(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(input))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mockText(mock: { result?: unknown; error?: string }): string {
  if (mock.error !== undefined) return mock.error;
  return typeof mock.result === "string" ? mock.result : JSON.stringify(mock.result ?? null);
}

/**
 * The eval-only tool gate. Order: denied (not granted, forbidden path, operator-only, always-blocked), then the approval
 * policy for ask-first tools, then the tool policy. A canned result can reach the model only as the reason of a blocked
 * call, which the runtime turns into an error-flagged tool result.
 */
export function createEvalGate(options: {
  policy: EvalGatePolicy;
  definition: AgentDefinition;
  /** Called when a call is decided, and again when a call that ran finishes (same id; the later record wins). */
  onCall?: (record: EvalToolCallRecord) => void;
  /** The conversation turn a call belongs to; defaults to 0. */
  turn?: () => number;
  projectRoot?: string;
  stageflowHome?: string;
}): EvalGate {
  const { policy } = options;
  const byId = new Map<string, EvalToolCallRecord>();
  const emit = (record: EvalToolCallRecord) => {
    byId.set(record.id, record);
    options.onCall?.(record);
  };

  const decide = (call: ToolCall, definition: AgentDefinition = options.definition): GateDecision => {
    const base = { id: call.id, turn: options.turn?.() ?? 0, name: call.tool, args: redactedArgs(call.input) };
    const refuse = (policyOutcome: "denied" | "would_ask_first", reason: string): GateDecision => {
      emit({ ...base, policyOutcome, status: "not_run", result: reason });
      return { allow: false, reason };
    };

    if (!isToolGranted(definition, call.tool)) return refuse("denied", `Tool ${call.tool} is not granted to this agent.`);
    if (options.projectRoot && forbiddenWriteTarget(options.projectRoot, options.stageflowHome ?? globalStageflowHome(), call.tool, call.input) !== undefined) {
      return refuse("denied", "Agent definitions and Stageflow state cannot be written by an agent.");
    }
    const kind = classifyTool(definition, call.tool, policy.readOnlyTools);
    const blocked =
      kind.class === "operator_only" ||
      ALWAYS_BLOCKED.has(call.tool) ||
      (policy.tools !== "real" && (BLOCKED_UNLESS_REAL.has(call.tool) || kind.class === "sub_agent"));
    if (blocked) return refuse("denied", `${call.tool} cannot run in an evaluation.`);

    if (requiresAskFirst(definition, call.tool)) {
      if (policy.approvals === "deny") return refuse("denied", APPROVAL_NOT_GRANTED(call.tool));
      if (policy.approvals === "record_only" || !kind.readOnly) return refuse("would_ask_first", APPROVAL_NOT_GRANTED(call.tool));
    }

    const mock = policy.mocks[call.tool];
    if (policy.tools === "real" || (kind.readOnly && !(policy.tools === "mocked" && mock))) {
      emit({ ...base, policyOutcome: "ran", status: "ok" });
      return { allow: true };
    }
    if (mock) {
      const text = mockText(mock);
      emit({ ...base, policyOutcome: "mocked", status: mock.error !== undefined ? "error" : "ok", result: redactSecrets(text) });
      return { allow: false, reason: text };
    }
    const text = STUB_RESULT(call.tool);
    emit({ ...base, policyOutcome: "stubbed", status: "not_run", result: text });
    return { allow: false, reason: text };
  };

  return {
    policy,
    warning: policy.tools === "real" ? "Tools run for real in this evaluation: they can change files, call services and spend money." : undefined,
    decide,
    observeFinished(call, result) {
      const record = byId.get(call.id);
      if (!record || record.policyOutcome !== "ran") return;
      emit({ ...record, status: result.ok ? "ok" : "error", result: redactSecrets(result.output) });
    },
    recordOf: (callId) => byId.get(callId),
    records: () => [...byId.values()],
  };
}

/** Which eval gate governs which eval session. An eval session with no entry is denied every tool. */
export class EvalGateRegistry {
  private readonly gates = new Map<string, EvalGate>();

  set(sessionId: string, gate: EvalGate): void {
    this.gates.set(sessionId, gate);
  }

  get(sessionId: string): EvalGate | undefined {
    return this.gates.get(sessionId);
  }

  delete(sessionId: string): void {
    this.gates.delete(sessionId);
  }
}
