import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import { healthOf, importModule, receiptFor, withSendTimeout, withSpectrumApp, zodValidator, type SpectrumImporter } from "./kit.js";
import type { ChannelProvider, OutboundMessage, ProviderMeta, SendContext, SendReceipt } from "../types.js";
import { PHOTON_BASE_URL, PHOTON_CREDENTIAL_YAML, PHOTON_FIELDS, credentialsOf, photonData, photonHeaders, type PhotonCredentials } from "./photonImessage.js";

export type WhatsappTemplate = { name: string; languageCode: string; bodyParams?: string[] };
export type WhatsappTarget = { recipient: string; template?: WhatsappTemplate };
export type WhatsappConfig = Record<string, never>;

export const WHATSAPP_META: ProviderMeta = {
  label: "WhatsApp Business",
  blurb: "Not connected · via Photon",
  icon: "phone",
  via: "Photon",
  note: "Enable WhatsApp for the project in the Photon dashboard first. Uses the Spectrum SDK packages (optional dependencies). Stages pin an approved template per recipient.",
  fields: PHOTON_FIELDS,
  recipient: { label: "Recipient", placeholder: "+14155550123", multiple: false, cc: false, template: true },
  envNames: ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"],
  yamlExample: `${PHOTON_CREDENTIAL_YAML}connections:
  - id: orders-whatsapp
    provider: whatsapp
    credential: photon-main
`,
  stageExample: `    to: "+14155550123"
    template:
      name: order_update
      languageCode: en_US
      bodyParams: ["{{message}}"]`,
};

export const MESSAGE_PLACEHOLDER = "{{message}}";
export const MAX_TEMPLATE_PARAM = 1024;

/** One outbound message. `template` is sent as an approved template, otherwise `text` is free-form. */
export type WhatsappOutbound = { text: string } | { template: WhatsappTemplate };

export interface PhotonWhatsappTransport {
  send(credentials: PhotonCredentials, recipient: string, outbound: WhatsappOutbound): Promise<{ messageId?: string }>;
}

const templateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  languageCode: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  bodyParams: z.array(z.string().min(1).max(MAX_TEMPLATE_PARAM)).max(10).optional(),
}).strict();
const targetSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{6,14}$/),
  template: templateSchema.optional(),
}).strict();

const validateConfig = zodValidator(z.object({}).strict(), "config", (): WhatsappConfig => ({}));
const validateTarget = zodValidator(targetSchema, "target", (data): WhatsappTarget => ({
  recipient: data.to,
  ...(data.template ? { template: data.template } : {}),
}));

export type PhotonWhatsappOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  transport?: PhotonWhatsappTransport;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

/** Template parameters cannot hold newlines, tabs or long runs of spaces. */
export function templateParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Fills `{{message}}` in the pinned parameters. Fails before sending if a result is empty or too long. */
export function fillTemplate(template: WhatsappTemplate, message: OutboundMessage, connectionId: string): WhatsappTemplate {
  const text = templateParam(message.subject ? `${message.subject}: ${message.text}` : message.text);
  const bodyParams = template.bodyParams?.map(param => (param.includes(MESSAGE_PLACEHOLDER) ? param.split(MESSAGE_PLACEHOLDER).join(text) : param));
  if (bodyParams?.some(param => param.length === 0 || param.length > MAX_TEMPLATE_PARAM)) {
    throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId, field: "text" });
  }
  return { ...template, ...(bodyParams ? { bodyParams } : {}) };
}

function metaCode(error: unknown): number | undefined {
  const candidates = [(error as { code?: unknown })?.code, (error as { error?: { code?: unknown } })?.error?.code];
  for (const value of candidates) if (typeof value === "number") return value;
  const match = /\b(13\d{4}|190)\b/.exec(error instanceof Error ? error.message : "");
  return match ? Number(match[1]) : undefined;
}

const RECIPIENT_CODES = new Set([131026, 131030, 131021]);
const INVALID_CODES = new Set([132000, 132001, 132005, 132012, 132015, 132016]);
const RATE_CODES = new Set([131056, 130429, 131048]);

/** Maps SDK and Meta errors. Unclassified errors may have happened after the send, so they are unknown. */
export function classifyWhatsappError(error: unknown, connectionId: string): ChannelError {
  if (error instanceof ChannelError) return error;
  const detail = { connectionId };
  const code = metaCode(error);
  if (code === 131047 || code === 131051) return new ChannelError("CHANNEL_WINDOW_CLOSED", false, detail);
  if (code !== undefined && RECIPIENT_CODES.has(code)) return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  if (code !== undefined && INVALID_CODES.has(code)) return new ChannelError("CHANNEL_INVALID_INPUT", false, detail);
  if (code !== undefined && RATE_CODES.has(code)) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  if (code === 190) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (status === 403) return new ChannelError("CHANNEL_UNAUTHORIZED", false, detail);
  if (status === 429) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  return new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail);
}

/** The Spectrum SDK send for WhatsApp, on the same shared lifecycle as iMessage. */
export function spectrumWhatsappTransport(importer: SpectrumImporter = importModule): PhotonWhatsappTransport {
  return {
    send: (credentials, recipient, outbound) => withSpectrumApp(importer, credentials, { pkg: "@spectrum-ts/whatsapp-business", exportName: "whatsappBusiness" }, async ({ platform, module }) => {
      const user = await platform.user(recipient);
      const space = await platform.space.create(user);
      const sent = await space.send("template" in outbound ? module.whatsappTemplate(outbound.template) : outbound.text);
      return typeof sent?.id === "string" ? { messageId: sent.id } : {};
    }),
  };
}

/**
 * WhatsApp Business through a Photon project (cloud mode), 1:1 only. Free-form text works only
 * inside the 24-hour window after the recipient last wrote to the business, so a stage that
 * writes first must pin an approved `template`. Receiving is not part of this phase.
 */
export function createPhotonWhatsappProvider(options: PhotonWhatsappOptions = {}): ChannelProvider<WhatsappConfig, WhatsappTarget> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? PHOTON_BASE_URL;
  const transport = options.transport ?? spectrumWhatsappTransport();
  return {
    id: "whatsapp",
    meta: WHATSAPP_META,
    operations: ["send"],
    secrets: { required: [] },
    credentialProvider: "photon",
    validateConfig,
    validateTarget,
    check: (connection, signal) => healthOf(async () => {
      const credentials = credentialsOf(connection);
      const result = await httpCall({
        fetch: doFetch, url: `${base}/projects/${encodeURIComponent(credentials.projectId)}/whatsapp-business/tokens`, method: "POST",
        headers: photonHeaders(credentials), body: {}, timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      if (result.status < 200 || result.status >= 300) throw statusFailure(result.status, "check", connection.id);
      const auth = photonData(parseJson(result.text))?.auth;
      if (!(auth && typeof auth === "object" && Object.keys(auth).length > 0)) {
        throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id, field: "whatsapp" });
      }
    }),
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const credentials = credentialsOf(connection);
      const outbound: WhatsappOutbound = target.template
        ? { template: fillTemplate(target.template, message, connection.id) }
        : { text: message.subject ? `${message.subject}\n\n${message.text}` : message.text };
      try {
        const sent = await withSendTimeout(options.sendTimeoutMs ?? 45000, connection.id, transport.send(credentials, target.recipient, outbound));
        return receiptFor(sent.messageId);
      } catch (error) {
        throw classifyWhatsappError(error, connection.id);
      }
    },
  };
}
