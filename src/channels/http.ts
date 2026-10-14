import { ChannelError } from "./errors.js";

export type HttpMode = "check" | "send";

export type HttpCall = {
  fetch: typeof fetch;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  mode: HttpMode;
  connectionId?: string;
};

export type HttpResult = { status: number; text: string };

const NOT_SENT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/**
 * Maps a transport failure. For a send, only failures that happen before the request leaves
 * the machine are definite; everything else may have reached the provider, so it is unknown.
 */
export function networkFailure(error: unknown, mode: HttpMode, timedOut: boolean, connectionId?: string): ChannelError {
  const detail = connectionId ? { connectionId } : undefined;
  if (timedOut) return new ChannelError(mode === "send" ? "CHANNEL_SEND_OUTCOME_UNKNOWN" : "CHANNEL_TIMEOUT", mode !== "send", detail);
  if (mode === "check") return new ChannelError("CHANNEL_CONNECTION_FAILED", true, detail);
  const code = causeCode(error);
  if (code !== undefined && NOT_SENT_CODES.has(code)) return new ChannelError("CHANNEL_CONNECTION_FAILED", true, detail);
  return new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail);
}

/** Maps an HTTP status to a channel error. `retryable` is true only for transient conditions. */
export function statusFailure(status: number, mode: HttpMode, connectionId?: string): ChannelError {
  const detail = connectionId ? { connectionId } : undefined;
  if (status === 401) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (status === 403) return new ChannelError("CHANNEL_UNAUTHORIZED", false, detail);
  if (status === 429) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  if (status >= 500) {
    return mode === "send"
      ? new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail)
      : new ChannelError("CHANNEL_CONNECTION_FAILED", true, detail);
  }
  if (status === 408) return new ChannelError(mode === "send" ? "CHANNEL_SEND_OUTCOME_UNKNOWN" : "CHANNEL_TIMEOUT", mode !== "send", detail);
  return new ChannelError("CHANNEL_INVALID_INPUT", false, detail);
}

/**
 * One bounded HTTP call. Redirects are refused so a credential header never follows a
 * redirect to another host. Response bodies are returned to the provider but never put in
 * an error, so provider messages cannot carry a secret into a log or a tool result.
 */
export async function httpCall(call: HttpCall): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await call.fetch(call.url, {
      method: call.method,
      headers: { ...call.headers, ...(call.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw networkFailure(error, call.mode, timeout.aborted, call.connectionId);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (response.ok && call.mode === "send") return { status: response.status, text: "" };
    throw networkFailure(error, call.mode, timeout.aborted, call.connectionId);
  }
  return { status: response.status, text };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
