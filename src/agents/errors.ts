import type { AgentIssue } from "../config/loadAgent.js";

export type AgentErrorCode =
  | "agent.invalid"
  | "agent.not_found"
  | "agent.exists"
  | "agent.archived"
  | "agent.disabled"
  | "agent.conflict"
  | "agent.revision_not_found"
  | "agent.session_not_found"
  | "agent.session_busy"
  | "agent.session_eval_readonly"
  | "agent.ui_function_not_granted"
  | "agent.ui_action_unknown"
  | "agent.ui_args_invalid"
  | "agent.ui_artifact_not_found"
  | "agent.tool_not_granted"
  | "agent.approval_not_required"
  | "agent.approval_not_pending"
  | "agent.approval_expired"
  | "agent.approval_forbidden"
  | "agent.unbound"
  | "agent.sender_not_allowed"
  | "agent.channel_open_with_tools"
  | "agent.outbound_unknown"
  | "agent.trace_metadata_body"
  | "agent.guardrail_blocked"
  | "agent.delegate_not_allowed"
  | "agent.delegate_depth_exceeded"
  | "agent.sandbox_unavailable"
  | "agent.limit_reached"
  | "agent.model_timeout"
  | "agent.backend_unavailable"
  | "agent.approval_denied"
  | "agent.stale_stageflow_tools";

const STATUS: Partial<Record<AgentErrorCode, number>> = {
  "agent.invalid": 422,
  "agent.not_found": 404,
  "agent.revision_not_found": 404,
  "agent.session_not_found": 404,
  "agent.exists": 409,
  "agent.archived": 409,
  "agent.disabled": 409,
  "agent.conflict": 409,
  "agent.session_busy": 409,
  "agent.session_eval_readonly": 403,
  "agent.ui_function_not_granted": 403,
  "agent.ui_action_unknown": 422,
  "agent.ui_args_invalid": 422,
  "agent.ui_artifact_not_found": 404,
  "agent.limit_reached": 409,
  "agent.model_timeout": 504,
  "agent.approval_forbidden": 403,
  "agent.sender_not_allowed": 403,
  "agent.channel_open_with_tools": 409,
};

/** Domain failure with a stable code; the HTTP, CLI and MCP layers map it, they don't parse messages. */
/** Which session limit refused a turn (set on `agent.limit_reached` only). */
export type AgentLimitKind = "turns" | "minutes" | "cost";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message?: string,
    readonly issues: AgentIssue[] = [],
    readonly limit?: AgentLimitKind,
  ) {
    super(message ?? code);
    this.name = "AgentError";
  }

  get httpStatus(): number {
    return STATUS[this.code] ?? 400;
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}
