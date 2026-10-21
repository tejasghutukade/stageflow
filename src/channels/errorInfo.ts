import type { ChannelErrorCode } from "./errors.js";

export type ChannelErrorInfo = {
  /** One sentence for logs, preflight output and the status line. */
  reason: string;
  /** What to do about it, when there is something to do. */
  hint?: string;
  /** HTTP status when the code is returned by the connections API. */
  status: number;
};

/**
 * The one place a channel error code is explained. A `Record` over the code union makes a code
 * without an entry a compile error. Whether a failure is retryable is not here: it depends on
 * the operation (a 5xx is retryable in a check but an unknown outcome in a send), so it stays
 * where the failure is classified.
 */
export const CHANNEL_ERROR_INFO: Record<ChannelErrorCode, ChannelErrorInfo> = {
  CHANNEL_INVALID_INPUT: {
    reason: "The settings are not valid for this provider account",
    hint: "Check the values (for example an unknown inbox or a different workspace) and try again. If the file is hand-edited, fix the entry and restart.",
    status: 400,
  },
  CHANNEL_NOT_FOUND: { reason: "The connection is not defined", status: 404 },
  CHANNEL_DISABLED: { reason: "The connection is disabled", hint: "Enable it, or remove it from the stage.", status: 400 },
  CHANNEL_PROVIDER_UNSUPPORTED: {
    reason: "This provider is not supported here, or its SDK is not installed",
    hint: "iMessage and WhatsApp need the Spectrum SDK packages, which are optional dependencies.",
    status: 400,
  },
  CHANNEL_SECRET_UNAVAILABLE: {
    reason: "A secret for this connection is not set on the host",
    hint: "Set the environment variable each secret names (or its _FILE form) on the host, or use Replace to store one, then check again.",
    status: 500,
  },
  CHANNEL_RESOURCE_LIMIT: { reason: "The request or connections.yaml is too large", status: 413 },
  CHANNEL_STORAGE_FAILED: {
    reason: "Stageflow could not read or write connections.yaml or the secret store on this host",
    hint: "Check that the data directory is writable.",
    status: 500,
  },
  CHANNEL_UNAUTHORIZED: {
    reason: "Credentials were rejected or lack a required permission",
    hint: "The provider refused the credential: it is invalid, or it lacks a permission this provider needs (for AgentMail, reading the inbox and sending). Check the key and its permissions, then try again.",
    status: 500,
  },
  CHANNEL_AUTH_FAILED: {
    reason: "Credentials were rejected",
    hint: "Replace the secret with a valid one, then check again.",
    status: 500,
  },
  CHANNEL_CONNECTION_FAILED: {
    reason: "Could not reach the provider",
    hint: "This is usually temporary. Check the network and try again.",
    status: 500,
  },
  CHANNEL_TIMEOUT: { reason: "The provider did not answer in time", hint: "Try again.", status: 500 },
  CHANNEL_RATE_LIMIT: { reason: "The provider is rate limiting this account", hint: "Wait and try again.", status: 500 },
  CHANNEL_WINDOW_CLOSED: {
    reason: "WhatsApp's 24-hour reply window is closed",
    hint: "Pin an approved template on the stage so it can message first.",
    status: 500,
  },
  CHANNEL_TARGET_INVALID: { reason: "The pinned recipient is not valid for this provider", status: 400 },
  CHANNEL_RECIPIENT_REJECTED: {
    reason: "The provider will not message this recipient",
    hint: "For iMessage on a Free or Pro Photon project, add them as a project user and have them text their assigned line (the \"Texts on\" number) once.",
    status: 500,
  },
  CHANNEL_SEND_OUTCOME_UNKNOWN: {
    reason: "The message may or may not have been sent",
    hint: "Check the provider before sending again. Stageflow never resends it automatically.",
    status: 500,
  },
  CHANNEL_OPERATION_CONFLICT: { reason: "That already exists, or the key was reused with different content", status: 409 },
};

export function channelErrorReason(code: string): string {
  return (CHANNEL_ERROR_INFO as Record<string, ChannelErrorInfo | undefined>)[code]?.reason ?? code;
}

export function channelErrorStatus(code: string): number {
  return (CHANNEL_ERROR_INFO as Record<string, ChannelErrorInfo | undefined>)[code]?.status ?? 500;
}
