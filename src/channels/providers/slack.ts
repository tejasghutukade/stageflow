import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import { healthOf, receiptFor, zodValidator } from "./kit.js";
import type { HttpMode } from "../http.js";
import type { ChannelProvider, OutboundMessage, ProviderMeta, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type SlackConfig = { teamId?: string };
export type SlackTarget = { channel: string };

export const SLACK_BASE_URL = "https://slack.com/api";

export const SLACK_META: ProviderMeta = {
  label: "Slack",
  blurb: "Not connected · post as a bot",
  icon: "hash",
  fields: [
    { key: "botToken", label: "Bot token", hint: "xoxb-… from your Slack app (OAuth & Permissions). Needs chat:write.", target: "secret", input: "password", required: true, placeholder: "xoxb-..." },
    { key: "teamId", label: "Workspace ID (optional)", hint: "Pins the connection to one workspace, such as T0123ABCD.", target: "config", input: "text", required: false, placeholder: "T0123ABCD" },
  ],
  recipient: { label: "Channel id", placeholder: "C0123ABCD (channel, group, DM or user id)", multiple: false, cc: false, template: false },
  envNames: ["SLACK_BOT_TOKEN"],
  yamlExample: `connections:
  - id: ops-slack
    provider: slack
    secrets:
      botToken: env:SLACK_BOT_TOKEN
`,
  stageExample: "    to: C0123ABCD",
};

const configSchema = z.object({ teamId: z.string().regex(/^T[A-Z0-9]{2,31}$/).optional() }).strict();
const targetSchema = z.object({ to: z.string().regex(/^[CGDU][A-Z0-9]{2,31}$/) }).strict();

const validateConfig = zodValidator(configSchema, "config");
const validateTarget = zodValidator(targetSchema, "target", (data): SlackTarget => ({ channel: data.to }));

export type SlackOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired"]);
const SCOPE_ERRORS = new Set(["missing_scope", "not_allowed_token_type", "no_permission", "restricted_action", "access_denied"]);
const RECIPIENT_ERRORS = new Set([
  "channel_not_found", "user_not_found", "is_archived", "not_in_channel", "cannot_dm_bot", "user_disabled",
  "restricted_action_read_only_channel", "restricted_action_thread_only_channel", "channel_is_archived",
]);
const TRANSIENT_ERRORS = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"]);

/** Maps a Slack `ok: false` error name. Names are mapped, never echoed. */
export function slackFailure(name: unknown, mode: HttpMode, connectionId: string): ChannelError {
  const detail = { connectionId };
  if (typeof name !== "string") return new ChannelError(mode === "send" ? "CHANNEL_SEND_OUTCOME_UNKNOWN" : "CHANNEL_CONNECTION_FAILED", mode !== "send", detail);
  if (AUTH_ERRORS.has(name)) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (SCOPE_ERRORS.has(name)) return new ChannelError("CHANNEL_UNAUTHORIZED", false, detail);
  if (RECIPIENT_ERRORS.has(name)) return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  if (name === "ratelimited" || name === "rate_limited") return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  if (TRANSIENT_ERRORS.has(name)) {
    return mode === "send" ? new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail) : new ChannelError("CHANNEL_CONNECTION_FAILED", true, detail);
  }
  return new ChannelError("CHANNEL_INVALID_INPUT", false, detail);
}

/**
 * Posts as a Slack bot through `chat.postMessage`. The bot needs `chat:write`; posting to a
 * public channel it has not joined also needs `chat:write.public`, and a direct message to a
 * user id needs `im:write`. Receiving is not part of this phase.
 */
export function createSlackProvider(options: SlackOptions = {}): ChannelProvider<SlackConfig, SlackTarget> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? SLACK_BASE_URL;
  const headers = (connection: ResolvedConnection<SlackConfig>): Record<string, string> =>
    ({ authorization: `Bearer ${connection.secrets.botToken}`, accept: "application/json" });

  return {
    id: "slack",
    meta: SLACK_META,
    operations: ["send"],
    secrets: { required: ["botToken"] },
    validateConfig,
    validateTarget,
    describe: config => (config.teamId ? { identity: config.teamId } : {}),
    check: (connection, signal) => healthOf(async () => {
      const result = await httpCall({
        fetch: doFetch, url: `${base}/auth.test`, method: "POST", headers: headers(connection),
        timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      if (result.status < 200 || result.status >= 300) throw statusFailure(result.status, "check", connection.id);
      const body = parseJson(result.text) as { ok?: unknown; error?: unknown; team_id?: unknown } | undefined;
      if (body?.ok !== true) throw slackFailure(body?.error, "check", connection.id);
      if (connection.config.teamId !== undefined && body.team_id !== connection.config.teamId) {
        throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id, field: "teamId" });
      }
    }),
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const text = message.subject ? `*${message.subject}*\n${message.text}` : message.text;
      const result = await httpCall({
        fetch: doFetch, url: `${base}/chat.postMessage`, method: "POST", headers: headers(connection),
        body: { channel: target.channel, text, link_names: false, unfurl_links: false, unfurl_media: false },
        timeoutMs: options.sendTimeoutMs ?? 30000, mode: "send", connectionId: connection.id,
      });
      if (result.status < 200 || result.status >= 300) throw statusFailure(result.status, "send", connection.id);
      const body = parseJson(result.text) as { ok?: unknown; error?: unknown; ts?: unknown } | undefined;
      if (body === undefined) throw new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: connection.id });
      if (body.ok !== true) throw slackFailure(body.error, "send", connection.id);
      return receiptFor(typeof body.ts === "string" ? body.ts : undefined);
    },
  };
}
