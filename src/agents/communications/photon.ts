import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentInboundMessage } from "./port.js";

export type PhotonInboundConfig = {
  connectionId: string;
  webhookSecret: string;
};

export type PhotonParseResult =
  | { ok: true; message: AgentInboundMessage }
  | { ok: false; code: "agent.signature_invalid" | "agent.invalid" };

export function verifyPhotonSignature(
  config: PhotonInboundConfig,
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

export function parsePhotonInbound(
  config: PhotonInboundConfig,
  payload: unknown,
): PhotonParseResult {
  if (typeof payload !== "object" || payload === null) return { ok: false, code: "agent.invalid" };
  const record = payload as Record<string, unknown>;
  const eventId = typeof record.id === "string" ? record.id : undefined;
  const threadId =
    typeof record.conversation_id === "string"
      ? record.conversation_id
      : typeof record.sender === "string"
        ? record.sender
        : undefined;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (eventId === undefined || threadId === undefined || text.length === 0) {
    return { ok: false, code: "agent.invalid" };
  }
  return {
    ok: true,
    message: {
      provider: "photon",
      connectionId: config.connectionId,
      eventId: `photon:${eventId}`,
      threadId,
      text,
      ...(typeof record.sender === "string" ? { from: record.sender } : {}),
    },
  };
}
