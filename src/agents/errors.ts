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
  | "agent.tool_not_granted"
  | "agent.approval_not_required"
  | "agent.approval_not_pending"
  | "agent.approval_expired"
  | "agent.approval_forbidden"
  | "agent.unbound"
  | "agent.sender_not_allowed"
  | "agent.outbound_unknown"
  | "agent.trace_metadata_body"
  | "agent.guardrail_blocked"
  | "agent.delegate_not_allowed"
  | "agent.delegate_depth_exceeded"
  | "agent.sandbox_unavailable"
  | "agent.limit_reached"
  | "agent.model_timeout"
  | "agent.backend_unavailable"
  | "agent.approval_denied";

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
  "agent.limit_reached": 409,
  "agent.model_timeout": 504,
  "agent.approval_forbidden": 403,
  "agent.sender_not_allowed": 403,
};

/** Domain failure with a stable code; the HTTP, CLI and MCP layers map it, they don't parse messages. */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message?: string,
    readonly issues: AgentIssue[] = [],
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
