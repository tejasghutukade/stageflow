import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentInboundMessage } from "./port.js";
import { agentThreadKey } from "./port.js";

export type SlackInboundConfig = {
  connectionId: string;
  signingSecret: string;
};

export type SlackInboundHeaders = {
  signature?: string;
  requestTimestamp?: string;
};

export type SlackParseResult =
  | { ok: true; message: AgentInboundMessage }
  | { ok: true; ignored: true; reason: "bot_message" }
  | { ok: false; code: "agent.signature_invalid" | "agent.invalid" };

export function verifySlackSignature(
  config: SlackInboundConfig,
  headers: SlackInboundHeaders,
  rawBody: string,
  nowMs: number = Date.now(),
): { ok: true } | { ok: false; code: "agent.signature_invalid" } {
  const signature = headers.signature;
  const timestamp = headers.requestTimestamp;
  if (signature === undefined || timestamp === undefined) {
    return { ok: false, code: "agent.signature_invalid" };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > 5 * 60_000) {
    return { ok: false, code: "agent.signature_invalid" };
  }
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", config.signingSecret).update(base).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, code: "agent.signature_invalid" };
  }
  return { ok: true };
}

export function parseSlackInbound(
  config: SlackInboundConfig,
  payload: unknown,
): SlackParseResult {
  if (typeof payload !== "object" || payload === null) return { ok: false, code: "agent.invalid" };
  const event = (payload as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return { ok: false, code: "agent.invalid" };
  const record = event as Record<string, unknown>;
  if (record.bot_id !== undefined || record.subtype === "bot_message") {
    return { ok: true, ignored: true, reason: "bot_message" };
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text.length === 0) return { ok: false, code: "agent.invalid" };
  const channel = typeof record.channel === "string" ? record.channel : undefined;
  const thread =
    typeof record.thread_ts === "string"
      ? record.thread_ts
      : typeof record.ts === "string"
        ? record.ts
        : undefined;
  const eventId =
    typeof record.event_ts === "string"
      ? record.event_ts
      : typeof record.ts === "string"
        ? record.ts
        : undefined;
  if (channel === undefined || thread === undefined || eventId === undefined) {
    return { ok: false, code: "agent.invalid" };
  }
  const user = typeof record.user === "string" ? record.user : undefined;
  return {
    ok: true,
    message: {
      provider: "slack",
      connectionId: config.connectionId,
      eventId: `slack:${eventId}`,
      threadId: thread,
      text,
      replyTo: channel,
      ...(user !== undefined ? { from: user } : {}),
    },
  };
}

export function slackThreadKey(config: SlackInboundConfig, threadId: string): string {
  return agentThreadKey({ provider: "slack", connectionId: config.connectionId, threadId });
}
