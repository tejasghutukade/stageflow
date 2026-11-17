import { timingSafeEqual } from "node:crypto";
import type { AgentInboundMessage } from "./port.js";

export type TelegramInboundConfig = {
  connectionId: string;
  secretToken?: string;
};

export type TelegramParseResult =
  | { ok: true; message: AgentInboundMessage }
  | { ok: true; ignored: true; reason: "not_private_chat" | "no_sender" }
  | { ok: false; code: "agent.signature_invalid" | "agent.invalid" };

export function verifyTelegramSecret(
  config: TelegramInboundConfig,
  headerToken: string | undefined,
): { ok: true } | { ok: false; code: "agent.signature_invalid" } {
  if (config.secretToken === undefined) return { ok: true };
  if (headerToken === undefined) return { ok: false, code: "agent.signature_invalid" };
  const left = Buffer.from(config.secretToken);
  const right = Buffer.from(headerToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, code: "agent.signature_invalid" };
  }
  return { ok: true };
}

export function parseTelegramInbound(
  config: TelegramInboundConfig,
  payload: unknown,
): TelegramParseResult {
  if (typeof payload !== "object" || payload === null) return { ok: false, code: "agent.invalid" };
  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return { ok: false, code: "agent.invalid" };
  const record = message as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text.length === 0) return { ok: false, code: "agent.invalid" };
  const chat = record.chat;
  if (typeof chat !== "object" || chat === null) return { ok: false, code: "agent.invalid" };
  // Only one-to-one chats: in a group the reply would reach people who were never allowed.
  if ((chat as { type?: unknown }).type !== "private") return { ok: true, ignored: true, reason: "not_private_chat" };
  const chatId = (chat as { id?: unknown }).id;
  if (typeof chatId !== "number" && typeof chatId !== "string") {
    return { ok: false, code: "agent.invalid" };
  }
  const messageId = record.message_id;
  if (typeof messageId !== "number" || !Number.isFinite(messageId)) {
    return { ok: false, code: "agent.invalid" };
  }
  const from = typeof record.from === "object" && record.from !== null ? (record.from as { id?: unknown; username?: unknown }) : undefined;
  // The numeric user id never changes; a username can be dropped and taken by someone else.
  if (typeof from?.id !== "number" || !Number.isSafeInteger(from.id)) return { ok: true, ignored: true, reason: "no_sender" };
  const username = typeof from.username === "string" && from.username.length > 0 ? from.username : undefined;
  const threadId = String(chatId);
  return {
    ok: true,
    message: {
      provider: "telegram",
      connectionId: config.connectionId,
      eventId: `telegram:${messageId}:${threadId}`,
      threadId,
      replyTo: threadId,
      text,
      from: String(from.id),
      ...(username !== undefined ? { fromUsername: username } : {}),
    },
  };
}
