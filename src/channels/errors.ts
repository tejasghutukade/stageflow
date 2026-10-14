export type ChannelErrorCode =
  | "CHANNEL_INVALID_INPUT" | "CHANNEL_NOT_FOUND" | "CHANNEL_DISABLED"
  | "CHANNEL_PROVIDER_UNSUPPORTED" | "CHANNEL_SECRET_UNAVAILABLE"
  | "CHANNEL_RESOURCE_LIMIT" | "CHANNEL_STORAGE_FAILED"
  | "CHANNEL_UNAUTHORIZED" | "CHANNEL_AUTH_FAILED" | "CHANNEL_CONNECTION_FAILED"
  | "CHANNEL_TIMEOUT" | "CHANNEL_RATE_LIMIT" | "CHANNEL_WINDOW_CLOSED"
  | "CHANNEL_TARGET_INVALID" | "CHANNEL_RECIPIENT_REJECTED"
  | "CHANNEL_SEND_OUTCOME_UNKNOWN" | "CHANNEL_OPERATION_CONFLICT";

export type ChannelErrorDetail = { connectionId?: string; field?: string };

/** The message is always the code. Detail carries only non-secret identifiers. */
export class ChannelError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    public readonly retryable = false,
    public readonly detail?: ChannelErrorDetail,
  ) {
    super(code);
    this.name = "ChannelError";
  }
}
