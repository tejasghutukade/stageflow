export const HOSTED_ERROR_CODES = [
  "invalid_input",
  "package_invalid",
  "agent_failed",
  "event_sink_failed",
  "cancelled",
  "timed_out",
  "hitl_unsupported",
  "internal",
] as const;

export type HostedErrorCode = (typeof HOSTED_ERROR_CODES)[number];

export type HostedRuntimeErrorDetails = {
  code: HostedErrorCode;
  externalRunId: string;
  externalAttemptId: string;
  runId?: string;
  eventType?: string;
  sequence?: number;
  localResult?: import("./types.js").HostedPipelineResult;
};

export class HostedRuntimeError extends Error {
  readonly code: HostedErrorCode;
  readonly externalRunId: string;
  readonly externalAttemptId: string;
  readonly runId?: string;
  readonly eventType?: string;
  readonly sequence?: number;
  readonly localResult?: import("./types.js").HostedPipelineResult;

  constructor(message: string, details: HostedRuntimeErrorDetails) {
    super(message);
    this.name = "HostedRuntimeError";
    this.code = details.code;
    this.externalRunId = details.externalRunId;
    this.externalAttemptId = details.externalAttemptId;
    this.runId = details.runId;
    this.eventType = details.eventType;
    this.sequence = details.sequence;
    this.localResult = details.localResult;
  }
}
