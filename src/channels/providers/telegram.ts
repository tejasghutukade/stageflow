import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import { healthOf, receiptFor, zodValidator } from "./kit.js";
import type { HttpMode } from "../http.js";
import type { ChannelProvider, OutboundMessage, ProviderMeta, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type TelegramConfig = { botUsername?: string };
export type TelegramTarget = { chatId: string | number };

export const TELEGRAM_BASE_URL = "https://api.telegram.org";
export const TELEGRAM_MAX_TEXT = 4096;

export const TELEGRAM_META: ProviderMeta = {
  label: "Telegram",
  blurb: "Not connected · bot token",
  icon: "send",
  fields: [
    { key: "botToken", label: "Bot token", hint: "From @BotFather. People must start the bot before it can message them.", target: "secret", input: "password", required: true, placeholder: "123456:ABC..." },
    { key: "botUsername", label: "Bot username (optional)", hint: "Fails the check if the token belongs to another bot.", target: "config", input: "text", required: false, placeholder: "acme_alerts_bot" },
    { key: "inboundSecret", label: "Webhook secret (optional)", hint: "Lets agents receive messages from this bot. Use it as secret_token in setWebhook with the URL /api/agent-inbound/<connection id>.", target: "secret", input: "password", required: false },
  ],
  recipient: { label: "Chat id", placeholder: "123456789 or @channelname", multiple: false, cc: false, template: false },
  envNames: ["TELEGRAM_BOT_TOKEN"],
  yamlExample: `connections:
  - id: alerts-telegram
    provider: telegram
    secrets:
      botToken: env:TELEGRAM_BOT_TOKEN
`,
  stageExample: '    to: "123456789"',
};

const configSchema = z.object({ botUsername: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/).optional() }).strict();
const chatId = z.union([
  z.number().int().refine(Number.isSafeInteger),
  z.string().regex(/^-?\d{1,20}$/),
  z.string().regex(/^@[A-Za-z][A-Za-z0-9_]{4,31}$/),
]);
const targetSchema = z.object({ to: chatId }).strict();

const validateConfig = zodValidator(configSchema, "config");
const validateTarget = zodValidator(targetSchema, "target", (data): TelegramTarget => ({ chatId: data.to }));

export type TelegramOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

type TelegramBody = { ok?: unknown; description?: unknown; result?: { message_id?: unknown; username?: unknown } };

/**
 * Telegram mirrors its error in the HTTP status. A bot cannot message a user who has not
 * started it or who blocked it (403), and an unknown chat is a 400. The description is only
 * matched, never echoed.
 */
function telegramFailure(status: number, body: TelegramBody | undefined, mode: HttpMode, connectionId: string): ChannelError {
  const detail = { connectionId };
  const description = typeof body?.description === "string" ? body.description.toLowerCase() : "";
  if (status === 404) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (status === 403 && mode === "send") return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  if (status === 400 && mode === "send" && /chat not found|user not found|peer_id_invalid|chat_id is empty/.test(description)) {
    return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  }
  return statusFailure(status, mode, connectionId);
}

/**
 * Sends through the Telegram Bot API with a bot token. The recipient must have started the
 * bot (or the bot must be a member of the group or channel). Receiving is not part of this phase.
 */
export function createTelegramProvider(options: TelegramOptions = {}): ChannelProvider<TelegramConfig, TelegramTarget> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? TELEGRAM_BASE_URL;
  const url = (connection: ResolvedConnection<TelegramConfig>, method: string): string =>
    `${base}/bot${connection.secrets.botToken}/${method}`;

  return {
    id: "telegram",
    meta: TELEGRAM_META,
    operations: ["send"],
    secrets: { required: ["botToken"], optional: ["inboundSecret"] },
    validateConfig,
    validateTarget,
    describe: config => (config.botUsername ? { identity: `@${config.botUsername}` } : {}),
    check: (connection, signal) => healthOf(async () => {
      const result = await httpCall({
        fetch: doFetch, url: url(connection, "getMe"), method: "GET", headers: { accept: "application/json" },
        timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      const body = parseJson(result.text) as TelegramBody | undefined;
      if (result.status < 200 || result.status >= 300) throw telegramFailure(result.status, body, "check", connection.id);
      if (body?.ok !== true) throw new ChannelError("CHANNEL_CONNECTION_FAILED", true, { connectionId: connection.id });
      const pinned = connection.config.botUsername;
      if (pinned !== undefined && String(body.result?.username).toLowerCase() !== pinned.toLowerCase()) {
        throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id, field: "botUsername" });
      }
    }),
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const text = message.subject ? `${message.subject}\n\n${message.text}` : message.text;
      if (text.length > TELEGRAM_MAX_TEXT) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id, field: "text" });
      const result = await httpCall({
        fetch: doFetch, url: url(connection, "sendMessage"), method: "POST", headers: { accept: "application/json" },
        body: { chat_id: target.chatId, text, link_preview_options: { is_disabled: true } },
        timeoutMs: options.sendTimeoutMs ?? 30000, mode: "send", connectionId: connection.id,
      });
      const body = parseJson(result.text) as TelegramBody | undefined;
      if (result.status < 200 || result.status >= 300) throw telegramFailure(result.status, body, "send", connection.id);
      if (body?.ok !== true) throw new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: connection.id });
      const id = body.result?.message_id;
      return receiptFor(typeof id === "number" ? String(id) : undefined);
    },
  };
}
