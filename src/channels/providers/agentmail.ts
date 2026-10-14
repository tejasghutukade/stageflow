import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import { healthOf, receiptFor, zodValidator } from "./kit.js";
import type { ChannelProvider, OutboundMessage, ProviderMeta, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type AgentMailConfig = { inbox: string; region: "us" | "eu" };
export type AgentMailTarget = { to: string[]; cc?: string[] };

export const AGENTMAIL_BASE_URLS = { us: "https://api.agentmail.to", eu: "https://api.agentmail.eu" } as const;
export const AGENTMAIL_DEFAULT_SUBJECT = "Message from Stageflow";

export const AGENTMAIL_META: ProviderMeta = {
  label: "AgentMail",
  blurb: "Not connected · send email from an inbox",
  icon: "mail",
  fields: [
    { key: "inbox", label: "Inbox address", hint: "An existing AgentMail inbox. Stageflow does not create one.", target: "config", input: "text", required: true, placeholder: "research@agentmail.to" },
    { key: "region", label: "Region", target: "config", input: "select", required: false, defaultValue: "us", options: [{ value: "us", label: "United States" }, { value: "eu", label: "Europe" }] },
    { key: "apiKey", label: "API key", hint: "Needs to read the inbox and send messages.", target: "secret", input: "password", required: true, placeholder: "am_..." },
  ],
  recipient: { label: "To", placeholder: "oncall@acme.com, lead@acme.com", multiple: true, cc: true, template: false },
  envNames: ["AGENTMAIL_API_KEY"],
  yamlExample: `connections:
  - id: support-inbox
    provider: agentmail
    config:
      inbox: support@agentmail.to
    secrets:
      apiKey: env:AGENTMAIL_API_KEY
`,
  stageExample: "    to: [oncall@acme.com]",
};

const address = z.string().min(3).max(320).regex(/^[^\s@<>,;]+@[^\s@<>,;]+$/);
const configSchema = z.object({ inbox: address, region: z.enum(["us", "eu"]).default("us") }).strict();
const targetSchema = z.object({
  to: z.union([address, z.array(address).min(1).max(20)]),
  cc: z.array(address).min(1).max(20).optional(),
}).strict();

const validateConfig = zodValidator(configSchema, "config");
const validateTarget = zodValidator(targetSchema, "target", (data): AgentMailTarget => ({
  to: Array.isArray(data.to) ? data.to : [data.to],
  ...(data.cc !== undefined ? { cc: data.cc } : {}),
}));

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
    meta: AGENTMAIL_META,
    operations: ["send"],
    secrets: { required: ["apiKey"] },
    validateConfig,
    validateTarget,
    describe: config => ({ identity: config.inbox }),
    check: (connection, signal) => healthOf(async () => {
      const result = await httpCall({
        fetch: doFetch, url: inboxUrl(connection), method: "GET", headers: auth(connection),
        timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      if (result.status >= 200 && result.status < 300) return;
      throw result.status === 404 ? new ChannelError("CHANNEL_INVALID_INPUT") : statusFailure(result.status, "check", connection.id);
    }),
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
      return receiptFor(typeof body?.message_id === "string" ? body.message_id : undefined);
    },
  };
}
