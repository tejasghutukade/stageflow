import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentInboundMessage } from "./port.js";

export type AgentMailInboundConfig = {
  connectionId: string;
  webhookSecret: string;
};

export type AgentMailParseResult =
  | { ok: true; message: AgentInboundMessage }
  | { ok: false; code: "agent.signature_invalid" | "agent.invalid" };

export function verifyAgentMailSignature(
  config: AgentMailInboundConfig,
  signatureHeader: string | undefined,
  rawBody: string,
): { ok: true } | { ok: false; code: "agent.signature_invalid" } {
  if (signatureHeader === undefined) return { ok: false, code: "agent.signature_invalid" };
  const expected = createHmac("sha256", config.webhookSecret).update(rawBody).digest("hex");
  const left = Buffer.from(expected);
  const right = Buffer.from(signatureHeader);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, code: "agent.signature_invalid" };
  }
  return { ok: true };
}

export function parseAgentMailInbound(
  config: AgentMailInboundConfig,
  payload: unknown,
): AgentMailParseResult {
  if (typeof payload !== "object" || payload === null) return { ok: false, code: "agent.invalid" };
  const record = payload as Record<string, unknown>;
  const eventId = typeof record.id === "string" ? record.id : undefined;
  const threadId =
    typeof record.thread_id === "string"
      ? record.thread_id
      : typeof record.inbox_id === "string"
        ? record.inbox_id
        : undefined;
  const text =
    typeof record.text === "string"
      ? record.text.trim()
      : typeof record.body === "string"
        ? record.body.trim()
        : "";
  if (eventId === undefined || threadId === undefined || text.length === 0) {
    return { ok: false, code: "agent.invalid" };
  }
  const from = typeof record.from === "string" ? record.from : undefined;
  return {
    ok: true,
    message: {
      provider: "agentmail",
      connectionId: config.connectionId,
      eventId: `agentmail:${eventId}`,
      threadId,
      text,
      ...(from !== undefined ? { from, replyTo: from } : {}),
    },
  };
}
