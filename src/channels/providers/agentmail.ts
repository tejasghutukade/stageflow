import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import type { ChannelProvider, ConnectionHealth, OutboundMessage, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type AgentMailConfig = { inbox: string; region: "us" | "eu" };
export type AgentMailTarget = { to: string[]; cc?: string[] };

export const AGENTMAIL_BASE_URLS = { us: "https://api.agentmail.to", eu: "https://api.agentmail.eu" } as const;
export const AGENTMAIL_DEFAULT_SUBJECT = "Message from Stageflow";

const address = z.string().min(3).max(320).regex(/^[^\s@<>,;]+@[^\s@<>,;]+$/);
const configSchema = z.object({ inbox: address, region: z.enum(["us", "eu"]).default("us") }).strict();
const targetSchema = z.object({
  to: z.union([address, z.array(address).min(1).max(20)]),
  cc: z.array(address).min(1).max(20).optional(),
}).strict();

export type AgentMailOptions = {
  fetch?: typeof fetch;
  baseUrls?: Partial<Record<"us" | "eu", string>>;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

/**
 * Sends mail from one existing AgentMail inbox through the REST API. Needs a key that can
 * read the inbox and send messages. Receiving is not part of this phase.
 */
export function createAgentMailProvider(options: AgentMailOptions = {}): ChannelProvider<AgentMailConfig, AgentMailTarget> {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = (config: AgentMailConfig): string => options.baseUrls?.[config.region] ?? AGENTMAIL_BASE_URLS[config.region];
  const inboxUrl = (connection: ResolvedConnection<AgentMailConfig>): string =>
    `${baseUrl(connection.config)}/v0/inboxes/${encodeURIComponent(connection.config.inbox)}`;
  const auth = (connection: ResolvedConnection<AgentMailConfig>): Record<string, string> =>
    ({ authorization: `Bearer ${connection.secrets.apiKey}`, accept: "application/json" });

  return {
    id: "agentmail",
    operations: ["send"],
    secrets: { required: ["apiKey"] },
    validateConfig(config) {
      const parsed = configSchema.safeParse(config);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues.map(issue => issue.path.join(".") || "config") };
    },
    validateTarget(target) {
      const parsed = targetSchema.safeParse(target);
      if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(issue => issue.path.join(".") || "target") };
      const to = Array.isArray(parsed.data.to) ? parsed.data.to : [parsed.data.to];
      return { ok: true, value: { to, ...(parsed.data.cc !== undefined ? { cc: parsed.data.cc } : {}) } };
    },
    describe: config => ({ identity: config.inbox }),
    async check(connection, signal): Promise<ConnectionHealth> {
      const checkedAt = new Date().toISOString();
      try {
        const result = await httpCall({
          fetch: doFetch, url: inboxUrl(connection), method: "GET", headers: auth(connection),
          timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
        });
        if (result.status >= 200 && result.status < 300) return { state: "ok", checkedAt };
        const failure = result.status === 404 ? new ChannelError("CHANNEL_INVALID_INPUT") : statusFailure(result.status, "check", connection.id);
        return { state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } };
      } catch (error) {
        const failure = error instanceof ChannelError ? error : new ChannelError("CHANNEL_CONNECTION_FAILED", true);
        return { state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } };
      }
    },
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const result = await httpCall({
        fetch: doFetch, url: `${inboxUrl(connection)}/messages/send`, method: "POST", headers: auth(connection),
        body: {
          to: target.to, ...(target.cc !== undefined ? { cc: target.cc } : {}),
          subject: message.subject ?? AGENTMAIL_DEFAULT_SUBJECT, text: message.text,
        },
        timeoutMs: options.sendTimeoutMs ?? 30000, mode: "send", connectionId: connection.id,
      });
      if (result.status < 200 || result.status >= 300) {
        throw result.status === 404 ? new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id }) : statusFailure(result.status, "send", connection.id);
      }
      const body = parseJson(result.text) as { message_id?: unknown } | undefined;
      const providerMessageId = typeof body?.message_id === "string" ? body.message_id : undefined;
      return {
        ...(providerMessageId !== undefined ? { providerMessageId } : {}),
        submittedAt: new Date().toISOString(),
        ...(providerMessageId === undefined ? { warnings: ["CHANNEL_RESPONSE_UNPARSEABLE"] } : {}),
      };
    },
  };
}
